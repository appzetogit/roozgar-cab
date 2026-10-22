import { env } from '../../../config/env.js';
import { externalizeInlineImages } from '../../../utils/fileUpload.js';
import { verifyAccessToken } from '../services/tokenService.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const hasValidToken = (req) => {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return false;
  try {
    verifyAccessToken(header.slice(7).trim());
    return true;
  } catch {
    return false;
  }
};

// Any inline base64 image in a signed-in request body is written to the uploads
// folder and replaced by its URL before the route handler runs. That covers
// every place an image can be added (admin pages, driver and rider screens)
// without each controller having to remember to upload. Only requests carrying a
// valid token are converted, so anonymous callers cannot use this to fill the disk.
export const storeInlineImages = async (req, _res, next) => {
  try {
    if (WRITE_METHODS.has(req.method) && req.body && typeof req.body === 'object' && hasValidToken(req)) {
      await externalizeInlineImages(req.body, { folder: `${env.uploads.folder}/media` });
    }
    next();
  } catch (error) {
    next(error);
  }
};
