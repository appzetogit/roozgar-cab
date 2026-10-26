import * as feed from '../services/feedService.js';

const id = (req) => req.auth.sub;
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export const list = async (req, res) => ok(res, await feed.listFeed(id(req), req.query, req.auth.entity.zoneId));
export const mine = async (req, res) => ok(res, await feed.listMine(id(req), req.query));
export const create = async (req, res) => ok(res, await feed.createPost(req.auth.entity, req.body), 201);
export const createVoice = async (req, res) => ok(res, await feed.createVoicePost(req.auth.entity, req.file, req.body), 201);
export const getOne = async (req, res) => ok(res, await feed.getPost(id(req), req.params.id));
export const setStatus = async (req, res) => ok(res, await feed.markUnavailable(id(req), req.params.id, req.body));
export const reschedule = async (req, res) => ok(res, await feed.reschedulePost(id(req), req.params.id, req.body));

export const remove = async (req, res) => {
  await feed.deletePost(id(req), req.params.id);
  res.json({ success: true });
};

export const call = async (req, res) => {
  await feed.trackCall(id(req), req.params.id);
  res.json({ success: true });
};

export const view = async (req, res) => {
  await feed.trackView(id(req), req.params.id);
  res.json({ success: true });
};

export const report = async (req, res) => {
  await feed.reportPost(id(req), req.params.id, req.body);
  res.status(201).json({ success: true, message: "Thanks, we'll review it" });
};

// Admin
export const adminReports = async (req, res) => ok(res, await feed.listReports(req.query));
export const adminReportedPost = async (req, res) => ok(res, await feed.getReportedPost(req.params.id));
export const adminDismiss = async (req, res) => ok(res, await feed.dismissReports(req.params.id));
export const adminRemove = async (req, res) => ok(res, await feed.removePost(req.params.id));
export const adminWarn = async (req, res) => ok(res, await feed.warnDriver(req.params.id, req.body?.message));
export const adminBan = async (req, res) => ok(res, await feed.setFeedBan(req.params.id, req.body?.banned !== false));
