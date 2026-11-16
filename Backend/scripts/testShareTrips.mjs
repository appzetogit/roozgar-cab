// Running share trips riders can browse and join, and the driver's "publish trip", against a THROWAWAY Mongo.
//   SHARE_TRIPS_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testShareTrips.mjs
// Drops its own database (share_trips_test) when done. Never point it at production.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.SHARE_TRIPS_TEST_MONGODB_URI;
if (!uri) throw new Error('Set SHARE_TRIPS_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB_NAME: 'share_trips_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test', SHARE_TRIP_IDLE_MINUTES: '120' });

const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) =>
  String(url).startsWith('http://127.0.0.1') ? realFetch(url, ...rest) : Promise.reject(new Error('offline in test'));

const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/modules/taxi/services/tokenService.js');
const svc = await import('../src/modules/taxi/shareRide/services/shareRideService.js');
const { ShareRide } = await import('../src/modules/taxi/shareRide/models/ShareRide.js');
const { ShareTrip } = await import('../src/modules/taxi/shareRide/models/ShareTrip.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { DriverSubscription } = await import('../src/modules/taxi/driver/models/DriverSubscription.js');
const { User } = await import('../src/modules/taxi/user/models/User.js');
const { Owner } = await import('../src/modules/taxi/admin/models/Owner.js');
const { OwnerSubscription } = await import('../src/modules/taxi/admin/models/OwnerSubscription.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');

await mongoose.connect(uri, { dbName: 'share_trips_test' });
await mongoose.connection.dropDatabase();
await Promise.all([Driver.init(), ShareRide.init(), ShareTrip.init()]);

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (method, path, token, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const tokenFor = (id, role) => signAccessToken({ sub: String(id), role });
const failsWith = async (promise, status, code, label) => {
  try { await promise; } catch (error) {
    assert.equal(error.statusCode ?? error.status, status, `${label}: ${error.message}`);
    if (code) assert.equal(error.code, code, `${label}: code`);
    return error;
  }
  return assert.fail(`${label}: expected ${status}`);
};
const oid = () => new mongoose.Types.ObjectId();
const ago = (minutes) => new Date(Date.now() - minutes * 60e3);

const RAJWADA = [75.8553, 22.7183];
const VIJAY_NAGAR = [75.8937, 22.7533];
const DEWAS = [76.0534, 22.9676];
const MIDWAY = [75.95, 22.84];
const MUMBAI = [72.8777, 19.076];
const WEST = [RAJWADA[0] - 0.1, RAJWADA[1]];
const place = (c, address = 'x') => ({ lat: c[1], lng: c[0], address });
const body = (pickup, drop, seats = 1, extra = {}) => ({ pickup: place(pickup, 'p'), drop: place(drop, 'd'), seats, ...extra });

const carType = (await Vehicle.collection.insertOne({ name: 'Sedan', icon_types: 'car', capacity: 4, transport_type: 'taxi', active: true, status: 1 })).insertedId;
const deps = {
  loadRoute: async () => ({ distanceMeters: 20000 }),
  loadTariffs: async () => ({ tariffs: [{ type_id: String(carType), vehicle_type_name: 'Sedan', base_price: 60, base_distance: 2, price_per_distance: 14, rider_platform_fee: 5, rider_platform_fee_type: 'percentage' }] }),
};
const mkUser = (n) => User.create({ name: `Rider ${n}`, phone: `90000002${10 + n}`, city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
const mkDriver = (n, extra = {}) => Driver.create({
  name: `Driver ${n}`, phone: `91000002${10 + n}`, password: 'x-test-pass', approve: true, status: 'approved', isOnline: true,
  vehicleType: 'car', vehicleTypeId: carType, vehicleTypeIds: [carType], vehicleNumber: `MH12ST${n}${n}${n}`, vehicleColor: 'white',
  location: { type: 'Point', coordinates: RAJWADA }, locationUpdatedAt: new Date(), ...extra,
});
const addPass = (driverId) => DriverSubscription.collection.insertOne({
  driverId, planId: oid(), planName: 'Day', amount: 50, vehicleClasses: ['car'], startsAt: ago(60),
  expiresAt: new Date(Date.now() + 24 * 3600e3), status: 'active', paymentMethod: 'wallet', paidAt: new Date(), tripsCovered: 0, commissionWaived: 0,
});
const finish = async (driverId, rideId) => {
  await svc.verifyPickup({ driverId, rideId, otp: (await ShareRide.findById(rideId)).otp });
  return svc.completeShareRide({ driverId, rideId });
};
const users = await Promise.all([1, 2, 3, 4, 5, 6].map(mkUser));

// ---- publish: rules
const noPass = await mkDriver(1);
await failsWith(svc.publishTrip({ driverId: noPass._id, origin: place(RAJWADA), destination: place(DEWAS) }), 403, 'SUBSCRIPTION_REQUIRED', 'a solo driver needs a pass');
const offline = await mkDriver(2, { isOnline: false });
await addPass(offline._id);
await failsWith(svc.publishTrip({ driverId: offline._id, origin: place(RAJWADA), destination: place(DEWAS) }), 403, 'GO_ONLINE_REQUIRED', 'offline driver');

const d1 = await mkDriver(3);
await addPass(d1._id);
await failsWith(svc.publishTrip({ driverId: d1._id, origin: place(RAJWADA), destination: place(RAJWADA) }), 400, 'ROUTE_TOO_SHORT', 'start = end');
await failsWith(svc.publishTrip({ driverId: d1._id, origin: { lat: 'x' }, destination: place(DEWAS) }), 400, 'INVALID_LOCATION', 'bad location');
const published = await svc.publishTrip({ driverId: d1._id, origin: place(RAJWADA, 'Indore'), destination: place(DEWAS, 'Dewas'), seatsTotal: 3 });
assert.equal(published.published, true);
assert.equal(published.status, 'open');
assert.equal(published.seatsTotal, 3);
assert.equal(published.seatsFree, 3);
await failsWith(svc.publishTrip({ driverId: d1._id, origin: place(RAJWADA), destination: place(DEWAS) }), 409, 'TRIP_ALREADY_ACTIVE', 'one trip at a time');

// ---- the list every rider sees
let list = await svc.listOpenTripsForRider({}, deps);
assert.equal(list.count, 1);
const card = list.trips[0];
assert.equal(card.id, published.id);
assert.equal(card.seatsFree, 3);
assert.equal(card.driver.name, 'Driver 3');
assert.equal(card.origin.address, 'Indore');
assert.ok(card.perSeat > 0, 'list card carries a price per seat');
assert.equal(card.vehicle.number, 'MH12ST333');
assert.ok(!('phone' in card.driver) && !('riders' in card) && !('stats' in card), 'no private data in the list');
assert.equal((await svc.listOpenTripsForRider({ pickupLat: MUMBAI[1], pickupLng: MUMBAI[0] }, deps)).count, 0, 'far from the route: not listed');
assert.equal((await svc.listOpenTripsForRider({ pickupLat: VIJAY_NAGAR[1], pickupLng: VIJAY_NAGAR[0] }, deps)).count, 1, 'near the route: listed');
assert.equal((await svc.listOpenTripsForRider({ pickupLat: RAJWADA[1], pickupLng: RAJWADA[0], dropLat: DEWAS[1], dropLng: DEWAS[0] }, deps)).count, 1, 'same route');
assert.equal((await svc.listOpenTripsForRider({ pickupLat: RAJWADA[1], pickupLng: RAJWADA[0], dropLat: WEST[1], dropLng: WEST[0] }, deps)).count, 0, 'another route');
assert.equal((await svc.listOpenTripsForRider({ vehicleTypeId: String(oid()) }, deps)).count, 0, 'other vehicle type');

// ---- the detail: seats and price for 1..free seats
const detail = await svc.getOpenTripForRider(published.id, {}, deps);
assert.equal(detail.canJoin, true);
assert.deepEqual(detail.seatOptions.map((o) => o.seats), [1, 2, 3]);
assert.ok(detail.seatOptions[2].total > detail.seatOptions[0].total, 'more seats cost more');
assert.equal(detail.seatOptions[1].subtotal, detail.seatOptions[0].perSeat * 2);
const offRoute = await svc.getOpenTripForRider(published.id, { pickupLat: WEST[1], pickupLng: WEST[0] }, deps);
assert.equal(offRoute.canJoin, false);
assert.equal(offRoute.code, 'NOT_ON_ROUTE');
await failsWith(svc.getOpenTripForRider(String(oid()), {}, deps), 404, 'TRIP_NOT_AVAILABLE', 'unknown trip');
await failsWith(svc.getOpenTripForRider('not-an-id', {}, deps), 404, 'TRIP_NOT_AVAILABLE', 'bad id');

// ---- booking a picked trip: only that driver is asked
const bystander = await mkDriver(4);
await addPass(bystander._id);
const booked = await svc.createShareRide({ user: users[0], body: { tripId: published.id, seats: 2 }, deps });
assert.equal(booked.requestedTripId, published.id);
assert.equal(booked.seats, 2);
assert.equal(booked.pickup.address, 'Indore', 'pickup defaults to the trip start');
const stored = await ShareRide.findById(booked.id);
assert.equal(String(stored.requestedDriverId), String(d1._id));
const told = await svc.notifyNewRequest(stored);
assert.deepEqual(told, [String(d1._id)], 'only the trip driver is offered the request');
assert.equal((await svc.listRequestsForDriver(bystander._id)).requests.length, 0, 'other drivers do not see it');
assert.equal((await svc.listRequestsForDriver(d1._id)).requests.length, 1, 'the trip driver does');
await failsWith(svc.acceptShareRequest({ driverId: bystander._id, rideId: booked.id }), 409, 'REQUEST_TAKEN', 'someone else cannot take it');

// seats and route are checked at booking
const accepted = await svc.acceptShareRequest({ driverId: d1._id, rideId: booked.id });
assert.equal(accepted.trip.seatsTaken, 2);
assert.equal(accepted.trip.id, published.id, 'the rider joined the published trip');
await failsWith(svc.createShareRide({ user: users[1], body: { tripId: published.id, seats: 2 }, deps }), 409, 'NO_FREE_SEATS', 'only one seat is left');
await failsWith(svc.createShareRide({ user: users[1], body: body(WEST, RAJWADA, 1, { tripId: published.id }), deps }), 409, 'NOT_ON_ROUTE', 'off the trip route');
await failsWith(svc.createShareRide({ user: users[1], body: { tripId: String(oid()), seats: 1 }, deps }), 404, 'TRIP_NOT_AVAILABLE', 'unknown trip');
assert.equal(await ShareRide.countDocuments({ userId: users[1]._id }), 0, 'refused bookings leave nothing behind');
assert.equal((await svc.getOpenTripForRider(published.id, {}, deps)).seatsFree, 1, 'the card shows the seat count live');

// ---- a trip already moving: a pickup the cab has passed is refused
await svc.verifyPickup({ driverId: d1._id, rideId: booked.id, otp: stored.otp });
assert.equal((await ShareTrip.findById(published.id)).status, 'running');
await Driver.updateOne({ _id: d1._id }, { $set: { location: { type: 'Point', coordinates: MIDWAY } } });
await failsWith(svc.createShareRide({ user: users[1], body: { tripId: published.id, seats: 1 }, deps }), 409, 'PICKUP_PASSED', 'the cab is past the start');
assert.equal((await svc.getOpenTripForRider(published.id, {}, deps)).code, 'PICKUP_PASSED');
const ahead = await svc.createShareRide({ user: users[1], body: body(MIDWAY, DEWAS, 1, { tripId: published.id }), deps });
assert.equal(ahead.requestedTripId, published.id, 'a pickup ahead of the cab is fine');
await svc.cancelByRider({ userId: users[1]._id, rideId: ahead.id });

// ---- a published trip is not closed when its last rider is dropped
await svc.completeShareRide({ driverId: d1._id, rideId: booked.id });
let after = await ShareTrip.findById(published.id);
assert.equal(after.seatsTaken, 0);
assert.ok(['open', 'running'].includes(after.status), 'published trip stays open for the next rider');
assert.equal((await svc.listOpenTripsForRider({}, deps)).count, 1);

// ---- the driver says no: the rider is told at once, not left waiting
await Driver.updateOne({ _id: d1._id }, { $set: { location: { type: 'Point', coordinates: RAJWADA } } }); // back at the start
const declined = await svc.createShareRide({ user: users[2], body: { tripId: published.id, seats: 1 }, deps });
await svc.rejectShareRequest({ driverId: d1._id, rideId: declined.id });
const declinedRow = await ShareRide.findById(declined.id);
assert.equal(declinedRow.status, 'cancelled');
assert.equal(declinedRow.cancelledBy, 'driver');
const bookedAgain = await svc.createShareRide({ user: users[2], body: { tripId: published.id, seats: 1 }, deps });
assert.equal(bookedAgain.status, 'searching', 'the rider can ask again');

// ---- the driver closes the trip: pending asks end with a clear reason
await svc.cancelTrip({ driverId: d1._id, tripId: published.id });
const closedAsk = await ShareRide.findById(bookedAgain.id);
assert.equal(closedAsk.status, 'cancelled');
assert.equal(closedAsk.cancelledBy, 'system');
assert.match(closedAsk.cancelReason, /no longer running/);
assert.equal((await svc.listOpenTripsForRider({}, deps)).count, 0);
await failsWith(svc.createShareRide({ user: users[2], body: { tripId: published.id, seats: 1 }, deps }), 404, 'TRIP_NOT_AVAILABLE', 'a closed trip cannot be joined');

// ---- the idle cleanup also closes the asks of an expired trip; a pending ask keeps an empty trip alive
const d5 = await mkDriver(5);
await addPass(d5._id);
const idle = await svc.publishTrip({ driverId: d5._id, origin: place(RAJWADA), destination: place(DEWAS) });
await ShareTrip.updateOne({ _id: idle.id }, { $set: { lastActivityAt: ago(500) } });
const keep = await svc.createShareRide({ user: users[3], body: { tripId: idle.id, seats: 1 }, deps });
assert.equal((await svc.runShareCleanup()).idleTripsClosed, 0, 'a waiting ask is activity');
await ShareTrip.updateOne({ _id: idle.id }, { $set: { lastActivityAt: ago(500) } });
await ShareRide.updateOne({ _id: keep.id }, { $set: { status: 'cancelled' } });
assert.equal((await svc.runShareCleanup()).idleTripsClosed, 1, 'then the empty trip expires');

// ---- an offline driver's empty trip is hidden; one with riders on board stays
const d6 = await mkDriver(6);
await addPass(d6._id);
const t6 = await svc.publishTrip({ driverId: d6._id, origin: place(RAJWADA), destination: place(DEWAS) });
assert.equal((await svc.listOpenTripsForRider({}, deps)).count, 1);
await Driver.updateOne({ _id: d6._id }, { $set: { isOnline: false } });
assert.equal((await svc.listOpenTripsForRider({}, deps)).count, 0, 'stale empty trip hidden');
await failsWith(svc.createShareRide({ user: users[4], body: { tripId: t6.id, seats: 1 }, deps }), 409, 'TRIP_NOT_AVAILABLE', 'offline driver cannot be asked');
await Driver.updateOne({ _id: d6._id }, { $set: { isOnline: true } });

// ---- an owner's trip is listed too; a fleet driver whose owner stopped is not
const owner = await Owner.create({ name: 'Owner', company_name: 'Fleet', mobile: '9200000290', email: 'o290@example.com', password: 'x-test-pass', approve: true, status: 'approved' });
await OwnerSubscription.collection.insertOne({ ownerId: owner._id, planName: 'Fleet', amount: 1000, startsAt: ago(60), expiresAt: new Date(Date.now() + 864e5), status: 'active', paymentMethod: 'admin', paidAt: new Date(), tripsCovered: 0, commissionWaived: 0 });
const fleet = await mkDriver(7, { owner_id: owner._id });
await svc.ownerCreateTrip({ ownerId: owner._id, driverId: fleet._id, origin: place(RAJWADA, 'Indore'), destination: place(DEWAS, 'Dewas'), seatsTotal: 2 });
assert.equal((await svc.listOpenTripsForRider({}, deps)).count, 2);
await OwnerSubscription.updateMany({ ownerId: owner._id }, { $set: { expiresAt: ago(5) } });
assert.equal((await svc.listOpenTripsForRider({}, deps)).count, 1, 'owner service stopped: trip not shown');

// ---- HTTP: routes, auth, and the id-versus-"trips" route order
const userToken = tokenFor(users[5]._id, 'user');
const driverToken = tokenFor(d6._id, 'driver');
assert.equal((await call('GET', '/users/share-rides/trips')).status, 401);
const httpList = await call('GET', '/users/share-rides/trips', userToken);
assert.equal(httpList.status, 200);
assert.equal(httpList.body.data.count, 1);
const httpDetail = await call('GET', `/users/share-rides/trips/${t6.id}`, userToken);
assert.equal(httpDetail.status, 200);
assert.equal(httpDetail.body.data.id, t6.id);
assert.equal((await call('GET', `/users/share-rides/trips/${oid()}`, userToken)).status, 404);
assert.equal((await call('GET', '/users/share-rides', userToken)).status, 200, 'the rider ride list still works');
assert.equal((await call('POST', '/drivers/share/trips', userToken, {})).status, 403, 'a rider cannot publish');
await svc.cancelTrip({ driverId: d6._id, tripId: t6.id });
const viaHttp = await call('POST', '/drivers/share/trips', driverToken, { origin: place(RAJWADA), destination: place(DEWAS), seatsTotal: 2, driverId: String(oid()) });
assert.equal(viaHttp.status, 201, JSON.stringify(viaHttp.body));
assert.equal(viaHttp.body.data.driverId, String(d6._id), 'the driver id comes from the token, never the body');
assert.equal(viaHttp.body.data.seatsTotal, 2);

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('share trips: all checks passed');
process.exit(0);
