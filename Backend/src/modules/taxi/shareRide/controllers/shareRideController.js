import { asyncHandler } from '../../../../utils/asyncHandler.js';
import * as share from '../services/shareRideService.js';

const send = (res, data, message = '', status = 200) => res.status(status).json({ success: true, message, data });
const me = (req) => req.auth.sub;

// ---- rider (/users/share-rides)
export const quote = asyncHandler(async (req, res) => send(res, await share.quoteForRider(req.body)));
export const createRide = asyncHandler(async (req, res) =>
  send(res, await share.createShareRide({ user: req.auth.entity, body: req.body }), 'Looking for a driver', 201));
export const myRides = asyncHandler(async (req, res) =>
  send(res, await share.listRiderRides(me(req), { status: req.query.status })));
export const myRide = asyncHandler(async (req, res) => send(res, await share.getRiderRide(me(req), req.params.id)));
export const cancelMyRide = asyncHandler(async (req, res) =>
  send(res, await share.cancelByRider({ userId: me(req), rideId: req.params.id, reason: req.body?.reason }), 'Ride cancelled'));

// ---- driver (/drivers/share)
export const driverStatus = asyncHandler(async (req, res) => send(res, await share.getDriverShareStatus(me(req))));
export const driverRequests = asyncHandler(async (req, res) => send(res, await share.listRequestsForDriver(me(req))));
export const driverAccept = asyncHandler(async (req, res) =>
  send(res, await share.acceptShareRequest({ driverId: me(req), rideId: req.params.rideId, tripId: req.body?.tripId }), 'Added to your trip'));
export const driverPickup = asyncHandler(async (req, res) =>
  send(res, await share.verifyPickup({ driverId: me(req), rideId: req.params.rideId, otp: req.body?.otp }), 'Rider picked up'));
export const driverComplete = asyncHandler(async (req, res) =>
  send(res, await share.completeShareRide({ driverId: me(req), rideId: req.params.rideId, collectedVia: req.body?.collectedVia }), 'Ride completed'));
export const driverRelease = asyncHandler(async (req, res) =>
  send(res, await share.releaseRider({ driverId: me(req), rideId: req.params.rideId }), 'Rider handed back'));
export const driverTrip = asyncHandler(async (req, res) => send(res, await share.getDriverTrip(me(req))));
export const driverCompleteTrip = asyncHandler(async (req, res) =>
  send(res, await share.completeTrip({ driverId: me(req), tripId: req.params.id }), 'Trip completed'));
export const driverCancelTrip = asyncHandler(async (req, res) =>
  send(res, await share.cancelTrip({ driverId: me(req), tripId: req.params.id }), 'Trip cancelled'));
export const driverEarnings = asyncHandler(async (req, res) =>
  send(res, await share.getDriverShareEarnings(me(req), req.query)));

// ---- owner (/drivers/fleet/share)
export const ownerOverview = asyncHandler(async (req, res) => send(res, await share.ownerOverview(me(req))));
export const ownerTrips = asyncHandler(async (req, res) => send(res, await share.ownerTrips(me(req), req.query)));
export const ownerRides = asyncHandler(async (req, res) => send(res, await share.ownerRides(me(req), req.query)));
export const ownerCreateTrip = asyncHandler(async (req, res) =>
  send(res, await share.ownerCreateTrip({ ownerId: me(req), ...req.body }), 'Trip created', 201));
export const ownerCancelTrip = asyncHandler(async (req, res) =>
  send(res, await share.ownerCancelTrip({ ownerId: me(req), tripId: req.params.id }), 'Trip cancelled'));
export const ownerSetDriver = asyncHandler(async (req, res) =>
  send(res, await share.ownerSetDriverEnabled({ ownerId: me(req), driverId: req.params.driverId, enabled: req.body?.enabled !== false })));

// ---- admin (/admin/share-rides), read-only
export const adminOverview = asyncHandler(async (_req, res) => send(res, await share.adminOverview()));
export const adminTrips = asyncHandler(async (req, res) => send(res, await share.adminTrips(req.query)));
export const adminRides = asyncHandler(async (req, res) => send(res, await share.adminRides(req.query)));
