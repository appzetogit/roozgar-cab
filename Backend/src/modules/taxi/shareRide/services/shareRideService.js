import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { Driver } from '../../driver/models/Driver.js';
import { DriverSubscription } from '../../driver/models/DriverSubscription.js';
import { Vehicle } from '../../admin/models/Vehicle.js';
import { Ride } from '../../user/models/Ride.js';
import { RIDE_STATUS } from '../../constants/index.js';
import { ShareTrip, ACTIVE_TRIP_STATUSES } from '../models/ShareTrip.js';
import { ShareRide, ACTIVE_RIDE_STATUSES } from '../models/ShareRide.js';
import { quoteShareFare } from './shareRideFare.js';
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

// ----------------------------------------------------------------- helpers

export const toPlace = (input, label) => {
  const lat = Number(input?.lat ?? input?.latitude);
  const lng = Number(input?.lng ?? input?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new ApiError(400, `A valid ${label} location is required`);
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

const notifyDriver = (driverId, ride, title, body, type) => {
  if (!driverId) return;
  emitToDriver(idOf(driverId), 'share:ride:updated', { rideId: idOf(ride._id), status: ride.status, type });
  sendPushNotificationToEntities({
    driverIds: [idOf(driverId)], title, body, data: { type, rideId: idOf(ride._id) },
  }).catch((error) => console.error('share ride push to driver failed', error?.message || error));
};

// A request nobody picked up in time stops being offered. Done lazily, where it is read.
const expireStale = (filter = {}) =>
  ShareRide.updateMany(
    { ...filter, status: 'searching', expiresAt: { $lte: new Date() } },
    { $set: { status: 'expired', cancelledAt: new Date(), cancelledBy: 'system' } },
  );

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
  stats: trip.stats,
  riders: rides.map((ride) => serializeRide(ride, 'driver')),
});

// -------------------------------------------------------------- rider side

const parseRideInput = (body = {}) => ({
  pickup: toPlace(body.pickup, 'pickup'),
  drop: toPlace(body.drop, 'drop'),
  seats: Math.round(Number(body.seats) || 1),
});

export const quoteForRider = async (body) => {
  const { pickup, drop, seats } = parseRideInput(body);
  return quoteShareFare({ pickup: coordsOf(pickup), drop: coordsOf(drop), seats });
};

export const createShareRide = async ({ user, body, deps = null }) => {
  const { pickup, drop, seats } = parseRideInput(body);
  if (seats < 1 || seats > 4) throw new ApiError(400, 'You can book 1 to 4 seats');

  // The fare is always the server's: whatever the app sent is ignored.
  const quote = await quoteShareFare({ pickup: coordsOf(pickup), drop: coordsOf(drop), seats }, deps);
  if (!quote.available) throw new ApiError(422, quote.reason);

  await expireStale({ userId: user._id });

  let ride;
  try {
    ride = await ShareRide.create({
      userId: user._id,
      passenger: { name: text(user.name), phone: text(user.phone) },
      pickup,
      drop,
      seats: quote.seats,
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
    if (error?.code === 11000) throw new ApiError(409, 'You already have a share ride in progress');
    throw error;
  }

  notifyNewRequest(ride).catch((error) => console.error('share request fan-out failed', error?.message || error));
  return serializeRide(ride, 'user');
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
  if (!ride) throw new ApiError(404, 'Share ride not found');
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
    throw new ApiError(exists ? 409 : 404, exists ? 'This ride can no longer be cancelled' : 'Share ride not found');
  }
  if (before.status === 'accepted' && before.tripId) {
    await ShareTrip.updateOne({ _id: before.tripId }, { $inc: { seatsTaken: -before.seats } });
    notifyDriver(before.driverId, before, 'Rider cancelled', 'The rider cancelled this share ride.', 'share_cancelled');
  }
  return serializeRide(await ShareRide.findById(rideId), 'user');
};

// ------------------------------------------------------------- driver side

const vehicleCapacity = async (driver) => {
  const vehicle = driver.vehicleTypeId ? await Vehicle.findById(driver.vehicleTypeId).select('capacity name').lean() : null;
  return Number(vehicle?.capacity) > 0 ? Number(vehicle.capacity) : 4;
};

const currentNormalRide = (driverId) =>
  Ride.findOne({ driverId, status: { $in: [RIDE_STATUS.ACCEPTED, RIDE_STATUS.ONGOING] } })
    .select('pickupLocation dropLocation pickupAddress dropAddress')
    .lean();

const activeTripOf = (driverId) => ShareTrip.findOne({ driverId, status: { $in: ACTIVE_TRIP_STATUSES } });

// Why a driver cannot take share rides right now, or '' if they can.
const providerBlocker = async (driver) => {
  if (!driver) return 'Driver not found';
  if (driver.approve === false) return 'Your account is waiting for approval';
  if (driver.shareRideDisabled) return 'Share rides are switched off for you by your owner';
  if (driver.vehicleType !== 'car') return 'Share rides are for car drivers';
  if (!(await getActiveDriverSubscription(driver._id))) return 'Buy a pass to take share rides';
  return '';
};

const assertProvider = async (driverId) => {
  const driver = await Driver.findOne({ _id: driverId, deletedAt: null });
  const blocker = await providerBlocker(driver);
  if (blocker) {
    throw Object.assign(new ApiError(403, blocker), {
      code: blocker.startsWith('Buy a pass') ? 'SUBSCRIPTION_REQUIRED' : 'SHARE_NOT_ALLOWED',
    });
  }
  return driver;
};

export const getDriverShareStatus = async (driverId) => {
  const driver = await Driver.findOne({ _id: driverId, deletedAt: null });
  const reason = await providerBlocker(driver);
  const [trip, normal] = await Promise.all([
    driver ? activeTripOf(driverId) : null,
    driver ? currentNormalRide(driverId) : null,
  ]);
  return {
    eligible: !reason,
    reason,
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
  const driver = await Driver.findOne({ _id: driverId, deletedAt: null });
  const reason = await providerBlocker(driver);
  if (reason) return { eligible: false, reason, source: 'none', seatsFree: 0, requests: [] };

  const route = await routeFor(driver);
  const base = { status: 'searching', expiresAt: { $gt: new Date() }, declinedBy: { $ne: driver._id } };
  let requests = [];

  if (route.kind === 'idle') {
    if (driver.location?.coordinates?.length === 2) {
      const near = await ShareRide.find({
        ...base,
        'pickup.location': { $nearSphere: { $geometry: driver.location, $maxDistance: IDLE_RADIUS_KM * 1000 } },
      }).limit(30);
      requests = near
        .filter((ride) => ride.seats <= route.seatsFree)
        .map((ride) => ({
          ride,
          fit: { pickupAwayKm: Math.round(haversineKm(driver.location.coordinates, coordsOf(ride.pickup)) * 10) / 10 },
        }));
    }
  } else {
    const box = routeBox({ origin: route.origin, destination: route.destination });
    const candidates = await ShareRide.find({ ...base, 'pickup.location': { $geoWithin: { $box: box } } }).limit(100);
    requests = candidates
      .map((ride) => ({
        ride,
        fit: corridorFit({ origin: route.origin, destination: route.destination, pickup: coordsOf(ride.pickup), drop: coordsOf(ride.drop) }),
      }))
      .filter(({ ride, fit }) => fit.fits && ride.seats <= route.seatsFree);
  }

  return {
    eligible: true,
    reason: '',
    source: route.kind, // trip | ride | idle
    seatsFree: route.seatsFree,
    corridorKm: CORRIDOR_KM,
    requests: requests.map(({ ride, fit }) => ({ ...serializeRide(ride, 'driver'), fit })),
  };
};

const createTripFor = async ({ driver, origin, destination, baseRideId = null, createdBy = 'driver', reservedSeats = 0, seatsTotal = null }) => {
  const capacity = await vehicleCapacity(driver);
  const maxSeats = Math.min(6, capacity - 1 - reservedSeats);
  if (maxSeats < 1) throw new ApiError(409, 'This vehicle has no free seat to share');
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
  if (!ride || ride.status !== 'searching' || ride.expiresAt <= now) {
    throw new ApiError(409, 'This request is no longer available');
  }
  if (ride.declinedBy.some((id) => sameId(id, driver._id))) throw new ApiError(409, 'You handed this rider back earlier');

  const rider = { pickup: coordsOf(ride.pickup), drop: coordsOf(ride.drop) };
  let trip = tripId ? await ShareTrip.findOne({ _id: tripId, driverId, status: { $in: ACTIVE_TRIP_STATUSES } }) : await activeTripOf(driverId);
  if (tripId && !trip) throw new ApiError(404, 'Trip not found');

  if (trip) {
    const fit = corridorFit({ origin: coordsOf(trip.origin), destination: coordsOf(trip.destination), ...rider });
    if (!fit.fits) throw new ApiError(409, 'This rider is not on your route');
  } else {
    const normal = await currentNormalRide(driverId);
    if (normal?.pickupLocation?.coordinates && normal?.dropLocation?.coordinates) {
      const fit = corridorFit({ origin: normal.pickupLocation.coordinates, destination: normal.dropLocation.coordinates, ...rider });
      if (!fit.fits) throw new ApiError(409, 'This rider is not on the route of your current ride');
      trip = await createTripFor({
        driver, baseRideId: normal._id, reservedSeats: 1,
        origin: { address: normal.pickupAddress || '', location: { type: 'Point', coordinates: normal.pickupLocation.coordinates } },
        destination: { address: normal.dropAddress || '', location: { type: 'Point', coordinates: normal.dropLocation.coordinates } },
      });
    } else {
      trip = await createTripFor({
        driver,
        origin: { address: '', location: { type: 'Point', coordinates: driver.location?.coordinates?.length === 2 ? driver.location.coordinates : rider.pickup } },
        destination: ride.drop,
      });
    }
  }

  // Claim the seats first, then the rider; each is one atomic update.
  const claimed = await ShareTrip.findOneAndUpdate(
    { _id: trip._id, status: { $in: ACTIVE_TRIP_STATUSES }, $expr: { $lte: [{ $add: ['$seatsTaken', ride.seats] }, '$seatsTotal'] } },
    { $inc: { seatsTaken: ride.seats } },
    { returnDocument: 'after' },
  );
  if (!claimed) throw new ApiError(409, 'Not enough free seats on your trip');

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
    await ShareTrip.updateOne({ _id: trip._id }, { $inc: { seatsTaken: -ride.seats } });
    throw new ApiError(409, 'Another driver just took this request');
  }

  notifyUser(accepted, 'Share ride confirmed', `${driver.name || 'Your driver'} is coming to pick you up. Share your OTP at pickup.`, 'share_accepted');
  return { ride: serializeRide(accepted, 'driver'), trip: serializeTrip(claimed, [accepted]) };
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
    if (!current) throw new ApiError(409, 'This rider is not waiting for pickup');
    if (current.otpAttempts >= MAX_OTP_ATTEMPTS) throw new ApiError(429, 'Too many wrong OTPs. Ask the rider to cancel and book again');
    throw new ApiError(400, 'Wrong OTP');
  }
  await ShareTrip.updateOne({ _id: ride.tripId, status: 'open' }, { $set: { status: 'running', startedAt: new Date() } });
  notifyUser(ride, 'Share ride started', 'Your ride has started. Have a safe trip!', 'share_started');
  return serializeRide(ride, 'driver');
};

export const releaseRider = async ({ driverId, rideId }) => {
  const before = await ShareRide.findOneAndUpdate(
    { _id: rideId, driverId, status: 'accepted' },
    {
      $set: {
        status: 'searching', tripId: null, driverId: null, ownerId: null, acceptedAt: null, otpAttempts: 0, otp: newOtp(),
        driverSnapshot: {}, vehicleSnapshot: {}, expiresAt: new Date(Date.now() + RELEASE_TTL_MS),
      },
      $addToSet: { declinedBy: driverId },
    },
    { returnDocument: 'before' },
  );
  if (!before) throw new ApiError(409, 'This rider cannot be handed back now');
  await ShareTrip.updateOne({ _id: before.tripId }, { $inc: { seatsTaken: -before.seats } });

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
    Driver.findById(ride.driverId).select('service_location_id').lean(),
    resolveDriverSubscriptionSettings(),
  ]);
  const covering = settings.waiveCommission
    ? await DriverSubscription.findOne({
      driverId: ride.driverId, status: 'active', paidAt: { $ne: null }, startsAt: { $lte: now }, expiresAt: { $gt: now },
    }).lean()
    : null;
  const commissionConfig = await resolveCommissionConfigForRide(
    { vehicleTypeId: trip?.vehicleTypeId, service_location_id: driver?.service_location_id, transport_type: 'taxi', serviceType: 'ride' },
    null,
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
  if (!ride) throw new ApiError(409, 'This ride is not in progress');

  await ShareTrip.updateOne({ _id: ride.tripId }, { $inc: { seatsTaken: -ride.seats } }); // seat is free again

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
  const trip = await activeTripOf(driverId);
  if (!trip) return null;
  const rides = await ShareRide.find({ tripId: trip._id, status: { $in: ['accepted', 'ongoing'] } }).sort({ acceptedAt: 1 });
  return serializeTrip(trip, rides);
};

const closeTrip = async ({ filter, status }) => {
  const trip = await ShareTrip.findOne({ ...filter, status: { $in: ACTIVE_TRIP_STATUSES } });
  if (!trip) throw new ApiError(404, 'Trip not found');
  const pending = await ShareRide.countDocuments({ tripId: trip._id, status: { $in: ['accepted', 'ongoing'] } });
  if (pending) throw new ApiError(409, `${pending} rider${pending > 1 ? 's are' : ' is'} still on this trip`);
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

// Offer a new request to the drivers it can fit: drivers already on a share
// trip or a normal ride along its route, and idle drivers close to the pickup.
// Only car drivers with a pass and share rides switched on are told.
async function notifyNewRequest(ride) {
  const rider = { pickup: coordsOf(ride.pickup), drop: coordsOf(ride.drop) };
  const ids = new Set();

  const trips = await ShareTrip.find({ status: { $in: ACTIVE_TRIP_STATUSES } }).limit(200);
  for (const trip of trips) {
    if (trip.seatsTotal - trip.seatsTaken < ride.seats) continue;
    if (corridorFit({ origin: coordsOf(trip.origin), destination: coordsOf(trip.destination), ...rider }).fits) ids.add(idOf(trip.driverId));
  }
  const normals = await Ride.find({ status: { $in: [RIDE_STATUS.ACCEPTED, RIDE_STATUS.ONGOING] }, driverId: { $ne: null } })
    .select('driverId pickupLocation dropLocation').limit(300).lean();
  for (const normal of normals) {
    if (!normal.pickupLocation?.coordinates || !normal.dropLocation?.coordinates) continue;
    if (corridorFit({ origin: normal.pickupLocation.coordinates, destination: normal.dropLocation.coordinates, ...rider }).fits) ids.add(idOf(normal.driverId));
  }
  const nearby = await Driver.find({
    isOnline: true, vehicleType: 'car', deletedAt: null,
    location: { $nearSphere: { $geometry: ride.pickup.location, $maxDistance: IDLE_RADIUS_KM * 1000 } },
  }).select('_id').limit(MAX_NOTIFIED_DRIVERS).lean();
  nearby.forEach((driver) => ids.add(idOf(driver._id)));
  if (!ids.size) return;

  const subscribed = await DriverSubscription.distinct('driverId', {
    driverId: { $in: [...ids] }, status: 'active', paidAt: { $ne: null }, expiresAt: { $gt: new Date() },
  });
  const allowed = await Driver.find({
    _id: { $in: subscribed }, deletedAt: null, approve: { $ne: false }, shareRideDisabled: { $ne: true }, vehicleType: 'car',
  }).select('_id').limit(MAX_NOTIFIED_DRIVERS).lean();
  const driverIds = allowed.map((driver) => idOf(driver._id));
  if (!driverIds.length) return;

  driverIds.forEach((id) => emitToDriver(id, 'share:request:new', { rideId: idOf(ride._id) }));
  await sendPushNotificationToEntities({
    driverIds,
    title: 'Share ride request',
    body: `${ride.seats} seat${ride.seats > 1 ? 's' : ''} on your way, Rs ${ride.fare}`,
    data: { type: 'share_request', rideId: idOf(ride._id) },
  });
}

// -------------------------------------------------------------- owner side

const fleetDriver = async (ownerId, driverId) => {
  const driver = await Driver.findOne({ _id: driverId, owner_id: ownerId, deletedAt: null });
  if (!driver) throw new ApiError(404, 'This driver is not in your fleet');
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
  if (driver.vehicleType !== 'car') throw new ApiError(409, 'Share rides are for car drivers');
  if (await activeTripOf(driver._id)) throw new ApiError(409, 'This driver already has a share trip running');
  const trip = await createTripFor({
    driver, createdBy: 'owner', seatsTotal,
    origin: toPlace(origin, 'origin'), destination: toPlace(destination, 'destination'),
  });
  return serializeTrip(trip);
};

export const ownerCancelTrip = async ({ ownerId, tripId }) =>
  serializeTrip(await closeTrip({ filter: { _id: tripId, ownerId }, status: 'cancelled' }));

export const ownerSetDriverEnabled = async ({ ownerId, driverId, enabled }) => {
  const driver = await fleetDriver(ownerId, driverId);
  driver.shareRideDisabled = !enabled;
  await driver.save({ validateModifiedOnly: true });
  return { id: idOf(driver._id), shareEnabled: !driver.shareRideDisabled };
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
