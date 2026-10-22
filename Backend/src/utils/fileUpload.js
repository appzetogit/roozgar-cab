import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

const UPLOAD_ROOT = env.uploads.dir
  ? path.resolve(env.uploads.dir)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');

const DATA_URL_PATTERN = /^data:([^;]+);base64,(.+)$/;

const MAX_UPLOAD_BYTES = Number(env.uploads.maxBytes) || 15 * 1024 * 1024;

const IMAGE_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

const RAW_EXTENSIONS = {
  ...IMAGE_EXTENSIONS,
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
};

const parseDataUrl = (dataUrl, allowedExtensions) => {
  const match = String(dataUrl || '').match(DATA_URL_PATTERN);

  if (!match) {
    throw new ApiError(400, 'A valid base64 data URL is required');
  }

  const mimeType = match[1].toLowerCase().trim();
  const extension = allowedExtensions[mimeType];

  if (!extension) {
    throw new ApiError(400, `Unsupported file type: ${mimeType}`);
  }

  const buffer = Buffer.from(match[2], 'base64');

  if (!buffer.length) {
    throw new ApiError(400, 'Uploaded file is empty');
  }

  if (buffer.length > MAX_UPLOAD_BYTES) {
    const limitMb = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));
    throw new ApiError(413, `File is larger than the ${limitMb}MB limit`);
  }

  return { mimeType, extension, buffer };
};

export const safeSegment = (value, fallback = '') =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 80) || fallback;

export const safeFolder = (value) =>
  String(value ?? '')
    .split('/')
    .map((segment) => safeSegment(segment))
    .filter(Boolean)
    .slice(0, 6)
    .join('/');

const writeUpload = async ({ buffer, extension, folder, publicIdPrefix, publicIdSuffix }) => {
  const cleanFolder = safeFolder(folder) || safeFolder(env.uploads.folder) || 'uploads';
  const prefix = safeSegment(publicIdPrefix, 'file');
  const suffix = safeSegment(publicIdSuffix);

  const name = [prefix, Date.now(), crypto.randomBytes(6).toString('hex'), suffix]
    .filter(Boolean)
    .join('-');

  let finalBuffer = buffer;
  let finalExtension = extension;

  // Convert raster images to compressed WebP automatically for fast delivery
  if (['jpg', 'jpeg', 'png', 'heic', 'heif'].includes(extension)) {
    try {
      finalBuffer = await sharp(buffer)
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
      finalExtension = 'webp';
    } catch (e) {
      finalBuffer = buffer;
      finalExtension = extension;
    }
  }

  const relativePath = `${cleanFolder}/${name}.${finalExtension}`;
  const absolutePath = path.resolve(UPLOAD_ROOT, relativePath);

  if (absolutePath !== UPLOAD_ROOT && !absolutePath.startsWith(UPLOAD_ROOT + path.sep)) {
    throw new ApiError(400, 'Invalid upload path');
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, finalBuffer);

  const base = String(env.publicBackendUrl || '').replace(/\/+$/, '');
  const urlPath = `/uploads/${relativePath}`;

  return {
    secureUrl: base ? `${base}${urlPath}` : urlPath,
    publicId: `${cleanFolder}/${name}`,
    format: finalExtension,
    bytes: finalBuffer.length,
    storedPath: absolutePath,
  };
};

// A value that is already one of this server's uploads (a path or our own
// public URL). Handlers receive these when the request-level middleware has
// already moved an inline image to disk, so they must not fail on it.
const ownUploadReference = (value) => {
  const text = String(value || '').trim();
  const base = String(env.publicBackendUrl || '').replace(/\/+$/, '');

  if (!text || text.includes('..')) return null;

  const path_ = text.startsWith('/uploads/')
    ? text
    : base && text.startsWith(`${base}/uploads/`)
      ? text.slice(base.length)
      : null;

  return path_ ? { secureUrl: text, publicId: path_.replace(/^\/uploads\//, '').replace(/\.[a-z0-9]+$/i, '') } : null;
};

export const uploadDataUrl = async ({
  dataUrl,
  folder = env.uploads.folder,
  publicIdPrefix = 'driver-document',
  publicIdSuffix = '',
}) => {
  const existing = ownUploadReference(dataUrl);
  if (existing) {
    return { ...existing, format: '', bytes: 0, storedPath: '', resourceType: 'image' };
  }

  const { extension, buffer } = parseDataUrl(dataUrl, IMAGE_EXTENSIONS);

  return {
    ...(await writeUpload({ buffer, extension, folder, publicIdPrefix, publicIdSuffix })),
    resourceType: 'image',
  };
};

export const uploadRawFile = async ({
  dataUrl,
  folder = env.uploads.folder,
  publicIdPrefix = 'career-resume',
  publicIdSuffix = '',
}) => {
  const existing = ownUploadReference(dataUrl);
  if (existing) {
    return { ...existing, format: '', bytes: 0, storedPath: '', resourceType: 'raw' };
  }

  const { mimeType, extension, buffer } = parseDataUrl(dataUrl, RAW_EXTENSIONS);

  return {
    ...(await writeUpload({ buffer, extension, folder, publicIdPrefix, publicIdSuffix })),
    resourceType: mimeType.startsWith('image/') ? 'image' : 'raw',
  };
};

const INLINE_IMAGE = /^data:image\/(jpeg|jpg|png|webp|gif|heic|heif);base64,/i;
const MAX_WALK_DEPTH = 8;

// Replace every inline base64 image found anywhere in `value` (nested objects
// and arrays) with a file on disk and its /uploads URL, so the database holds
// links instead of megabytes of base64. Anything that is not a plain raster
// image data URL (svg icons, normal strings) is left untouched, and an image
// that cannot be stored is left as it was rather than failing the request.
export const externalizeInlineImages = async (value, { folder = env.uploads.folder } = {}, depth = 0) => {
  if (typeof value === 'string') {
    if (value.length < 200 || !INLINE_IMAGE.test(value)) return value;
    try {
      const stored = await uploadDataUrl({ dataUrl: value, folder, publicIdPrefix: 'image' });
      return stored.secureUrl;
    } catch {
      return value;
    }
  }

  if (!value || typeof value !== 'object' || depth >= MAX_WALK_DEPTH) return value;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = await externalizeInlineImages(value[i], { folder }, depth + 1);
    }
    return value;
  }

  for (const key of Object.keys(value)) {
    value[key] = await externalizeInlineImages(value[key], { folder }, depth + 1);
  }
  return value;
};
