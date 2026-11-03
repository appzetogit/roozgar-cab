import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { Driver } from '../../driver/models/Driver.js';
import { DriverSubscription } from '../../driver/models/DriverSubscription.js';
import { OwnerSubscription } from '../../admin/models/OwnerSubscription.js';
import { getOwnerServiceStatus, getServingOwnerIds } from '../../driver/services/ownerBillingService.js';
import { Vehicle } from '../../admin/models/Vehicle.js';
import { Ride } from '../../user/models/Ride.js';
import { RIDE_STATUS } from '../../constants/index.js';
import { ShareTrip, ACTIVE_TRIP_STATUSES } from '../models/ShareTrip.js';
import { ShareRide, ACTIVE_RIDE_STATUSES } from '../models/ShareRide.js';
import { quoteShareFare, listShareVehicleOptions, vehicleCapacityOf, maxSeatsCap, BIKE_TYPES } from './shareRideFare.js';
import { CORRIDOR_KM, IDLE_RADIUS_KM, corridorFit, haversineKm, routeBox } from './shareRideGeo.js';
import {
  getActiveDriverSubscription,
  resolveDriverSubscriptionSettings,
} from '../../driver/services/driverSubscriptionService.js';
import {
  applyDriverWalletAdjustment,
  computeCommissionAmount,
  resolveCommissionConfigForRide,
} from '../../driver/services/walletService.js';
import { emitToDriver, emitToUser } from '../../services/dispatchService.js';
import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';

// Share Ride service: everything a rider, driver, owner and the (read-only)
// admin do. Written without transactions: production Mongo is a standalone
// mongod. Every race that matters (one driver wins a request, seats never
// oversold, a ride settles once) is a conditional findOneAndUpdate on a single
// document, which is atomic on its own. See docs/share-ride.md.

const REQUEST_TTL_MS = 20 * 60 * 1000;
const RELEASE_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const MAX_NOTIFIED_DRIVERS = 30;

const text = (value) => String(value ?? '').trim();
const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const idOf = (value) => String(value?._id || value || '');
const newOtp = () => String(crypto.randomInt(1000, 10000));
const sameId = (a, b) => idOf(a) === idOf(b);
// An ApiError whose stable `code` the apps switch on (the error handler puts it in the JSON body).
// The native offer card (app may be killed) shows a message from these codes in `details.cardCode`.
const CARD_CODES = { REQUEST_TAKEN: 'ALREADY_HANDLED', REQUEST_EXPIRED: 'EXPIRED', NO_FREE_SEATS: 'SEATS_EXCEED_CAPACITY', OWNER_STOPPED: 'OWNER_STOPPED' };
const fail = (status, message, code) =>
  Object.assign(new ApiError(status, message, CARD_CODES[code] ? { cardCode: CARD_CODES[code] } : null), { code });
const isBikeDriver = (driver) =>
  BIKE_TYPES.includes(String(driver?.vehicleType || '').toLowerCase()) || BIKE_TYPES.includes(String(driver?.vehicleIconType || '').toLowerCase());
const tripIdleMs = () => Math.max(1, Number(process.env.SHARE_TRIP_IDLE_MINUTES) || 120) * 60 * 1000;
const GPS_FRESH_MS = 5 * 60 * 1000;
// A live GPS fix: online, a point, written in the last 5 minutes.
const hasFreshGps = (driver) => Boolean(
  driver?.isOnline && driver.location?.coordinates?.length === 2 && driver.locationUpdatedAt
  && Date.now() - new Date(driver.locationUpdatedAt).getTime() <= GPS_FRESH_MS,
);

// ----------------------------------------------------------------- helpers

export const toPlace = (input, label) => {
  const lat = Number(input?.lat ?? input?.latitude);
  const lng = Number(input?.lng ?? input?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw fail(400, `A valid ${label} location is required`, 'INVALID_LOCATION');
  }
  return { address: text(input?.address).slice(0, 300), location: { type: 'Point', coordinates: [lng, lat] } };
};

const coordsOf = (place) => place.location.coordinates;
const placeOut = (place) => ({
  address: place?.address || '',
  lat: place?.location?.coordinates?.[1] ?? null,
  lng: place?.location?.coordinates?.[0] ?? null,
});

const notifyUser = (ride, title, body, type) => {
  emitToUser(idOf(ride.userId), 'share:ride:updated', { rideId: idOf(ride._id), status: ride.status, type });
  sendPushNotificationToEntities({
    userIds: [idOf(ride.userId)], title, body, data: { type, rideId: idOf(ride._id) },
  }).catch((error) => console.error('share ride push to rider failed', error?.message || error));
};

const notifyDriver = (driverId, ride, title, body, type, extra = {}) => {
  if (!driverId) return;
  emitToDriver(idOf(driverId), 'share:ride:updated', { rideId: idOf(ride._id), status: ride.status, type });
  sendPushNotificationToEntities({
    driverIds: [idOf(driverId)], title, body, data: { type, rideId: idOf(ride._id), ...extra },
  }).catch((error) => console.error('share ride push to driver failed', error?.message || error));
};

// Trip notices to a driver: a socket event for an open screen and a push for a closed app.
const pushDriver = (driverId, title, body, data) =>
  sendPushNotificationToEntities({ driverIds: [idOf(driverId)], title, body, data })
    .catch((error) => console.error('share push to driver failed', error?.message || error));
const tellDriverTrip = (driverId, tripId, status, reason) =>
  emitToDriver(idOf(driverId), 'share:trip:updated', { tripId: idOf(tripId), status, reason });

const STUCK_ACCEPTED_MS = 6 * 60 * 60 * 1000;
const STUCK_ONGOING_MS = 12 * 60 * 60 * 1000;

// A trip the driver started just by tapping "add" holds nobody once its last
// rider leaves, and would keep matching the old route. Retire it then. Trips an
// owner created, and trips already running, are left for their people to close.
const retireEmptyAutoTrip = (tripId) =>
  tripId
    ? ShareTrip.updateOne(
      { _id: tripId, status: 'open', createdBy: 'driver', seatsTaken: 0 },
      { $set: { status: 'cancelled', completedAt: new Date() } },
    )
    : null;

// Free a seat and retire the trip if that emptied an auto-made one.
const releaseSeat = async (ride) => {
  if (!ride?.tripId) return;
  await ShareTrip.updateOne({ _id: ride.tripId }, { $inc: { seatsTaken: -ride.seats }, $set: { lastActivityAt: new Date() } });
  await retireEmptyAutoTrip(ride.tripId);
};

// Housekeeping, run where things are read and by the scheduled cleanup job (runShareCleanup):
// a request nobody took in time stops being offered, and a ride whose driver
// vanished does not lock the rider (one active share ride each) or the trip forever.
const expireStale = async (filter = {}, limit = 20) => {
  const now = Date.now();
  const lapsed = await ShareRide.find({ ...filter, status: 'searching', expiresAt: { $lte: new Date(now) } }).select('_id notifiedDriverIds').limit(500).lean();
  if (lapsed.length) {
    await ShareRide.updateMany(
      { _id: { $in: lapsed.map((ride) => ride._id) }, status: 'searching' },
      { $set: { status: 'expired', cancelledAt: new Date(now), cancelledBy: 'system' } },
    );
    lapsed.forEach((ride) => closeShareOffers(ride));
  }
  const stuck = await ShareRide.find({
    ...filter,
    $or: [
      { status: 'accepted', acceptedAt: { $lte: new Date(now - STUCK_ACCEPTED_MS) } },
      { status: 'ongoing', pickedUpAt: { $lte: new Date(now - STUCK_ONGOING_MS) } },
    ],
  }).limit(limit);
  for (const ride of stuck) {
    const before = await ShareRide.findOneAndUpdate(
      { _id: ride._id, status: ride.status },
      { $set: { status: 'cancelled', cancelledAt: new Date(now), cancelledBy: 'system', cancelReason: 'Timed out' } },
      { returnDocument: 'before' },
    );
    if (before) {
      await releaseSeat(before);
      before.status = 'cancelled';
      notifyUser(before, 'Share ride cancelled', 'This share ride timed out and was cancelled.', 'share_cancelled');
      notifyDriver(before.driverId, before, 'Share ride cancelled', 'A share ride timed out and was cancelled automatically.', 'share_ride_auto_cancelled', { reason: 'timeout' });
    }
  }
};

// Close empty trips nobody joined for SHARE_TRIP_IDLE_MINUTES. 'expired' is not an active status, so the
// driver's one-active-trip slot frees up. Each trip is claimed by an atomic update (safe on every instance).
export const expireIdleTrips = async (limit = 200) => {
  const cutoff = new Date(Date.now() - tripIdleMs());
  const idle = { $or: [{ lastActivityAt: { $lte: cutoff } }, { lastActivityAt: { $exists: false }, updatedAt: { $lte: cutoff } }] };
  const trips = await ShareTrip.find({ status: { $in: ACTIVE_TRIP_STATUSES }, seatsTaken: 0, ...idle }).select('_id driverId').limit(limit).lean();
  let closed = 0;
  for (const trip of trips) {
    const result = await ShareTrip.updateOne(
      { _id: trip._id, status: { $in: ACTIVE_TRIP_STATUSES }, seatsTaken: 0, ...idle },
      { $set: { status: 'expired', completedAt: new Date() } },
    );
    if (!result.modifiedCount) continue;
    closed += 1;
    tellDriverTrip(trip.driverId, trip._id, 'expired', 'idle');
    pushDriver(trip.driverId, 'Share trip closed', 'Your share trip had no riders for a while, so it was closed.', { type: 'share_trip_expired', tripId: idOf(trip._id) });
  }
  return closed;
};

export const runShareCleanup = async () => {
  await expireStale({}, 200);
  return { idleTripsClosed: await expireIdleTrips() };
};

// ------------------------------------------------------------ serializers

export const serializeRide = (ride, audience = 'admin') => {
  const out = {
    id: idOf(ride._id),
    status: ride.status,
    seats: ride.seats,
    distanceKm: ride.distanceKm,
    fare: ride.fare,
    fareBreakdown: ride.fareBreakdown,
    pickup: placeOut(ride.pickup),
    drop: placeOut(ride.drop),
    tripId: ride.tripId ? idOf(ride.tripId) : null,
    expiresAt: ride.expiresAt,
    acceptedAt: ride.acceptedAt,
    pickedUpAt: ride.pickedUpAt,
    completedAt: ride.completedAt,
    cancelledAt: ride.cancelledAt,
    cancelledBy: ride.cancelledBy,
    cancelReason: ride.cancelReason,
    collectedVia: ride.collectedVia,
    createdAt: ride.createdAt,
    driver: ride.driverId ? { id: idOf(ride.driverId), ...ride.driverSnapshot } : null,
    vehicle: ride.vehicleSnapshot?.number || ride.vehicleSnapshot?.name ? ride.vehicleSnapshot : null,
    // The vehicle type the rider asked for (the real car is `vehicle`, once a driver accepts).
    vehicleRequested: ride.vehicleTypeId
      ? { vehicleTypeId: idOf(ride.vehicleTypeId), name: ride.requestedVehicleSnapshot?.name || '', capacity: ride.requestedVehicleSnapshot?.capacity || 0 }
      : null,
  };
  // The OTP is the rider's secret: only the rider sees it.
  if (audience === 'user') out.otp = ride.otp;
  if (audience !== 'user') out.passenger = ride.passenger;
  if (audience === 'admin' || audience === 'owner' || audience === 'driver') {
    out.settlement = ride.settlement;
  }
  if (audience === 'admin' || audience === 'owner') out.ownerId = ride.ownerId ? idOf(ride.ownerId) : null;
  return out;
};

// What a driver sees of a request they have not taken yet: no phone number and
// only the rider's first name. The full passenger details come after accepting.
const serializeOpenRequest = (ride) => {
  const out = serializeRide(ride, 'driver');
  out.passenger = { name: text(ride.passenger?.name).split(/\s+/)[0] || 'Rider' };
  delete out.settlement;
  return out;
};

export const serializeTrip = (trip, rides = []) => ({
  id: idOf(trip._id),
  status: trip.status,
  driverId: idOf(trip.driverId),
  ownerId: trip.ownerId ? idOf(trip.ownerId) : null,
  createdBy: trip.createdBy,
  vehicle: trip.vehicleSnapshot,
  origin: placeOut(trip.origin),
  destination: placeOut(trip.destination),
  routeDistanceKm: trip.routeDistanceKm,
  baseRideId: trip.baseRideId ? idOf(trip.baseRideId) : null,
  seatsTotal: trip.seatsTotal,
  seatsTaken: trip.seatsTaken,
  seatsFree: Math.max(0, trip.seatsTotal - trip.seatsTaken),
  startedAt: trip.startedAt,
  completedAt: trip.completedAt,
  createdAt: trip.createdAt,
  ridersCompleted: trip.stats?.ridersCompleted || 0,
  lastActivityAt: trip.lastActivityAt || trip.updatedAt || trip.createdAt,
  // When an empty trip will be closed for being idle; null once someone is on board.
  expiresAt: ACTIVE_TRIP_STATUSES.includes(trip.status) && !trip.seatsTaken
    ? new Date(new Date(trip.lastActivityAt || trip.updatedAt || trip.createdAt).getTime() + tripIdleMs())
    : null,
  stats: trip.stats,
  riders: rides.map((ride) => serializeRide(ride, 'driver')),
});

// -------------------------------------------------------------- rider side

const parseRideInput = (body = {}) => ({
  pickup: toPlace(body.pickup, 'pickup'),
  drop: toPlace(body.drop, 'drop'),
  seats: Math.round(Number(body.seats) || 1),
  vehicleTypeId: text(body.vehicleTypeId),
});

const checkVehicleId = (vehicleTypeId) => {
  if (vehicleTypeId && !mongoose.isValidObjectId(vehicleTypeId)) {
    throw fail(400, 'This vehicle is not available for share rides', 'VEHICLE_NOT_AVAILABLE');
  }
};

export const quoteForRider = async (body, deps = null) => {
  const { pickup, drop, seats, vehicleTypeId } = parseRideInput(body);
  checkVehicleId(vehicleTypeId);
  const quote = await quoteShareFare({ pickup: coordsOf(pickup), drop: coordsOf(drop), seats, vehicleTypeId }, deps);
  if (quote.code) throw fail(400, quote.reason, quote.code);
  return quote;
};

export const createShareRide = async ({ user, body, deps = null }) => {
  const { pickup, drop, seats, vehicleTypeId } = parseRideInput(body);
  checkVehicleId(vehicleTypeId);
  // With a vehicle the limit is that vehicle's seats (checked in the quote); without one (older apps) it is 1 to 4.
  if (seats < 1 || (!vehicleTypeId && seats > 4)) throw fail(400, 'You can book 1 to 4 seats', 'SEATS_INVALID');

  // The fare is always the server's: whatever the app sent is ignored.
  const quote = await quoteShareFare({ pickup: coordsOf(pickup), drop: coordsOf(drop), seats, vehicleTypeId }, deps);
  if (!quote.available) throw fail(quote.code ? 400 : 422, quote.reason, quote.code || 'NOT_AVAILABLE');

  await expireStale({ userId: user._id });

  let ride;
  try {
    ride = await ShareRide.create({
      userId: user._id,
      passenger: { name: text(user.name), phone: text(user.phone) },
      pickup,
      drop,
      seats: quote.seats,
      vehicleTypeId: quote.vehicle ? quote.vehicle.vehicleTypeId : null,
      requestedVehicleSnapshot: quote.vehicle ? { name: quote.vehicle.name, capacity: quote.vehicle.capacity } : undefined,
      distanceKm: quote.distanceKm,
      fare: quote.total,
      fareBreakdown: {
        perSeat: quote.perSeat,
        subtotal: quote.subtotal,
        platformFee: quote.platformFee,
        discountPercent: quote.discountPercent,
        tariffName: quote.tariffName,
      },
      otp: newOtp(),
      expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
    });
  } catch (error) {
    if (error?.code === 11000) throw fail(409, 'You already have a share ride in progress', 'RIDE_IN_PROGRESS');
    throw error;
  }

  notifyNewRequest(ride).catch((error) => console.error('share request fan-out failed', error?.message || error));
  return serializeRide(ride, 'user');
};

const AVG_SPEED_KMH = 25;

// Drivers of one vehicle type that could take a share rider at this pickup right now: online nearby, or already
// running a trip that fits, and allowed to take share rides.
const nearbyShareDrivers = async ({ vehicleTypeId, pickup, drop }) => {
  const base = { deletedAt: null, approve: { $ne: false }, shareRideDisabled: { $ne: true }, vehicleType: { $nin: BIKE_TYPES }, vehicleTypeId };
  const [near, trips] = await Promise.all([
    Driver.find({ ...base, isOnline: true, location: { $nearSphere: { $geometry: { type: 'Point', coordinates: pickup }, $maxDistance: IDLE_RADIUS_KM * 1000 } } })
      .select('_id owner_id location vehicleTypeId vehicleType').limit(MAX_NOTIFIED_DRIVERS).lean(),
    ShareTrip.find({ status: { $in: ACTIVE_TRIP_STATUSES }, vehicleTypeId }).limit(200).lean(),
  ]);
  const candidates = new Map(near.map((driver) => [idOf(driver._id), driver]));
  const onTrips = trips
    .filter((trip) => trip.seatsTotal - trip.seatsTaken >= 1 && corridorFit({ origin: coordsOf(trip.origin), destination: coordsOf(trip.destination), pickup, drop }).fits)
    .map((trip) => idOf(trip.driverId))
    .filter((id) => !candidates.has(id));
  if (onTrips.length) {
    (await Driver.find({ ...base, _id: { $in: onTrips } }).select('_id owner_id location vehicleTypeId vehicleType').lean()).forEach((driver) => candidates.set(idOf(driver._id), driver));
  }
  const allowed = await eligibleProviders([...candidates.values()]);
  const context = await driverContext(allowed);
  const eligible = allowed.filter((driver) => (context.get(idOf(driver._id))?.free || 0) >= 1);
  const distances = eligible.filter((driver) => driver.location?.coordinates?.length === 2).map((driver) => haversineKm(driver.location.coordinates, pickup));
  return { count: eligible.length, etaMinutes: distances.length ? Math.max(1, Math.round((Math.min(...distances) / AVG_SPEED_KMH) * 60)) : null };
};

// The vehicles a rider can choose for a route, each with its seat limit, price per seat and whether a driver is near.
export const vehicleOptionsForRider = async (body = {}, deps = null) => {
  const pickup = toPlace(body.pickup, 'pickup');
  const drop = toPlace(body.drop, 'drop');
  const found = await listShareVehicleOptions({ pickup: coordsOf(pickup), drop: coordsOf(drop) }, deps);
  if (!found.available) return found;
  const options = [];
  for (const option of found.options) {
    const near = await nearbyShareDrivers({ vehicleTypeId: option.vehicleTypeId, pickup: coordsOf(pickup), drop: coordsOf(drop) });
    options.push({
      ...option, nearbyDrivers: near.count, etaMinutes: near.etaMinutes,
      available: near.count > 0, reason: near.count > 0 ? '' : `No ${option.name} nearby right now`,
    });
  }
  return { ...found, options };
};

export const listRiderRides = async (userId, { status = 'active' } = {}) => {
  await expireStale({ userId });
  const active = status !== 'history';
  const rides = await ShareRide.find({
    userId,
    status: active ? { $in: ACTIVE_RIDE_STATUSES } : { $in: ['completed', 'cancelled', 'expired'] },
  }).sort({ createdAt: -1 }).limit(50);
  return rides.map((ride) => serializeRide(ride, 'user'));
};

export const getRiderRide = async (userId, rideId) => {
  await expireStale({ userId });
  const ride = await ShareRide.findOne({ _id: rideId, userId });
  if (!ride) throw fail(404, 'Share ride not found', 'SHARE_RIDE_NOT_FOUND');
  return serializeRide(ride, 'user');
};

export const cancelByRider = async ({ userId, rideId, reason = '' }) => {
  const before = await ShareRide.findOneAndUpdate(
    { _id: rideId, userId, status: { $in: ['searching', 'accepted'] } },
    { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: 'user', cancelReason: text(reason).slice(0, 200) } },
    { returnDocument: 'before' },
  );
  if (!before) {
    const exists = await ShareRide.exists({ _id: rideId, userId });
    throw fail(exists ? 409 : 404, exists ? 'This ride can no longer be cancelled' : 'Share ride not found', exists ? 'CANNOT_CANCEL' : 'SHARE_RIDE_NOT_FOUND');
  }
  if (before.status === 'searching') closeShareOffers(before);
  if (before.status === 'accepted' && before.tripId) {
    await releaseSeat(before);
    notifyDriver(before.driverId, before, 'Rider cancelled', 'The rider cancelled this share ride.', 'share_cancelled');
  }
  return serializeRide(await ShareRide.findById(rideId), 'user');
};

// ------------------------------------------------------------- driver side

const vehicleCapacity = async (driver) => {
  const vehicle = driver.vehicleTypeId ? await Vehicle.findById(driver.vehicleTypeId).select('capacity name category icon_types').lean() : null;
  return vehicleCapacityOf({ ...vehicle, category: vehicle?.category || driver.vehicleType });
};

const currentNormalRide = (driverId) =>
  Ride.findOne({ driverId, status: { $in: [RIDE_STATUS.ACCEPTED, RIDE_STATUS.ONGOING] } })
    .select('pickupLocation dropLocation pickupAddress dropAddress')
    .lean();

const activeTripOf = (driverId) => ShareTrip.findOne({ driverId, status: { $in: ACTIVE_TRIP_STATUSES } });

// Why a driver can or cannot take share rides right now. `code` is stable for the apps to switch on;
// `reason` is the text to show; `canBuyPass` is true only when buying a pass would fix it.
const providerState = async (driver) => {
  const blocked = (code, reason, canBuyPass = false) => ({ eligible: false, code, reason, canBuyPass });
  if (!driver) return blocked('DRIVER_NOT_FOUND', 'Driver not found');
  if (driver.approve === false) return blocked('NOT_APPROVED', 'Your account is waiting for approval');
  if (driver.shareRideDisabled) return blocked('DISABLED_BY_OWNER', 'Share rides are switched off for you by your owner');
  if (isBikeDriver(driver)) return blocked('NOT_SHARE_VEHICLE', 'Share rides are not available for bike drivers');
  if (driver.owner_id) {
    const ownerStatus = await getOwnerServiceStatus(driver.owner_id);
    if (!ownerStatus.active) return blocked('OWNER_STOPPED', ownerStatus.reason);
  } else if (!(await getActiveDriverSubscription(driver._id))) {
    return blocked('SUBSCRIPTION_REQUIRED', 'Buy a pass to take share rides', true);
  }
  return { eligible: true, code: 'OK', reason: '', canBuyPass: false };
};

const providerBlocker = async (driver) => (await providerState(driver)).reason;

const assertProvider = async (driverId) => {
  const driver = await Driver.findOne({ _id: driverId, deletedAt: null });
  const state = await providerState(driver);
  if (!state.eligible) throw fail(403, state.reason, state.code);
  return driver;
};

export const getDriverShareStatus = async (driverId) => {
  const driver = await Driver.findOne({ _id: driverId, deletedAt: null });
  const state = await providerState(driver);
  const [trip, normal] = await Promise.all([
    driver ? activeTripOf(driverId) : null,
    driver ? currentNormalRide(driverId) : null,
  ]);
  return {
    eligible: state.eligible,
    code: state.code,
    reason: state.reason,
    canBuyPass: state.canBuyPass,
    enabled: driver ? !driver.shareRideDisabled : false,
    hasNormalRide: Boolean(normal),
    trip: trip ? serializeTrip(trip) : null,
  };
};

// The straight line a driver's share requests are matched against.
const routeFor = async (driver) => {
  const trip = await activeTripOf(driver._id);
  if (trip) {
    return {
      kind: 'trip', trip,
      origin: coordsOf(trip.origin), destination: coordsOf(trip.destination),
      seatsFree: Math.max(0, trip.seatsTotal - trip.seatsTaken),
      // An empty trip does not pin the driver to its old line while they have a live GPS fix.
      idleToo: trip.seatsTaken === 0 && hasFreshGps(driver),
    };
  }
  const normal = await currentNormalRide(driver._id);
  if (normal?.pickupLocation?.coordinates && normal?.dropLocation?.coordinates) {
    const capacity = await vehicleCapacity(driver);
    return {
      kind: 'ride', normal,
      origin: normal.pickupLocation.coordinates, destination: normal.dropLocation.coordinates,
      seatsFree: Math.max(0, capacity - 2), // the driver, and the rider already on board
    };
  }
  return { kind: 'idle', seatsFree: Math.max(0, (await vehicleCapacity(driver)) - 1) };
};

export const listRequestsForDriver = async (driverId) => {
  await expireStale({ driverId });
  const driver = await Driver.findOne({ _id: driverId, deletedAt: null });
  const reason = await providerBlocker(driver);
  if (reason) return { eligible: false, reason, source: 'none', seatsFree: 0, requests: [] };

  const route = await routeFor(driver);
  // A request for a vehicle type is shown only to drivers of that type; older requests (no type) go to everyone.
  const base = {
    status: 'searching', expiresAt: { $gt: new Date() }, declinedBy: { $ne: driver._id },
    vehicleTypeId: { $in: [null, driver.vehicleTypeId || null] },
  };
  let requests = [];

  const nearIdle = async () => {
    if (driver.location?.coordinates?.length !== 2) return [];
    const near = await ShareRide.find({
      ...base,
      'pickup.location': { $nearSphere: { $geometry: driver.location, $maxDistance: IDLE_RADIUS_KM * 1000 } },
    }).limit(30);
    return near
      .filter((ride) => ride.seats <= route.seatsFree)
      .map((ride) => ({
        ride,
        fit: { pickupAwayKm: Math.round(haversineKm(driver.location.coordinates, coordsOf(ride.pickup)) * 10) / 10 },
      }));
  };

  if (route.kind === 'idle') {
    requests = await nearIdle();
  } else {
    const box = routeBox({ origin: route.origin, destination: route.destination });
    const candidates = await ShareRide.find({ ...base, 'pickup.location': { $geoWithin: { $box: box } } }).limit(100);
    requests = candidates
      .map((ride) => ({
        ride,
        fit: corridorFit({ origin: route.origin, destination: route.destination, pickup: coordsOf(ride.pickup), drop: coordsOf(ride.drop) }),
      }))
      .filter(({ ride, fit }) => fit.fits && ride.seats <= route.seatsFree);
    if (route.idleToo) {
      const seen = new Set(requests.map(({ ride }) => idOf(ride._id)));
      requests.push(...(await nearIdle()).filter(({ ride }) => !seen.has(idOf(ride._id))));
    }
  }

  return {
    eligible: true,
    reason: '',
    source: route.kind, // trip | ride | idle
    seatsFree: route.seatsFree,
    corridorKm: CORRIDOR_KM,
    requests: requests.map(({ ride, fit }) => ({ ...serializeOpenRequest(ride), fit })),
  };
};

const createTripFor = async ({ driver, origin, destination, baseRideId = null, createdBy = 'driver', reservedSeats = 0, seatsTotal = null }) => {
  const capacity = await vehicleCapacity(driver);
  const maxSeats = Math.min(maxSeatsCap(), capacity - 1 - reservedSeats);
  if (maxSeats < 1) throw fail(409, 'This vehicle has no free seat to share', 'NO_FREE_SEAT');
  const seats = seatsTotal ? Math.min(maxSeats, Math.max(1, Math.round(Number(seatsTotal)))) : maxSeats;
  try {
    return await ShareTrip.create({
      driverId: driver._id,
      ownerId: driver.owner_id || null,
      createdBy,
      vehicleTypeId: driver.vehicleTypeId || null,
      vehicleSnapshot: {
        type: driver.vehicleType, name: [driver.vehicleMake, driver.vehicleModel].filter(Boolean).join(' '),
        number: driver.vehicleNumber, color: driver.vehicleColor,
      },
      origin, destination,
      routeDistanceKm: Math.round(haversineKm(coordsOf(origin), coordsOf(destination)) * 1.3 * 10) / 10,
      baseRideId,
      seatsTotal: seats,
    });
  } catch (error) {
    if (error?.code === 11000) return activeTripOf(driver._id); // lost a race with another tap: use theirs
    throw error;
  }
};

export const acceptShareRequest = async ({ driverId, rideId, tripId = null }) => {
  const driver = await assertProvider(driverId);
  const now = new Date();

  const ride = await ShareRide.findById(rideId);
  // Idempotent: the offer card may send the accept twice (retry, killed app). The driver who holds it gets the same answer.
  if (ride && ['accepted', 'ongoing'].includes(ride.status) && sameId(ride.driverId, driver._id)) {
    const held = ride.tripId ? await ShareTrip.findById(ride.tripId) : null;
    return { ride: serializeRide(ride, 'driver'), trip: held ? serializeTrip(held, [ride]) : null, alreadyAccepted: true };
  }
  if (!ride) throw fail(409, 'This request is no longer available', 'REQUEST_EXPIRED');
  if (ride.status !== 'searching' || ride.expiresAt <= now) {
    throw fail(409, 'This request is no longer available', ['accepted', 'ongoing', 'completed'].includes(ride.status) ? 'REQUEST_TAKEN' : 'REQUEST_EXPIRED');
  }
  if (ride.declinedBy.some((id) => sameId(id, driver._id))) throw fail(409, 'You handed this rider back earlier', 'REQUEST_DECLINED');
  if (ride.vehicleTypeId && !sameId(ride.vehicleTypeId, driver.vehicleTypeId)) {
    throw fail(409, 'This request is for a different vehicle type', 'VEHICLE_MISMATCH');
  }

  const rider = { pickup: coordsOf(ride.pickup), drop: coordsOf(ride.drop) };
  let trip = tripId ? await ShareTrip.findOne({ _id: tripId, driverId, status: { $in: ACTIVE_TRIP_STATUSES } }) : await activeTripOf(driverId);
  if (tripId && !trip) throw fail(404, 'Trip not found', 'TRIP_NOT_FOUND');
  let tripIsNew = false;
  let rebase = null;

  if (trip) {
    const fit = corridorFit({ origin: coordsOf(trip.origin), destination: coordsOf(trip.destination), ...rider });
    if (!fit.fits) {
      // An empty trip with a live GPS fix is not pinned to its old line: the first rider defines the new one.
      if (trip.seatsTaken === 0 && hasFreshGps(driver) && haversineKm(driver.location.coordinates, rider.pickup) <= IDLE_RADIUS_KM) {
        rebase = {
          origin: { address: '', location: { type: 'Point', coordinates: driver.location.coordinates } },
          destination: { address: ride.drop.address || '', location: { type: 'Point', coordinates: rider.drop } },
          routeDistanceKm: Math.round(haversineKm(driver.location.coordinates, rider.drop) * 1.3 * 10) / 10,
        };
      } else throw fail(409, 'This rider is not on your route', 'NOT_ON_ROUTE');
    }
  } else {
    const normal = await currentNormalRide(driverId);
    if (normal?.pickupLocation?.coordinates && normal?.dropLocation?.coordinates) {
      const fit = corridorFit({ origin: normal.pickupLocation.coordinates, destination: normal.dropLocation.coordinates, ...rider });
      if (!fit.fits) throw fail(409, 'This rider is not on the route of your current ride', 'NOT_ON_ROUTE');
      tripIsNew = true;
      trip = await createTripFor({
        driver, baseRideId: normal._id, reservedSeats: 1,
        origin: { address: normal.pickupAddress || '', location: { type: 'Point', coordinates: normal.pickupLocation.coordinates } },
        destination: { address: normal.dropAddress || '', location: { type: 'Point', coordinates: normal.dropLocation.coordinates } },
      });
    } else {
      if (!driver.isOnline) throw fail(403, 'Go online to take share rides', 'GO_ONLINE_REQUIRED');
      tripIsNew = true;
      trip = await createTripFor({
        driver,
        origin: { address: '', location: { type: 'Point', coordinates: driver.location?.coordinates?.length === 2 ? driver.location.coordinates : rider.pickup } },
        destination: ride.drop,
      });
    }
  }

  // Claim the seats first, then the rider; each is one atomic update.
  const claimed = await ShareTrip.findOneAndUpdate(
    { _id: trip._id, status: { $in: ACTIVE_TRIP_STATUSES }, ...(rebase ? { seatsTaken: 0 } : {}), $expr: { $lte: [{ $add: ['$seatsTaken', ride.seats] }, '$seatsTotal'] } },
    { $inc: { seatsTaken: ride.seats }, $set: { lastActivityAt: now, ...(rebase || {}) } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    if (tripIsNew) await retireEmptyAutoTrip(trip._id);
    throw fail(409, 'Not enough free seats on your trip', 'NO_FREE_SEATS');
  }

  const accepted = await ShareRide.findOneAndUpdate(
    { _id: ride._id, status: 'searching', expiresAt: { $gt: now } },
    {
      $set: {
        status: 'accepted', tripId: trip._id, driverId: driver._id, ownerId: driver.owner_id || null, acceptedAt: now,
        driverSnapshot: { name: driver.name, phone: driver.phone, photo: driver.profileImage || '' },
        vehicleSnapshot: { type: trip.vehicleSnapshot.type, name: trip.vehicleSnapshot.name, number: trip.vehicleSnapshot.number, color: trip.vehicleSnapshot.color },
      },
    },
    { returnDocument: 'after' },
  );
  if (!accepted) {
    await releaseSeat({ tripId: trip._id, seats: ride.seats });
    throw fail(409, 'Another driver just took this request', 'REQUEST_TAKEN');
  }

  closeShareOffers(ride, [driver._id]);
  notifyUser(accepted, 'Share ride confirmed', `${driver.name || 'Your driver'} is coming to pick you up. Share your OTP at pickup.`, 'share_accepted');
  return { ride: serializeRide(accepted, 'driver'), trip: serializeTrip(claimed, [accepted]) };
};

// "No thanks" from the offer card. Hides the request from this driver; harmless if it is already gone or rejected twice.
export const rejectShareRequest = async ({ driverId, rideId }) => {
  if (!mongoose.isValidObjectId(rideId)) return { rideId: text(rideId), rejected: true };
  await ShareRide.updateOne(
    { _id: rideId, status: 'searching' },
    { $addToSet: { declinedBy: driverId }, $pull: { notifiedDriverIds: driverId } },
  );
  return { rideId: idOf(rideId), rejected: true };
};

export const verifyPickup = async ({ driverId, rideId, otp }) => {
  const filter = { _id: rideId, driverId, status: 'accepted' };
  const ride = await ShareRide.findOneAndUpdate(
    { ...filter, otp: text(otp), otpAttempts: { $lt: MAX_OTP_ATTEMPTS } },
    { $set: { status: 'ongoing', pickedUpAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!ride) {
    const current = await ShareRide.findOneAndUpdate(filter, { $inc: { otpAttempts: 1 } }, { returnDocument: 'after' });
    if (!current) throw fail(409, 'This rider is not waiting for pickup', 'NOT_WAITING_FOR_PICKUP');
    if (current.otpAttempts >= MAX_OTP_ATTEMPTS) throw fail(429, 'Too many wrong OTPs. Ask the rider to cancel and book again', 'OTP_LOCKED');
    throw fail(400, 'Wrong OTP', 'WRONG_OTP');
  }
  await ShareTrip.updateOne({ _id: ride.tripId, status: 'open' }, { $set: { status: 'running', startedAt: new Date() } });
  await ShareTrip.updateOne({ _id: ride.tripId }, { $set: { lastActivityAt: new Date() } });
  notifyUser(ride, 'Share ride started', 'Your ride has started. Have a safe trip!', 'share_started');
  return serializeRide(ride, 'driver');
};

export const releaseRider = async ({ driverId, rideId }) => {
  const before = await ShareRide.findOneAndUpdate(
    { _id: rideId, driverId, status: 'accepted' },
    {
      $set: {
        status: 'searching', tripId: null, driverId: null, ownerId: null, acceptedAt: null, otpAttempts: 0, otp: newOtp(), notifiedDriverIds: [],
        driverSnapshot: {}, vehicleSnapshot: {}, expiresAt: new Date(Date.now() + RELEASE_TTL_MS),
      },
      $addToSet: { declinedBy: driverId },
    },
    { returnDocument: 'before' },
  );
  if (!before) throw fail(409, 'This rider cannot be handed back now', 'CANNOT_RELEASE');
  await releaseSeat(before);

  const after = await ShareRide.findById(rideId);
  notifyUser(after, 'Looking for another driver', 'Your driver could not take this ride. We are finding you another one.', 'share_released');
  notifyNewRequest(after).catch((error) => console.error('share request fan-out failed', error?.message || error));
  return serializeRide(after, 'driver');
};

// What the platform takes from one completed ride, and what the driver keeps.
// Mirrors settleCompletedRideWallet: the rider's platform fee is always the
// platform's; the trip commission is waived while the driver's pass covers it.
// Exported so the maths can be tested without a database.
export const computeSettlement = ({ fare, platformFee, commissionConfig, covered }) => {
  const safeFare = money(fare);
  const fee = Math.min(money(platformFee), safeFare);
  const tripCommission = computeCommissionAmount({
    fare: money(safeFare - fee), type: commissionConfig.type, value: commissionConfig.value,
  });
  const waived = covered ? tripCommission : 0;
  const commission = covered ? 0 : tripCommission;
  const takenFromDriver = Math.min(money(commission + fee), safeFare);
  return {
    platformFee: fee,
    commission,
    commissionWaived: money(waived),
    takenFromDriver,
    driverEarnings: Math.max(money(safeFare - takenFromDriver), 0),
  };
};

const settleRide = async (ride, now) => {
  const [trip, driver, settings] = await Promise.all([
    ShareTrip.findById(ride.tripId).select('vehicleTypeId').lean(),
    Driver.findById(ride.driverId).select('service_location_id owner_id').lean(),
    resolveDriverSubscriptionSettings(),
  ]);
  // A fleet driver is covered by, and charged the commission of, their owner.
  const covering = settings.waiveCommission
    ? await (driver?.owner_id ? OwnerSubscription : DriverSubscription).findOne({
      ...(driver?.owner_id ? { ownerId: driver.owner_id } : { driverId: ride.driverId }),
      status: 'active', paidAt: { $ne: null }, startsAt: { $lte: now }, expiresAt: { $gt: now },
    }).lean()
    : null;
  const commissionConfig = await resolveCommissionConfigForRide(
    { vehicleTypeId: trip?.vehicleTypeId, service_location_id: driver?.service_location_id, transport_type: 'taxi', serviceType: 'ride' },
    null,
    { forOwner: Boolean(driver?.owner_id) },
  );
  const result = computeSettlement({
    fare: ride.fare, platformFee: ride.fareBreakdown?.platformFee, commissionConfig, covered: Boolean(covering),
  });

  await ShareRide.updateOne({ _id: ride._id }, {
    $set: {
      'settlement.platformFee': result.platformFee,
      'settlement.commission': result.commission,
      'settlement.commissionWaived': result.commissionWaived,
      'settlement.driverEarnings': result.driverEarnings,
      'settlement.subscriptionId': covering?._id || null,
      'settlement.walletStatus': result.takenFromDriver > 0 ? 'pending' : 'none',
    },
  });
  await ShareTrip.updateOne({ _id: ride.tripId }, {
    $inc: {
      'stats.ridersCompleted': 1, 'stats.gross': ride.fare, 'stats.platformFee': result.platformFee,
      'stats.commission': result.commission, 'stats.driverEarnings': result.driverEarnings,
    },
  });
  if (covering) {
    await DriverSubscription.updateOne(
      { _id: covering._id }, { $inc: { tripsCovered: 1, commissionWaived: result.commissionWaived } },
    );
  }

  // The driver collected the fare in cash/UPI, so what the platform is owed
  // comes off their wallet, exactly like a cash normal ride.
  if (result.takenFromDriver > 0) {
    await applyDriverWalletAdjustment({
      driverId: ride.driverId,
      amount: -result.takenFromDriver,
      type: 'commission_deduction',
      description: result.platformFee > 0 && result.commission === 0
        ? 'Platform fee deducted for share ride'
        : 'Commission and platform fee deducted for share ride',
      metadata: { shareRideId: String(ride._id), fare: ride.fare, ...result, subscriptionId: covering ? String(covering._id) : null },
    });
    await ShareRide.updateOne({ _id: ride._id }, { $set: { 'settlement.walletStatus': 'settled' } });
  }
  return result;
};

export const completeShareRide = async ({ driverId, rideId, collectedVia = 'cash' }) => {
  const now = new Date();
  const via = text(collectedVia).toLowerCase() === 'upi' ? 'upi' : 'cash';

  // The claim: only the first call flips the ride, so it settles exactly once.
  const ride = await ShareRide.findOneAndUpdate(
    { _id: rideId, driverId, status: 'ongoing', 'settlement.settledAt': null },
    { $set: { status: 'completed', completedAt: now, collectedVia: via, 'settlement.settledAt': now, 'settlement.walletStatus': 'pending' } },
    { returnDocument: 'after' },
  );
  if (!ride) throw fail(409, 'This ride is not in progress', 'RIDE_NOT_IN_PROGRESS');

  await ShareTrip.updateOne({ _id: ride.tripId }, { $inc: { seatsTaken: -ride.seats }, $set: { lastActivityAt: now } }); // seat is free again
  // The last rider is off a trip the driver made themselves: it is finished, so the driver is matched by GPS again.
  // (Owner-made trips stay open for the owner to close, or the idle cleanup.)
  await ShareTrip.updateOne(
    { _id: ride.tripId, status: { $in: ACTIVE_TRIP_STATUSES }, createdBy: 'driver', seatsTaken: 0 },
    { $set: { status: 'completed', completedAt: now } },
  );

  let settlement = null;
  try {
    settlement = await settleRide(ride, now);
  } catch (error) {
    // Money already changed hands; do not fail the driver's tap. The ride stays
    // flagged walletStatus 'pending' for the admin monitor.
    console.error('share ride settlement failed', String(ride._id), error?.message || error);
  }
  const done = await ShareRide.findById(ride._id);
  notifyUser(done, 'Ride completed', 'You have reached your drop. Thanks for sharing the ride!', 'share_completed');
  return { ride: serializeRide(done, 'driver'), settlement };
};

export const getDriverTrip = async (driverId) => {
  await expireStale({ driverId });
  const trip = await activeTripOf(driverId);
  if (!trip) return null;
  const rides = await ShareRide.find({ tripId: trip._id, status: { $in: ['accepted', 'ongoing'] } }).sort({ acceptedAt: 1 });
  return serializeTrip(trip, rides);
};

const closeTrip = async ({ filter, status }) => {
  const trip = await ShareTrip.findOne({ ...filter, status: { $in: ACTIVE_TRIP_STATUSES } });
  if (!trip) throw fail(404, 'Trip not found', 'TRIP_NOT_FOUND');
  const pending = await ShareRide.countDocuments({ tripId: trip._id, status: { $in: ['accepted', 'ongoing'] } });
  if (pending) throw fail(409, `${pending} rider${pending > 1 ? 's are' : ' is'} still on this trip`, 'RIDERS_ON_TRIP');
  trip.status = status;
  trip.completedAt = new Date();
  await trip.save();
  return trip;
};

export const completeTrip = async ({ driverId, tripId }) =>
  serializeTrip(await closeTrip({ filter: { _id: tripId, driverId }, status: 'completed' }));
export const cancelTrip = async ({ driverId, tripId }) =>
  serializeTrip(await closeTrip({ filter: { _id: tripId, driverId }, status: 'cancelled' }));

const earningsTotals = (match) =>
  ShareRide.aggregate([
    { $match: { status: 'completed', ...match } },
    {
      $group: {
        _id: null,
        rides: { $sum: 1 },
        seats: { $sum: '$seats' },
        gross: { $sum: '$fare' },
        platformFee: { $sum: '$settlement.platformFee' },
        commission: { $sum: '$settlement.commission' },
        commissionWaived: { $sum: '$settlement.commissionWaived' },
        driverEarnings: { $sum: '$settlement.driverEarnings' },
      },
    },
  ]).then(([row]) => ({
    rides: row?.rides || 0, seats: row?.seats || 0, gross: money(row?.gross), platformFee: money(row?.platformFee),
    commission: money(row?.commission), commissionWaived: money(row?.commissionWaived), driverEarnings: money(row?.driverEarnings),
  }));

const rangeFilter = ({ from, to } = {}) => {
  const range = {};
  if (from && !Number.isNaN(new Date(from).getTime())) range.$gte = new Date(from);
  if (to && !Number.isNaN(new Date(to).getTime())) range.$lte = new Date(to);
  return Object.keys(range).length ? { completedAt: range } : {};
};

export const getDriverShareEarnings = async (driverId, range = {}) => {
  const match = { driverId: new mongoose.Types.ObjectId(String(driverId)), ...rangeFilter(range) };
  const [totals, recent] = await Promise.all([
    earningsTotals(match),
    ShareRide.find({ driverId, status: 'completed', ...rangeFilter(range) }).sort({ completedAt: -1 }).limit(20),
  ]);
  return { ...totals, recent: recent.map((ride) => serializeRide(ride, 'driver')) };
};

// Of these drivers, the ones providerState would let take share rides now: a solo driver needs a pass,
// a fleet driver needs a serving owner. Bulk (one query for passes, one for owners), not per driver.
const eligibleProviders = async (candidates) => {
  const soloIds = candidates.filter((driver) => !driver.owner_id).map((driver) => driver._id);
  const [passes, serving] = await Promise.all([
    soloIds.length
      ? DriverSubscription.distinct('driverId', { driverId: { $in: soloIds }, status: 'active', paidAt: { $ne: null }, expiresAt: { $gt: new Date() } })
      : [],
    candidates.some((driver) => driver.owner_id) ? getServingOwnerIds() : [],
  ]);
  const passSet = new Set(passes.map(String));
  const servingSet = new Set(serving.map(String));
  return candidates.filter((driver) => (driver.owner_id ? servingSet.has(String(driver.owner_id)) : passSet.has(String(driver._id))));
};

// How many seats each driver can still offer, and what they are doing: running a share trip, on a normal ride
// (the driver and that rider are on board), or idle. A request bigger than the seats left is never offered.
const driverContext = async (drivers) => {
  const ids = drivers.map((driver) => driver._id);
  const typeIds = [...new Set(drivers.map((driver) => idOf(driver.vehicleTypeId)).filter(Boolean))];
  const [trips, rides, vehicles] = await Promise.all([
    ShareTrip.find({ driverId: { $in: ids }, status: { $in: ACTIVE_TRIP_STATUSES } }).select('driverId seatsTotal seatsTaken').lean(),
    Ride.find({ driverId: { $in: ids }, status: { $in: [RIDE_STATUS.ACCEPTED, RIDE_STATUS.ONGOING] } }).select('driverId').lean(),
    typeIds.length ? Vehicle.find({ _id: { $in: typeIds } }).select('capacity category icon_types').lean() : [],
  ]);
  const tripBy = new Map(trips.map((trip) => [idOf(trip.driverId), trip]));
  const onRide = new Set(rides.map((ride) => idOf(ride.driverId)));
  const vehicleBy = new Map(vehicles.map((vehicle) => [idOf(vehicle._id), vehicle]));
  return new Map(drivers.map((driver) => {
    const id = idOf(driver._id);
    const trip = tripBy.get(id);
    if (trip) return [id, { kind: 'trip', trip, free: Math.max(0, trip.seatsTotal - trip.seatsTaken) }];
    const vehicle = vehicleBy.get(idOf(driver.vehicleTypeId));
    const capacity = vehicleCapacityOf({ ...vehicle, category: vehicle?.category || driver.vehicleType });
    const onNormal = onRide.has(id);
    return [id, { kind: onNormal ? 'ride' : 'idle', trip: null, free: Math.max(0, capacity - (onNormal ? 2 : 1)) }];
  }));
};

// Addresses are read aloud by the offer card, so they must be real text.
const speakable = (address, fallback) => {
  const value = text(address).replace(/\s+/g, ' ');
  return value.length >= 3 && !/^(selected on map|current location|unknown|-+)$/i.test(value) ? value.slice(0, 160) : fallback;
};
const offerSeconds = () => Math.max(5, Number(process.env.SHARE_OFFER_SECONDS) || 30);

// What the full-screen offer card shows and speaks. All values are strings (FCM data).
export const offerPayload = (ride, driver, tripId) => {
  const km = driver?.location?.coordinates?.length === 2 ? haversineKm(driver.location.coordinates, coordsOf(ride.pickup)) : null;
  const left = Math.max(1, Math.round((new Date(ride.expiresAt).getTime() - Date.now()) / 1000));
  return {
    type: 'share_request',
    rideId: idOf(ride._id),
    shareRideId: idOf(ride._id),
    shareTripId: tripId ? idOf(tripId) : '',
    riderName: text(ride.passenger?.name).split(/\s+/)[0] || 'Rider',
    seats: String(ride.seats),
    fare: String(Math.round(Number(ride.fare) || 0)),
    pickupAddress: speakable(ride.pickup?.address, 'the pickup point'),
    dropAddress: speakable(ride.drop?.address, 'the drop point'),
    pickupDistanceKm: km === null ? '' : km.toFixed(1),
    expiresInSeconds: String(Math.min(offerSeconds(), left)),
  };
};

const sendClosed = (driverIds, rideId) => {
  const ids = [...new Set(driverIds.map(idOf).filter(Boolean))];
  if (!ids.length) return;
  const data = { type: 'share_request_closed', shareRideId: idOf(rideId), rideId: idOf(rideId) };
  ids.forEach((id) => emitToDriver(id, 'share:request:closed', data));
  sendPushNotificationToEntities({
    driverIds: ids, title: 'Share request closed', body: 'This request is no longer available.', dataOnly: true, data,
  }).catch((error) => console.error('share request closed push failed', error?.message || error));
};

// The request was taken, cancelled or expired: stop the offer card (and its voice) on every phone that got it.
function closeShareOffers(ride, except = []) {
  const skip = new Set(except.map(idOf));
  sendClosed((ride.notifiedDriverIds || []).filter((id) => !skip.has(idOf(id))), ride._id);
}

// One driver stopped being able to take share rides (owner switched it off, owner plan ended): take down their cards.
async function closeOffersForDriver(driverId) {
  const rides = await ShareRide.find({ status: 'searching', notifiedDriverIds: driverId }).select('_id').limit(20).lean();
  rides.forEach((ride) => sendClosed([driverId], ride._id));
}

// Offer a new request to the drivers it can fit: drivers already on a share trip or a normal ride along its
// route, and idle drivers close to the pickup, of the requested vehicle type, allowed to take share rides, with
// enough free seats for THIS request (a 2-seat request is never offered to a driver who has 1 seat left).
// Each gets a data-only push (wakes a killed app into the full-screen card with voice) and the socket event.
export async function notifyNewRequest(ride) {
  const rider = { pickup: coordsOf(ride.pickup), drop: coordsOf(ride.drop) };
  const lineFit = new Set();

  const trips = await ShareTrip.find({ status: { $in: ACTIVE_TRIP_STATUSES } }).limit(200);
  for (const trip of trips) {
    if (trip.seatsTotal - trip.seatsTaken < ride.seats) continue;
    if (corridorFit({ origin: coordsOf(trip.origin), destination: coordsOf(trip.destination), ...rider }).fits) lineFit.add(idOf(trip.driverId));
  }
  const normals = await Ride.find({ status: { $in: [RIDE_STATUS.ACCEPTED, RIDE_STATUS.ONGOING] }, driverId: { $ne: null } })
    .select('driverId pickupLocation dropLocation').limit(300).lean();
  for (const normal of normals) {
    if (!normal.pickupLocation?.coordinates || !normal.dropLocation?.coordinates) continue;
    if (corridorFit({ origin: normal.pickupLocation.coordinates, destination: normal.dropLocation.coordinates, ...rider }).fits) lineFit.add(idOf(normal.driverId));
  }
  const nearby = await Driver.find({
    isOnline: true, vehicleType: { $nin: BIKE_TYPES }, deletedAt: null,
    ...(ride.vehicleTypeId ? { vehicleTypeId: ride.vehicleTypeId } : {}),
    location: { $nearSphere: { $geometry: ride.pickup.location, $maxDistance: IDLE_RADIUS_KM * 1000 } },
  }).select('_id').limit(MAX_NOTIFIED_DRIVERS).lean();
  const nearbySet = new Set(nearby.map((driver) => idOf(driver._id)));
  const ids = new Set([...lineFit, ...nearbySet]);
  if (!ids.size) return [];

  // Drivers of the requested vehicle type only, and only those providerState would let take share rides.
  const candidates = await Driver.find({
    _id: { $in: [...ids] }, deletedAt: null, approve: { $ne: false }, shareRideDisabled: { $ne: true }, vehicleType: { $nin: BIKE_TYPES },
    ...(ride.vehicleTypeId ? { vehicleTypeId: ride.vehicleTypeId } : {}),
  }).select('_id owner_id vehicleTypeId vehicleType location isOnline locationUpdatedAt').lean();
  const allowed = await eligibleProviders(candidates);
  const context = await driverContext(allowed);

  // Same rule as the driver's own request list: a driver with riders on board only sees requests along their line; an
  // empty trip with a live GPS fix also sees requests next to the driver; a driver on a normal ride only along it.
  const chosen = allowed.filter((driver) => {
    const id = idOf(driver._id);
    const info = context.get(id);
    if (!info || info.free < ride.seats) return false;
    if (info.kind === 'trip') return lineFit.has(id) || (info.trip.seatsTaken === 0 && hasFreshGps(driver) && nearbySet.has(id));
    if (info.kind === 'ride') return lineFit.has(id);
    return nearbySet.has(id);
  }).slice(0, MAX_NOTIFIED_DRIVERS);
  if (!chosen.length) return [];

  const driverIds = chosen.map((driver) => idOf(driver._id));
  await ShareRide.updateOne({ _id: ride._id }, { $addToSet: { notifiedDriverIds: { $each: chosen.map((driver) => driver._id) } } });

  for (const driver of chosen) {
    const id = idOf(driver._id);
    const payload = offerPayload(ride, driver, context.get(id)?.trip?._id);
    emitToDriver(id, 'share:request:new', payload);
    // Data-only on purpose (dataOnly): a notification block would be drawn into the tray and never wake the app.
    sendPushNotificationToEntities({
      driverIds: [id],
      title: 'Share ride request',
      body: `${ride.seats} seat${ride.seats > 1 ? 's' : ''} on your way, Rs ${payload.fare}`,
      dataOnly: true,
      data: payload,
    }).catch((error) => console.error('share request push failed', error?.message || error));
  }
  return driverIds; // who was told (the tests read it)
}

// -------------------------------------------------------------- owner side

const fleetDriver = async (ownerId, driverId) => {
  const driver = await Driver.findOne({ _id: driverId, owner_id: ownerId, deletedAt: null });
  if (!driver) throw fail(404, 'This driver is not in your fleet', 'NOT_YOUR_DRIVER');
  return driver;
};

export const ownerOverview = async (ownerId) => {
  const owner = new mongoose.Types.ObjectId(String(ownerId));
  const [totals, byDriverRows, drivers, activeTrips, searching] = await Promise.all([
    earningsTotals({ ownerId: owner }),
    ShareRide.aggregate([
      { $match: { status: 'completed', ownerId: owner } },
      { $group: { _id: '$driverId', rides: { $sum: 1 }, gross: { $sum: '$fare' }, driverEarnings: { $sum: '$settlement.driverEarnings' } } },
    ]),
    Driver.find({ owner_id: owner, deletedAt: null }).select('name phone vehicleType vehicleNumber isOnline shareRideDisabled').lean(),
    ShareTrip.countDocuments({ ownerId: owner, status: { $in: ACTIVE_TRIP_STATUSES } }),
    ShareRide.countDocuments({ ownerId: owner, status: { $in: ['accepted', 'ongoing'] } }),
  ]);
  const stats = new Map(byDriverRows.map((row) => [idOf(row._id), row]));
  return {
    totals: { ...totals, ownerEarnings: totals.driverEarnings },
    activeTrips,
    ridersOnBoard: searching,
    drivers: drivers.map((driver) => {
      const row = stats.get(idOf(driver._id));
      return {
        id: idOf(driver._id), name: driver.name, phone: driver.phone, vehicleType: driver.vehicleType,
        vehicleNumber: driver.vehicleNumber, isOnline: Boolean(driver.isOnline), shareEnabled: !driver.shareRideDisabled,
        rides: row?.rides || 0, gross: money(row?.gross), earnings: money(row?.driverEarnings),
      };
    }),
  };
};

export const ownerTrips = async (ownerId, { status = '' } = {}) => {
  const filter = { ownerId };
  if (status === 'active') filter.status = { $in: ACTIVE_TRIP_STATUSES };
  else if (status) filter.status = status;
  const trips = await ShareTrip.find(filter).sort({ createdAt: -1 }).limit(50);
  const names = new Map((await Driver.find({ _id: { $in: trips.map((t) => t.driverId) } }).select('name phone').lean()).map((d) => [idOf(d._id), d]));
  return trips.map((trip) => ({ ...serializeTrip(trip), driver: names.get(idOf(trip.driverId)) || null }));
};

export const ownerRides = async (ownerId, { status = '', page = 1, limit = 30 } = {}) =>
  pagedRides({ ownerId }, { status, page, limit });

export const ownerCreateTrip = async ({ ownerId, driverId, origin, destination, seatsTotal }) => {
  const driver = await fleetDriver(ownerId, driverId);
  if (!(await getOwnerServiceStatus(ownerId)).active) {
    throw fail(403, 'Your subscription has ended. Renew it or switch to commission first.', 'OWNER_STOPPED');
  }
  if (driver.approve === false) throw fail(409, 'This driver is not approved yet', 'DRIVER_NOT_APPROVED');
  if (driver.shareRideDisabled) throw fail(409, 'Share rides are switched off for this driver', 'SHARE_DISABLED_FOR_DRIVER');
  if (isBikeDriver(driver)) throw fail(409, 'Share rides are not available for bike drivers', 'NOT_SHARE_VEHICLE');
  if (await activeTripOf(driver._id)) throw fail(409, 'This driver already has a share trip running', 'TRIP_ALREADY_ACTIVE');
  const trip = await createTripFor({
    driver, createdBy: 'owner', seatsTotal,
    origin: toPlace(origin, 'origin'), destination: toPlace(destination, 'destination'),
  });
  // The driver need not be online or have the app open: tell them.
  tellDriverTrip(driver._id, trip._id, 'open', 'assigned');
  pushDriver(
    driver._id, 'New share trip',
    `Your owner created a share trip: ${trip.origin.address || 'start'} to ${trip.destination.address || 'destination'}`,
    { type: 'share_trip_assigned', tripId: idOf(trip._id) },
  );
  return serializeTrip(trip);
};

const announceTripClosed = (trip, status, by) => {
  tellDriverTrip(trip.driverId, trip._id, status, by);
  pushDriver(
    trip.driverId, 'Share trip cancelled',
    by === 'owner' ? 'Your owner cancelled the share trip.' : 'Your share trip was cancelled.',
    { type: 'share_trip_cancelled', tripId: idOf(trip._id), by },
  );
};

export const ownerCancelTrip = async ({ ownerId, tripId }) => {
  const trip = await closeTrip({ filter: { _id: tripId, ownerId }, status: 'cancelled' });
  announceTripClosed(trip, 'cancelled', 'owner');
  return serializeTrip(trip);
};

export const ownerSetDriverEnabled = async ({ ownerId, driverId, enabled }) => {
  const driver = await fleetDriver(ownerId, driverId);
  driver.shareRideDisabled = !enabled;
  await driver.save({ validateModifiedOnly: true });

  const state = await providerState(driver);
  emitToDriver(idOf(driver._id), 'share:status:changed', { eligible: state.eligible, code: state.code, enabled: Boolean(enabled) });
  pushDriver(
    driver._id,
    enabled ? 'Share rides turned on by your owner' : 'Share rides turned off by your owner',
    enabled ? 'You can take share rides again.' : 'You will not get new share ride requests.',
    { type: 'share_enabled_changed', enabled: String(Boolean(enabled)) },
  );
  // An empty trip is pointless once share is off; one with riders on board is left to finish.
  if (!enabled) {
    closeOffersForDriver(driver._id);
    const closed = await ShareTrip.findOneAndUpdate(
      { driverId: driver._id, status: { $in: ACTIVE_TRIP_STATUSES }, seatsTaken: 0 },
      { $set: { status: 'cancelled', completedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (closed) announceTripClosed(closed, 'cancelled', 'owner');
  }
  return { id: idOf(driver._id), shareEnabled: !driver.shareRideDisabled };
};

// The owner's plan ended or came back: tell every fleet driver so an open share screen updates at once.
export const notifyFleetShareStatus = async (ownerId) => {
  const drivers = await Driver.find({ owner_id: ownerId, deletedAt: null }).limit(500);
  for (const driver of drivers) {
    const state = await providerState(driver);
    emitToDriver(idOf(driver._id), 'share:status:changed', { eligible: state.eligible, code: state.code, enabled: !driver.shareRideDisabled });
    if (!state.eligible) closeOffersForDriver(driver._id);
  }
};

// The driver's own share-ride history, newest first (a share ride lives in ShareRide, not Ride).
export const listDriverShareRides = async (driverId, { status = 'finished', page = 1, limit = 20 } = {}) => {
  await expireStale({ driverId });
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const wanted = text(status).toLowerCase();
  const statuses = wanted === 'active' ? ACTIVE_RIDE_STATUSES
    : ['completed', 'cancelled', 'expired'].includes(wanted) ? [wanted]
      : ['completed', 'cancelled', 'expired'];
  const match = { driverId: new mongoose.Types.ObjectId(String(driverId)), status: { $in: statuses } };
  const [rows, total] = await Promise.all([
    ShareRide.aggregate([
      { $match: match },
      { $addFields: { sortAt: { $ifNull: ['$completedAt', { $ifNull: ['$cancelledAt', '$createdAt'] }] } } },
      { $sort: { sortAt: -1, _id: -1 } },
      { $skip: (safePage - 1) * safeLimit },
      { $limit: safeLimit },
    ]),
    ShareRide.countDocuments(match),
  ]);
  return {
    results: rows.map((ride) => serializeRide(ride, 'driver')),
    pagination: { page: safePage, limit: safeLimit, total, hasMore: safePage * safeLimit < total },
  };
};

// -------------------------------------------------------------- admin side

async function pagedRides(base, { status = '', search = '', page = 1, limit = 30 } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  const filter = { ...base };
  if (status === 'active') filter.status = { $in: ACTIVE_RIDE_STATUSES };
  else if (status) filter.status = status;
  const term = text(search);
  if (term) {
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { 'passenger.name': pattern }, { 'passenger.phone': pattern }, { 'driverSnapshot.name': pattern },
      { 'driverSnapshot.phone': pattern }, { 'vehicleSnapshot.number': pattern },
    ];
  }
  const [rows, total] = await Promise.all([
    ShareRide.find(filter).sort({ createdAt: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit),
    ShareRide.countDocuments(filter),
  ]);
  return {
    results: rows.map((ride) => serializeRide(ride, 'admin')),
    paginator: { current_page: safePage, per_page: safeLimit, total, last_page: Math.max(1, Math.ceil(total / safeLimit)) },
  };
}

export const adminRides = (query) => pagedRides({}, query);

export const adminTrips = async ({ status = '', page = 1, limit = 30 } = {}) => {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  const filter = {};
  if (status === 'active') filter.status = { $in: ACTIVE_TRIP_STATUSES };
  else if (status) filter.status = status;
  const [rows, total] = await Promise.all([
    ShareTrip.find(filter).sort({ createdAt: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit),
    ShareTrip.countDocuments(filter),
  ]);
  const drivers = new Map(
    (await Driver.find({ _id: { $in: rows.map((t) => t.driverId) } }).select('name phone owner_id').lean()).map((d) => [idOf(d._id), d]),
  );
  return {
    results: rows.map((trip) => ({ ...serializeTrip(trip), driver: drivers.get(idOf(trip.driverId)) || null })),
    paginator: { current_page: safePage, per_page: safeLimit, total, last_page: Math.max(1, Math.ceil(total / safeLimit)) },
  };
};

export const adminOverview = async () => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const [totals, today, activeTrips, searching, onBoard, walletPending, cancelled] = await Promise.all([
    earningsTotals({}),
    earningsTotals({ completedAt: { $gte: startOfToday } }),
    ShareTrip.countDocuments({ status: { $in: ACTIVE_TRIP_STATUSES } }),
    ShareRide.countDocuments({ status: 'searching', expiresAt: { $gt: new Date() } }),
    ShareRide.countDocuments({ status: { $in: ['accepted', 'ongoing'] } }),
    ShareRide.countDocuments({ status: 'completed', 'settlement.walletStatus': 'pending' }),
    ShareRide.countDocuments({ status: 'cancelled' }),
  ]);
  return { totals, today, activeTrips, searching, onBoard, walletPending, cancelled };
};
