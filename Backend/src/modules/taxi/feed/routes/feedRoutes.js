import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { ApiError } from '../../../../utils/ApiError.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import * as c from '../controllers/feedController.js';

export const feedRouter = Router();

// authenticate(['driver']) already rejects drivers still pending approval.
const notBanned = (req, _res, next) =>
  next(
    req.auth.entity.feedBanned
      ? Object.assign(new ApiError(403, 'You cannot use the ride feed right now'), { code: 'FEED_BANNED' })
      : undefined,
  );
const driverOnly = [authenticate(['driver']), notBanned];

feedRouter.get('/feed/posts', driverOnly, asyncHandler(c.list));
feedRouter.post('/feed/posts', driverOnly, asyncHandler(c.create));
// Declared before /:id so "mine" is not read as an id.
feedRouter.get('/feed/posts/mine', driverOnly, asyncHandler(c.mine));
feedRouter.get('/feed/posts/:id', driverOnly, asyncHandler(c.getOne));
feedRouter.patch('/feed/posts/:id/status', driverOnly, asyncHandler(c.setStatus));
feedRouter.post('/feed/posts/:id/reschedule', driverOnly, asyncHandler(c.reschedule));
feedRouter.delete('/feed/posts/:id', driverOnly, asyncHandler(c.remove));
feedRouter.post('/feed/posts/:id/call', driverOnly, asyncHandler(c.call));
feedRouter.post('/feed/posts/:id/view', driverOnly, asyncHandler(c.view));
feedRouter.post('/feed/posts/:id/report', driverOnly, asyncHandler(c.report));

const admin = authenticate(['admin']);
feedRouter.get('/admin/feed/reports', admin, asyncHandler(c.adminReports));
feedRouter.get('/admin/feed/posts/:id', admin, asyncHandler(c.adminReportedPost));
feedRouter.post('/admin/feed/posts/:id/dismiss', admin, asyncHandler(c.adminDismiss));
feedRouter.post('/admin/feed/posts/:id/remove', admin, asyncHandler(c.adminRemove));
feedRouter.post('/admin/feed/drivers/:id/warn', admin, asyncHandler(c.adminWarn));
feedRouter.post('/admin/feed/drivers/:id/ban', admin, asyncHandler(c.adminBan));
