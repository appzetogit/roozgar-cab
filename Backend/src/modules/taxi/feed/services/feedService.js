import { env } from '../../../../config/env.js';
import { ApiError } from '../../../../utils/ApiError.js';
import { deleteUploadByUrl, uploadBuffer } from '../../../../utils/fileUpload.js';
import { Driver } from '../../driver/models/Driver.js';
import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';
import { RidePost, RidePostEngagement, RidePostReport } from '../models/RidePost.js';

const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 86400e3;
const IST_OFFSET = 5.5 * HOUR;
const MIN_LEAD = 5 * MIN;
const MAX_LEAD = 60 * DAY;
const MAX_ACTIVE_POSTS = 10;
const MAX_CREATES_PER_DAY = 20;
const MAX_RESCHEDULES = 3;
const REPORTS_TO_REVIEW = 3;
export const OUTSTATION_RULE = { minKm: 40, fallbackMinPrice: 1000 };

const fail = (status, message, code) => Object.assign(new ApiError(status, message), { code });
// profileImage may hold a relative /uploads path; the app needs a full URL.
const absoluteUrl = (value) =>
  value && value.startsWith('/') ? `${String(env.publicBackendUrl || '').replace(/\/+$/, '')}${value}` : value || null;
const dropAudio = (rows) => Promise.all(rows.map((row) => deleteUploadByUrl(row.audioUrl)));
const oid = (value) => String(value?._id ?? value);

// Start of the IST calendar day containing `date`, as a UTC instant.
const istDayStart = (date = new Date()) =>
  new Date(Math.floor((date.getTime() + IST_OFFSET) / DAY) * DAY - IST_OFFSET);

const kmBetween = ([lng1, lat1], [lng2, lat2]) => {
  const rad = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
};

const toPoint = (value, name) => {
  if (value === undefined || value === null) return undefined;
  const c = Array.isArray(value) ? value : value.coordinates;
  const [lng, lat] = Array.isArray(c) ? c.map(Number) : [];
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw fail(422, `${name} is invalid`, 'VALIDATION');
  }
  return { type: 'Point', coordinates: [lng, lat] };
};

const parseFutureDate = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw fail(422, 'dateTime is required', 'VALIDATION');
  const lead = date.getTime() - Date.now();
  if (lead < MIN_LEAD) throw fail(422, 'Pickup time must be at least 5 minutes from now', 'VALIDATION');
  if (lead > MAX_LEAD) throw fail(422, 'Pickup time can be at most 60 days ahead', 'VALIDATION');
  return date;
};

const text = (value, name, max) => {
  const out = String(value ?? '').trim();
  if (!out) throw fail(422, `${name} is required`, 'VALIDATION');
  if (out.length > max) throw fail(422, `${name} must be at most ${max} characters`, 'VALIDATION');
  return out;
};

export const serializePost = (post, viewerId) => {
  const isMine = oid(post.postedBy) === String(viewerId);
  const out = {
    id: oid(post),
    postedBy: { id: oid(post.postedBy) },
    ownerName: post.ownerName,
    ownerAvatarUrl: absoluteUrl(post.ownerAvatarUrl),
    isMine,
    pickup: post.pickup,
    drop: post.drop,
    pickupLocation: post.pickupLocation || null,
    dropLocation: post.dropLocation || null,
    price: post.price,
    dateTime: post.dateTime,
    passengers: post.passengers,
    note: post.note || '',
    audioUrl: absoluteUrl(post.audioUrl),
    audioDurationSec: post.audioDurationSec || 0,
    phone: post.phone,
    status: post.status,
    unavailableReason: post.unavailableReason || null,
    rescheduleCount: post.rescheduleCount,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
  // Counters are the owner's business only.
  if (isMine) Object.assign(out, { views: post.views, calls: post.calls, reportCount: post.reportCount });
  return out;
};

const pageOf = (query) => {
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 20));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { page, limit, skip: (page - 1) * limit };
};

const pagination = (total, { page, limit }) => ({ page, limit, total, hasMore: page * limit < total });

export const listFeed = async (driverId, query = {}) => {
  const now = new Date();
  const filter = {
    postedBy: { $ne: driverId },
    status: 'active',
    dateTime: { $gt: now }, // no grace, even if the overdue job is late
  };

  // A driver's own report hides the post for them straight away.
  const reported = await RidePostReport.distinct('postId', { reporterId: driverId });
  if (reported.length) filter._id = { $nin: reported };

  const day = String(query.filter || 'all').toLowerCase();
  if (day === 'today' || day === 'tomorrow') {
    const start = new Date(istDayStart(now).getTime() + (day === 'tomorrow' ? DAY : 0));
    filter.dateTime = { $gt: start > now ? start : now, $lt: new Date(start.getTime() + DAY) };
  } else if (day === 'outstation') {
    // Voice posts have neither distance nor a fare, so they never match here.
    filter.$or = [
      { distanceKm: { $gte: OUTSTATION_RULE.minKm } },
      { distanceKm: null, price: { $gte: OUTSTATION_RULE.fallbackMinPrice } },
    ];
  }

  if (query.passengers !== undefined && query.passengers !== '') {
    const count = Number(query.passengers);
    if (!Number.isInteger(count) || count < 1 || count > 6) {
      throw fail(422, 'passengers must be 1-6', 'VALIDATION');
    }
    filter.passengers = count;
  }

  const paging = pageOf(query);
  const [rows, total] = await Promise.all([
    RidePost.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit).lean(),
    RidePost.countDocuments(filter),
  ]);

  return {
    results: rows.map((row) => serializePost(row, driverId)),
    pagination: pagination(total, paging),
    outstationRule: OUTSTATION_RULE,
  };
};

const assertPostingAllowed = (driver) => {
  if (driver.feedBanned) throw fail(403, 'You cannot post rides right now', 'FEED_BANNED');
  if (!driver.phone) throw fail(422, 'A verified phone number is required to post', 'NO_PHONE');
};

const assertUnderPostLimits = async (driverId) => {
  const [open, today] = await Promise.all([
    RidePost.countDocuments({ postedBy: driverId, status: { $in: ['active', 'needs_update'] } }),
    RidePost.countDocuments({ postedBy: driverId, createdAt: { $gte: istDayStart() } }),
  ]);
  if (open >= MAX_ACTIVE_POSTS) throw fail(429, `You already have ${MAX_ACTIVE_POSTS} active posts`, 'ACTIVE_LIMIT');
  if (today >= MAX_CREATES_PER_DAY) {
    throw fail(429, `You can post at most ${MAX_CREATES_PER_DAY} rides a day`, 'DAILY_LIMIT');
  }
};

export const createPost = async (driver, body = {}) => {
  const driverId = driver._id;
  assertPostingAllowed(driver);

  const pickup = text(body.pickup, 'Pickup', 200);
  const drop = text(body.drop, 'Drop', 200);
  const price = Number(body.price);
  if (!Number.isInteger(price) || price <= 0 || price > 100000) {
    throw fail(422, 'Fare must be a whole number between 1 and 100000', 'VALIDATION');
  }
  const passengers = Number(body.passengers);
  if (!Number.isInteger(passengers) || passengers < 1 || passengers > 6) {
    throw fail(422, 'Passengers must be between 1 and 6', 'VALIDATION');
  }
  const note = String(body.note ?? '').trim();
  if (note.length > 150) throw fail(422, 'Note must be at most 150 characters', 'VALIDATION');
  const dateTime = parseFutureDate(body.dateTime);
  const pickupLocation = toPoint(body.pickupLocation, 'pickupLocation');
  const dropLocation = toPoint(body.dropLocation, 'dropLocation');
  const distanceKm =
    pickupLocation && dropLocation
      ? Math.round(kmBetween(pickupLocation.coordinates, dropLocation.coordinates) * 10) / 10
      : null;

  await assertUnderPostLimits(driverId);

  const post = await RidePost.create({
    postedBy: driverId,
    zoneId: driver.zoneId || null,
    ownerName: driver.name || 'Driver',
    ownerAvatarUrl: driver.profileImage || null,
    phone: driver.phone,
    pickup,
    drop,
    pickupLocation,
    dropLocation,
    distanceKm,
    price,
    dateTime,
    passengers,
    note,
  });

  return serializePost(post.toObject(), driverId);
};

const AUDIO_MAX_BYTES = 2 * 1024 * 1024;

// The mime type comes from the client, so the file's own header decides.
const audioExtension = (file) => {
  const mime = String(file?.mimetype || '').toLowerCase();
  const head = file?.buffer;
  if (!head?.length || !(mime.startsWith('audio/') || mime === 'application/octet-stream')) {
    throw fail(422, 'An audio recording is required', 'VALIDATION');
  }
  if (head.length > AUDIO_MAX_BYTES) throw fail(413, 'Recording is larger than 2 MB', 'FILE_TOO_LARGE');
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return 'aac'; // ADTS frame sync
  throw fail(422, 'The recording is not a valid audio file', 'VALIDATION');
};

// shortcut: durationSec is the client's word, not read from the file; the 2 MB cap bounds the abuse.
export const createVoicePost = async (driver, file, body = {}) => {
  const driverId = driver._id;
  assertPostingAllowed(driver);

  const durationSec = Number(body.durationSec);
  if (!Number.isInteger(durationSec) || durationSec < 3 || durationSec > 300) {
    throw fail(422, 'Recording must be between 3 seconds and 5 minutes', 'VALIDATION');
  }
  const dateTime = parseFutureDate(body.dateTime);
  const extension = audioExtension(file);
  await assertUnderPostLimits(driverId);

  const stored = await uploadBuffer({
    buffer: file.buffer,
    extension,
    folder: `${env.uploads.folder}/feed-audio`,
    publicIdPrefix: 'voice',
  });

  try {
    const post = await RidePost.create({
      postedBy: driverId,
      zoneId: driver.zoneId || null,
      ownerName: driver.name || 'Driver',
      ownerAvatarUrl: driver.profileImage || null,
      phone: driver.phone,
      pickup: '',
      drop: '',
      price: 0,
      passengers: 1,
      dateTime,
      audioUrl: stored.secureUrl,
      audioDurationSec: durationSec,
    });
    return serializePost(post.toObject(), driverId);
  } catch (error) {
    await deleteUploadByUrl(stored.secureUrl);
    throw error;
  }
};

export const listMine = async (driverId, query = {}) => {
  const tabStatuses = {
    active: ['active', 'needs_update'],
    unavailable: ['unavailable', 'expired', 'under_review'],
  };
  const tab = query.tab === 'unavailable' ? 'unavailable' : 'active';
  const paging = pageOf(query);
  const filter = { postedBy: driverId, status: { $in: tabStatuses[tab] } };

  const [rows, total, active, unavailable, needsUpdate] = await Promise.all([
    RidePost.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit).lean(),
    RidePost.countDocuments(filter),
    RidePost.countDocuments({ postedBy: driverId, status: { $in: tabStatuses.active } }),
    RidePost.countDocuments({ postedBy: driverId, status: { $in: tabStatuses.unavailable } }),
    RidePost.countDocuments({ postedBy: driverId, status: 'needs_update' }),
  ]);

  return {
    results: rows.map((row) => serializePost(row, driverId)),
    pagination: pagination(total, paging),
    counts: { active, unavailable, needsUpdate },
  };
};

const loadOwned = async (postId, driverId) => {
  const post = await RidePost.findById(postId).catch(() => null);
  if (!post || post.status === 'removed') throw fail(404, 'Post not found', 'NOT_FOUND');
  if (oid(post.postedBy) !== String(driverId)) throw fail(403, 'This is not your post', 'FORBIDDEN');
  return post;
};

export const markUnavailable = async (driverId, postId, { status, reason } = {}) => {
  if (status !== 'unavailable') {
    throw fail(409, 'A post cannot be made active again; post a new ride', 'CANNOT_REACTIVATE');
  }
  if (reason && !['given_to_other_driver', 'cancelled', 'other'].includes(reason)) {
    throw fail(422, 'Invalid reason', 'VALIDATION');
  }
  await loadOwned(postId, driverId);

  const post = await RidePost.findOneAndUpdate(
    { _id: postId, status: { $in: ['active', 'needs_update'] } },
    { $set: { status: 'unavailable', unavailableReason: reason || null } },
    { returnDocument: 'after' },
  ).lean();
  if (!post) throw fail(409, 'This post can no longer be changed', 'INVALID_STATE');
  return serializePost(post, driverId);
};

export const reschedulePost = async (driverId, postId, { dateTime } = {}) => {
  const date = parseFutureDate(dateTime);
  const existing = await loadOwned(postId, driverId);
  if (existing.rescheduleCount >= MAX_RESCHEDULES) {
    throw fail(409, 'You have used all 3 pickup time changes', 'RESCHEDULE_LIMIT');
  }

  // Limit repeated in the filter so two racing requests cannot exceed it.
  const post = await RidePost.findOneAndUpdate(
    { _id: postId, status: { $in: ['active', 'needs_update'] }, rescheduleCount: { $lt: MAX_RESCHEDULES } },
    { $set: { status: 'active', dateTime: date }, $inc: { rescheduleCount: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!post) throw fail(409, 'This post can no longer be changed', 'INVALID_STATE');
  return serializePost(post, driverId);
};

export const deletePost = async (driverId, postId) => {
  const post = await loadOwned(postId, driverId);
  await RidePost.updateOne({ _id: postId }, { $set: { status: 'removed' } });
  await deleteUploadByUrl(post.audioUrl);
};

// A post another driver can see right now; anything else behaves as missing.
const loadVisibleToOthers = async (postId, driverId) => {
  const post = await RidePost.findOne({ _id: postId, status: 'active', dateTime: { $gt: new Date() } })
    .lean()
    .catch(() => null);
  if (!post) throw fail(404, 'Post not found', 'NOT_FOUND');
  if (oid(post.postedBy) === String(driverId)) throw fail(409, 'This is your own post', 'OWN_POST');
  return post;
};

export const getPost = async (driverId, postId) => {
  const post = await RidePost.findById(postId).lean().catch(() => null);
  const mine = post && oid(post.postedBy) === String(driverId);
  const visible = post && post.status === 'active' && post.dateTime > new Date();
  if (!post || post.status === 'removed' || !(mine || visible)) throw fail(404, 'Post not found', 'NOT_FOUND');
  if (!mine && (await RidePostReport.exists({ postId: post._id, reporterId: driverId }))) {
    throw fail(404, 'Post not found', 'NOT_FOUND');
  }
  return serializePost(post, driverId);
};

const isDuplicateKey = (error) => error?.code === 11000;

export const trackView = async (driverId, postId) => {
  const post = await loadVisibleToOthers(postId, driverId);
  try {
    await RidePostEngagement.create({ postId: post._id, driverId, kind: 'view' });
  } catch (error) {
    if (isDuplicateKey(error)) return;
    throw error;
  }
  await RidePost.updateOne({ _id: post._id }, { $inc: { views: 1 } });
};

export const trackCall = async (driverId, postId) => {
  const post = await loadVisibleToOthers(postId, driverId);
  const key = { postId: post._id, driverId, kind: 'call' };

  // Counted again only when the last counted call is over an hour old.
  const renewed = await RidePostEngagement.updateOne(
    { ...key, at: { $lt: new Date(Date.now() - HOUR) } },
    { $set: { at: new Date() } },
  );
  let counted = renewed.modifiedCount > 0;

  if (!counted) {
    try {
      await RidePostEngagement.create(key);
      counted = true;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }
  if (counted) await RidePost.updateOne({ _id: post._id }, { $inc: { calls: 1 } });
};

export const reportPost = async (driverId, postId, { reason, note } = {}) => {
  if (!['fake_ride', 'wrong_number', 'spam', 'abusive', 'other'].includes(reason)) {
    throw fail(422, 'Choose a valid reason', 'VALIDATION');
  }
  let cleanNote = '';
  if (reason === 'other') {
    cleanNote = String(note ?? '').trim();
    if (!cleanNote) throw fail(422, 'Please write the reason', 'VALIDATION');
    if (cleanNote.length > 200) throw fail(422, 'Reason must be at most 200 characters', 'VALIDATION');
  }

  const post = await loadVisibleToOthers(postId, driverId);

  try {
    await RidePostReport.create({
      postId: post._id,
      reporterId: driverId,
      postOwnerId: post.postedBy,
      reason,
      note: cleanNote,
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw fail(409, 'You already reported this post', 'ALREADY_REPORTED');
    throw error;
  }

  const updated = await RidePost.findOneAndUpdate(
    { _id: post._id },
    { $inc: { reportCount: 1 } },
    { returnDocument: 'after' },
  ).lean();

  if (updated.reportCount >= REPORTS_TO_REVIEW) {
    await RidePost.updateOne(
      { _id: post._id, status: { $in: ['active', 'needs_update'] } },
      { $set: { status: 'under_review' } },
    );
  }
};

/* ---------------- overdue lifecycle (runs every minute) ---------------- */

export const sweepOverduePosts = async () => {
  const now = new Date();

  const due = await RidePost.find({ status: 'active', dateTime: { $lte: now } })
    .select('_id postedBy drop')
    .limit(500)
    .lean();

  for (const row of due) {
    // The status flip is the claim, so only one server instance sends the push.
    const claim = await RidePost.updateOne(
      { _id: row._id, status: 'active', dateTime: { $lte: now } },
      { $set: { status: 'needs_update' } },
    );
    if (!claim.modifiedCount) continue;

    await sendPushNotificationToEntities({
      driverIds: [oid(row.postedBy)],
      title: 'Is your ride still available?',
      body: `Is your ride to ${row.drop} still available? Tap to update.`,
      data: { type: 'feed_overdue', postId: oid(row) },
    }).catch((error) => console.error('Feed overdue push failed', row._id, error.message));
  }

  const stale = { status: 'needs_update', dateTime: { $lte: new Date(now.getTime() - DAY) } };
  const withAudio = await RidePost.find({ ...stale, audioUrl: { $ne: null } }).select('_id').lean();
  await RidePost.updateMany(stale, { $set: { status: 'expired' } });

  // A reschedule can land between the two queries; only free audio that really expired.
  if (withAudio.length) {
    await dropAudio(
      await RidePost.find({ _id: { $in: withAudio.map((row) => row._id) }, status: 'expired' })
        .select('audioUrl')
        .lean(),
    );
  }
};

/* ---------------- admin ---------------- */

export const listReports = async (query = {}) => {
  const filter = {};
  if (['pending', 'reviewed'].includes(query.status)) filter.status = query.status;
  if (query.reason) filter.reason = String(query.reason);
  if (query.ownerId) filter.postOwnerId = String(query.ownerId);

  const paging = pageOf(query);
  const [results, total] = await Promise.all([
    RidePostReport.find(filter)
      .sort({ createdAt: -1 })
      .skip(paging.skip)
      .limit(paging.limit)
      .populate('postId', 'pickup drop status reportCount dateTime')
      .populate('reporterId', 'name phone')
      .populate('postOwnerId', 'name phone feedBanned feedWarnings')
      .lean(),
    RidePostReport.countDocuments(filter),
  ]);

  return { results, pagination: pagination(total, paging) };
};

export const getReportedPost = async (postId) => {
  const post = await RidePost.findById(postId).lean().catch(() => null);
  if (!post) throw fail(404, 'Post not found', 'NOT_FOUND');

  const [reports, ownerHistory, owner] = await Promise.all([
    RidePostReport.find({ postId }).sort({ createdAt: -1 }).populate('reporterId', 'name phone').lean(),
    RidePostReport.find({ postOwnerId: post.postedBy, postId: { $ne: postId } })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
    Driver.findById(post.postedBy).select('name phone feedBanned feedWarnings').lean(),
  ]);

  return { post, owner, reports, ownerHistory };
};

const closeReports = (postId, action) =>
  RidePostReport.updateMany(
    { postId, status: 'pending' },
    { $set: { status: 'reviewed', action, reviewedAt: new Date() } },
  );

export const dismissReports = async (postId) => {
  const post = await RidePost.findById(postId);
  if (!post) throw fail(404, 'Post not found', 'NOT_FOUND');

  await closeReports(postId, 'dismissed');
  if (post.status === 'under_review') {
    post.status = post.dateTime > new Date() ? 'active' : 'needs_update';
    await post.save();
  }
  return post.toObject();
};

export const removePost = async (postId) => {
  const post = await RidePost.findByIdAndUpdate(postId, { $set: { status: 'removed' } }, { returnDocument: 'after' }).lean();
  if (!post) throw fail(404, 'Post not found', 'NOT_FOUND');
  await closeReports(postId, 'removed');
  await deleteUploadByUrl(post.audioUrl);
  return post;
};

export const warnDriver = async (driverId, message) => {
  const driver = await Driver.findByIdAndUpdate(driverId, { $inc: { feedWarnings: 1 } }, { returnDocument: 'after' }).lean();
  if (!driver) throw fail(404, 'Driver not found', 'NOT_FOUND');

  await sendPushNotificationToEntities({
    driverIds: [String(driverId)],
    title: 'Warning about your ride posts',
    body: String(message || 'Your ride post was reported. Please follow the posting rules.').slice(0, 200),
    data: { type: 'feed_warning' },
  }).catch(() => null);

  return { feedWarnings: driver.feedWarnings };
};

export const setFeedBan = async (driverId, banned) => {
  const driver = await Driver.findByIdAndUpdate(driverId, { $set: { feedBanned: Boolean(banned) } }, { returnDocument: 'after' }).lean();
  if (!driver) throw fail(404, 'Driver not found', 'NOT_FOUND');

  // shortcut: banned posts are removed for good; an unban does not bring them back.
  if (banned) {
    const live = { postedBy: driverId, status: { $in: ['active', 'needs_update', 'under_review'] } };
    const withAudio = await RidePost.find({ ...live, audioUrl: { $ne: null } }).select('audioUrl').lean();
    await RidePost.updateMany(live, { $set: { status: 'removed' } });
    await dropAudio(withAudio);
  }
  return { feedBanned: driver.feedBanned };
};
