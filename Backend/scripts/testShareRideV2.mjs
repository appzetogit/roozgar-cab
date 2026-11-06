// Share Ride backend requirements (trip lifecycle, fleet fan-out, owner notices/validation, cleanup job, stable
// codes, driver history, trip payload), against a THROWAWAY Mongo.
//   SHARE_V2_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testShareRideV2.mjs
// Drops its own database (share_v2_test) when done. Never point it at production.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.SHARE_V2_TEST_MONGODB_URI;
if (!uri) throw new Error('Set SHARE_V2_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB_NAME: 'share_v2_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test', SHARE_TRIP_IDLE_MINUTES: '120' });

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

await mongoose.connect(uri, { dbName: 'share_v2_test' });
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
  assert.fail(`${label}: expected ${status}`);
};
const oid = () => new mongoose.Types.ObjectId();
const ago = (minutes) => new Date(Date.now() - minutes * 60e3);

const RAJWADA = [75.8553, 22.7183];
const VIJAY_NAGAR = [75.8937, 22.7533];
const DEWAS = [76.0534, 22.9676];
const AIRPORT = [75.8011, 22.7217]; // ~5.6 km behind Rajwada: not on the Rajwada->Dewas line
const place = (c, address = 'x') => ({ lat: c[1], lng: c[0], address });
const body = (pickup, drop, seats = 1) => ({ pickup: place(pickup, 'p'), drop: place(drop, 'd'), seats });

const carType = (await Vehicle.collection.insertOne({ name: 'Sedan', icon_types: 'car', capacity: 4, transport_type: 'taxi', active: true, status: 1 })).insertedId;
const deps = {
  loadRoute: async () => ({ distanceMeters: 20000 }),
  loadTariffs: async () => ({ tariffs: [{ type_id: String(carType), vehicle_type_name: 'Sedan', base_price: 60, base_distance: 2, price_per_distance: 14, rider_platform_fee: 5, rider_platform_fee_type: 'percentage' }] }),
};
const mkUser = (n) => User.create({ name: `Rider ${n}`, phone: `90000001${10 + n}`, city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
const mkDriver = (n, extra = {}) => Driver.create({
  name: `Driver ${n}`, phone: `91000001${10 + n}`, password: 'x-test-pass', approve: true, status: 'approved', isOnline: true,
  vehicleType: 'car', vehicleTypeId: carType, vehicleTypeIds: [carType], vehicleNumber: `MH12SV${n}${n}${n}`, vehicleColor: 'white',
  location: { type: 'Point', coordinates: RAJWADA }, locationUpdatedAt: new Date(), ...extra,
});
const addPass = (driverId) => DriverSubscription.collection.insertOne({
  driverId, planId: oid(), planName: 'Day', amount: 50, vehicleClasses: ['car'], startsAt: ago(60),
  expiresAt: new Date(Date.now() + 24 * 3600e3), status: 'active', paymentMethod: 'wallet', paidAt: new Date(), tripsCovered: 0, commissionWaived: 0,
});
const mkOwner = async (n, { plan = true } = {}) => {
  const owner = await Owner.create({ name: `Owner ${n}`, company_name: `Fleet ${n}`, mobile: `92000001${n}0`, email: `o${n}@example.com`, password: 'x-test-pass', approve: true, status: 'approved' });
  if (plan) {
    await OwnerSubscription.collection.insertOne({ ownerId: owner._id, planName: 'Fleet', amount: 1000, startsAt: ago(60), expiresAt: new Date(Date.now() + 864e5), status: 'active', paymentMethod: 'admin', paidAt: new Date(), tripsCovered: 0, commissionWaived: 0 });
  }
  return owner;
};
const finish = async (driverId, rideId) => {
  await svc.verifyPickup({ driverId, rideId, otp: (await ShareRide.findById(rideId)).otp });
  return svc.completeShareRide({ driverId, rideId });
};
const users = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(mkUser));

// ---- T1 / R1.1: the last rider is dropped, a driver-made trip closes by itself
const d1 = await mkDriver(1);
await addPass(d1._id);
const r1 = await svc.createShareRide({ user: users[0], body: body(RAJWADA, DEWAS), deps });
const acc1 = await svc.acceptShareRequest({ driverId: d1._id, rideId: r1.id });
await finish(d1._id, r1.id);
assert.equal((await ShareTrip.findById(acc1.trip.id)).status, 'completed', 'T1: trip completed with the last drop');
assert.equal(await svc.getDriverTrip(d1._id), null);
assert.equal((await svc.getDriverShareStatus(d1._id)).trip, null);
// with another rider still on board it must NOT close
const r1a = await svc.createShareRide({ user: users[0], body: body(RAJWADA, DEWAS), deps });
const r1b = await svc.createShareRide({ user: users[1], body: body(RAJWADA, DEWAS), deps });
await svc.acceptShareRequest({ driverId: d1._id, rideId: r1a.id });
await svc.acceptShareRequest({ driverId: d1._id, rideId: r1b.id });
await finish(d1._id, r1a.id);
assert.equal((await svc.getDriverTrip(d1._id)).status, 'running', 'one rider left: the trip stays');
await finish(d1._id, r1b.id);
assert.equal(await svc.getDriverTrip(d1._id), null, 'the last one closes it');

// ---- R8: trip payload
const ownerA = await mkOwner(1);
const fleet = await mkDriver(2, { owner_id: ownerA._id });
const tripPayload = await svc.ownerCreateTrip({ ownerId: ownerA._id, driverId: fleet._id, origin: place(RAJWADA, 'Indore'), destination: place(DEWAS, 'Dewas'), seatsTotal: 2 });
assert.equal(tripPayload.createdBy, 'owner');
assert.equal(tripPayload.ridersCompleted, 0);
assert.ok(tripPayload.lastActivityAt && tripPayload.createdAt);
assert.ok(new Date(tripPayload.expiresAt).getTime() > Date.now() + 100 * 60e3, 'empty trip: expires in about the idle time');

// ---- T2 / R1.2 + R5: idle empty trip is closed by the job, a trip with a rider is not
await ShareTrip.updateOne({ _id: tripPayload.id }, { $set: { lastActivityAt: ago(150) } });
let outcome = await svc.runShareCleanup();
assert.equal(outcome.idleTripsClosed, 1);
const expired = await ShareTrip.findById(tripPayload.id);
assert.equal(expired.status, 'expired');
assert.equal(await svc.getDriverTrip(fleet._id), null, 'T2: the driver slot is free');
assert.equal((await svc.runShareCleanup()).idleTripsClosed, 0, 'the job is idempotent');
const again = await svc.ownerCreateTrip({ ownerId: ownerA._id, driverId: fleet._id, origin: place(RAJWADA), destination: place(DEWAS), seatsTotal: 2 });
const busy = await svc.createShareRide({ user: users[2], body: body(RAJWADA, DEWAS), deps });
await svc.acceptShareRequest({ driverId: fleet._id, rideId: busy.id });
await ShareTrip.updateOne({ _id: again.id }, { $set: { lastActivityAt: ago(500) } });
assert.equal((await svc.runShareCleanup()).idleTripsClosed, 0, 'a trip with a rider on board is never idle-closed');
assert.equal((await svc.getDriverTrip(fleet._id)).expiresAt, null, 'expiresAt is null once someone is on board');
// legacy trip with no lastActivityAt falls back to updatedAt
await finish(fleet._id, busy.id);
await ShareTrip.collection.updateOne({ _id: new mongoose.Types.ObjectId(again.id) }, { $unset: { lastActivityAt: '' }, $set: { updatedAt: ago(500) } });
assert.equal((await svc.runShareCleanup()).idleTripsClosed, 1, 'old trips without lastActivityAt are closed too');

// ---- T3 / T4: a driver with a route (an empty one too) is offered only riders on THAT route
const d3 = await mkDriver(3, { location: { type: 'Point', coordinates: RAJWADA } });
await addPass(d3._id);
const myRoute = await ShareTrip.create({
  driverId: d3._id, createdBy: 'owner', seatsTotal: 3, seatsTaken: 0, vehicleSnapshot: { type: 'car', number: 'MH12SV333' },
  origin: { address: 'Rajwada', location: { type: 'Point', coordinates: RAJWADA } }, destination: { address: 'Dewas', location: { type: 'Point', coordinates: DEWAS } },
});
const WEST = [RAJWADA[0] - 0.1, RAJWADA[1]]; // about 10 km west of the start: another route
const BEYOND = [DEWAS[0] + 0.06, DEWAS[1] + 0.04]; // about 7 km past Dewas
const onRoute = await svc.createShareRide({ user: users[3], body: body(VIJAY_NAGAR, DEWAS), deps });
const part = await svc.createShareRide({ user: users[4], body: body(RAJWADA, VIJAY_NAGAR), deps }); // a drop in the middle is still the same route
const otherRoute = await svc.createShareRide({ user: users[5], body: body(RAJWADA, WEST), deps }); // A to C
const pastEnd = await svc.createShareRide({ user: users[6], body: body(RAJWADA, BEYOND), deps }); // starts on the route but goes beyond B
const nextDoor = await svc.createShareRide({ user: users[7], body: body(AIRPORT, [AIRPORT[0], AIRPORT[1] + 0.05]), deps }); // 5.6 km from the driver, other direction
const shown = (await svc.listRequestsForDriver(d3._id)).requests.map((x) => x.id);
assert.ok(shown.includes(onRoute.id) && shown.includes(part.id), 'riders on A to B (or part of it) are shown');
assert.ok(!shown.includes(otherRoute.id), 'A to C is not shown');
assert.ok(!shown.includes(pastEnd.id), 'a ride that goes past the driver destination is not shown');
assert.ok(!shown.includes(nextDoor.id), 'T3: an empty trip does not turn into "everyone within 6 km"');
const toldRoute = new Set();
for (const r of [onRoute, part, otherRoute, pastEnd, nextDoor]) {
  if ((await svc.notifyNewRequest(await ShareRide.findById(r.id))).map(String).includes(String(d3._id))) toldRoute.add(r.id);
}
assert.deepEqual([...toldRoute].sort(), [onRoute.id, part.id].sort(), 'the push/socket follow the same rule as the list');
await failsWith(svc.acceptShareRequest({ driverId: d3._id, rideId: otherRoute.id }), 409, 'NOT_ON_ROUTE', 'accepting another route');
await failsWith(svc.acceptShareRequest({ driverId: d3._id, rideId: nextDoor.id }), 409, 'NOT_ON_ROUTE', 'accepting a rider next door');
await svc.acceptShareRequest({ driverId: d3._id, rideId: onRoute.id });
const kept = await ShareTrip.findById(myRoute._id);
assert.equal(kept.seatsTaken, 1);
assert.ok(Math.abs(kept.destination.location.coordinates[1] - DEWAS[1]) < 1e-9, 'the trip line is never rewritten');
// T4: with a rider on board the same rule holds
assert.ok(!(await svc.listRequestsForDriver(d3._id)).requests.some((x) => x.id === otherRoute.id));
for (const r of [onRoute, part, otherRoute, pastEnd, nextDoor]) await svc.cancelByRider({ userId: users[[onRoute, part, otherRoute, pastEnd, nextDoor].indexOf(r) + 3]._id, rideId: r.id });
// the driver can drop an owner route they no longer want, and is then a free driver again
await svc.cancelTrip({ driverId: d3._id, tripId: myRoute._id }).catch(() => null);


// ---- T5 / R2: fleet drivers (owner plan, no pass) are told about requests; a stopped owner's are not
const fleetOn = await mkDriver(4, { owner_id: ownerA._id });
const ownerStopped = await mkOwner(2, { plan: false });
const fleetOff = await mkDriver(5, { owner_id: ownerStopped._id });
const soloNoPass = await mkDriver(6);
const soloPass = await mkDriver(7);
await addPass(soloPass._id);
const wave = await svc.createShareRide({ user: users[5], body: body(RAJWADA, DEWAS), deps });
const told = (await svc.notifyNewRequest(await ShareRide.findById(wave.id))).map(String);
assert.ok(told.includes(String(fleetOn._id)), 'T5: fleet driver on the owner plan is told');
assert.ok(told.includes(String(soloPass._id)));
assert.ok(!told.includes(String(fleetOff._id)), 'a stopped owner fleet is not');
assert.ok(!told.includes(String(soloNoPass._id)), 'a solo driver without a pass is not');
await svc.cancelByRider({ userId: users[5]._id, rideId: wave.id });

// ---- T6 / T7 / T8 / R3 / R4: owner validations, codes, and the effects of switching share off
const unapproved = await mkDriver(8, { owner_id: ownerA._id, approve: false });
await failsWith(svc.ownerCreateTrip({ ownerId: ownerA._id, driverId: unapproved._id, origin: place(RAJWADA), destination: place(DEWAS) }), 409, 'DRIVER_NOT_APPROVED', 'T7 unapproved');
const disabled = await mkDriver(9, { owner_id: ownerA._id, shareRideDisabled: true });
await failsWith(svc.ownerCreateTrip({ ownerId: ownerA._id, driverId: disabled._id, origin: place(RAJWADA), destination: place(DEWAS) }), 409, 'SHARE_DISABLED_FOR_DRIVER', 'T7 disabled');
await failsWith(svc.ownerCreateTrip({ ownerId: ownerStopped._id, driverId: fleetOff._id, origin: place(RAJWADA), destination: place(DEWAS) }), 403, 'OWNER_STOPPED', 'stopped owner');
const bikeFleet = await mkDriver(10, { owner_id: ownerA._id, vehicleType: 'bike' });
await failsWith(svc.ownerCreateTrip({ ownerId: ownerA._id, driverId: bikeFleet._id, origin: place(RAJWADA), destination: place(DEWAS) }), 409, 'NOT_SHARE_VEHICLE', 'bike');
await failsWith(svc.ownerCreateTrip({ ownerId: ownerA._id, driverId: soloPass._id, origin: place(RAJWADA), destination: place(DEWAS) }), 404, 'NOT_YOUR_DRIVER', 'not in fleet');
const t6 = await svc.ownerCreateTrip({ ownerId: ownerA._id, driverId: fleetOn._id, origin: place(RAJWADA), destination: place(DEWAS), seatsTotal: 2 });
await failsWith(svc.ownerCreateTrip({ ownerId: ownerA._id, driverId: fleetOn._id, origin: place(RAJWADA), destination: place(DEWAS) }), 409, 'TRIP_ALREADY_ACTIVE', 'second trip');
await svc.ownerSetDriverEnabled({ ownerId: ownerA._id, driverId: fleetOn._id, enabled: false });
assert.equal((await ShareTrip.findById(t6.id)).status, 'cancelled', 'T8: the empty trip is closed when share is switched off');
await svc.ownerSetDriverEnabled({ ownerId: ownerA._id, driverId: fleetOn._id, enabled: true });
// with riders on board the trip is left to finish
const t8 = await svc.ownerCreateTrip({ ownerId: ownerA._id, driverId: fleetOn._id, origin: place(RAJWADA), destination: place(DEWAS), seatsTotal: 2 });
const onBoard = await svc.createShareRide({ user: users[6], body: body(RAJWADA, DEWAS), deps });
await svc.acceptShareRequest({ driverId: fleetOn._id, rideId: onBoard.id });
await svc.ownerSetDriverEnabled({ ownerId: ownerA._id, driverId: fleetOn._id, enabled: false });
assert.equal((await ShareTrip.findById(t8.id)).status, 'open', 'riders on board: the trip stays');
await failsWith(svc.ownerCancelTrip({ ownerId: ownerA._id, tripId: t8.id }), 409, 'RIDERS_ON_TRIP', 'cancel with riders');
await svc.ownerSetDriverEnabled({ ownerId: ownerA._id, driverId: fleetOn._id, enabled: true });
await svc.cancelByRider({ userId: users[6]._id, rideId: onBoard.id });
assert.equal((await svc.ownerCancelTrip({ ownerId: ownerA._id, tripId: t8.id })).status, 'cancelled');

// ---- T9 / T10 / R6: status codes
const tSolo = tokenFor(soloNoPass._id, 'driver');
const status9 = (await call('GET', '/drivers/share/status', tSolo)).body.data;
assert.equal(status9.code, 'SUBSCRIPTION_REQUIRED');
assert.equal(status9.canBuyPass, true);
assert.equal(status9.eligible, false);
assert.ok(status9.reason);
const status10 = (await call('GET', '/drivers/share/status', tokenFor(fleetOff._id, 'driver'))).body.data;
assert.equal(status10.code, 'OWNER_STOPPED');
assert.equal(status10.canBuyPass, false);
const ok = (await call('GET', '/drivers/share/status', tokenFor(soloPass._id, 'driver'))).body.data;
assert.deepEqual([ok.code, ok.eligible, ok.canBuyPass], ['OK', true, false]);
assert.equal((await svc.getDriverShareStatus(unapproved._id)).code, 'NOT_APPROVED');
assert.equal((await svc.getDriverShareStatus(disabled._id)).code, 'DISABLED_BY_OWNER');
assert.equal((await svc.getDriverShareStatus(bikeFleet._id)).code, 'NOT_SHARE_VEHICLE');
// codes on errors, in the HTTP body
const rid = await svc.createShareRide({ user: users[7], body: body(RAJWADA, DEWAS), deps });
const blocked = await call('POST', `/drivers/share/requests/${rid.id}/accept`, tSolo, {});
assert.equal(blocked.status, 403);
assert.equal(blocked.body.code, 'SUBSCRIPTION_REQUIRED');
const offline = await mkDriver(11, { isOnline: false });
await addPass(offline._id);
await failsWith(svc.acceptShareRequest({ driverId: offline._id, rideId: rid.id }), 403, 'GO_ONLINE_REQUIRED', 'idle offline driver');
const wrong = await mkDriver(12);
await addPass(wrong._id);
await svc.acceptShareRequest({ driverId: wrong._id, rideId: rid.id });
await failsWith(svc.acceptShareRequest({ driverId: soloPass._id, rideId: rid.id }), 409, 'REQUEST_TAKEN', 'T12 second driver');
await failsWith(svc.verifyPickup({ driverId: wrong._id, rideId: rid.id, otp: '0000' }), 400, 'WRONG_OTP', 'wrong otp');

// ---- T13 / R5: a stuck accepted ride is auto-cancelled by the job and the seat freed
await ShareRide.updateOne({ _id: rid.id }, { $set: { acceptedAt: ago(7 * 60) } });
await svc.runShareCleanup();
assert.equal((await ShareRide.findById(rid.id)).status, 'cancelled');
assert.equal((await ShareRide.findById(rid.id)).cancelReason, 'Timed out');
assert.equal(await svc.getDriverTrip(wrong._id), null, 'the auto-made trip emptied and closed');
// a request nobody took in time expires in the job
const lonely = await svc.createShareRide({ user: users[7], body: body(RAJWADA, DEWAS), deps });
await ShareRide.updateOne({ _id: lonely.id }, { $set: { expiresAt: ago(1) } });
await svc.runShareCleanup();
assert.equal((await ShareRide.findById(lonely.id)).status, 'expired');

// ---- T11 / R7: the driver's share history
const hist = await mkDriver(13);
await addPass(hist._id);
const h1 = await svc.createShareRide({ user: users[0], body: body(RAJWADA, DEWAS), deps });
await svc.acceptShareRequest({ driverId: hist._id, rideId: h1.id });
await finish(hist._id, h1.id);
const h2 = await svc.createShareRide({ user: users[1], body: body(RAJWADA, DEWAS), deps });
await svc.acceptShareRequest({ driverId: hist._id, rideId: h2.id });
await finish(hist._id, h2.id);
const h3 = await svc.createShareRide({ user: users[2], body: body(RAJWADA, DEWAS), deps });
await svc.acceptShareRequest({ driverId: hist._id, rideId: h3.id });
await svc.cancelByRider({ userId: users[2]._id, rideId: h3.id });
const tHist = tokenFor(hist._id, 'driver');
const page = await call('GET', '/drivers/share/rides?status=finished&page=1&limit=2', tHist);
assert.equal(page.status, 200, JSON.stringify(page.body));
assert.deepEqual(page.body.data.pagination, { page: 1, limit: 2, total: 3, hasMore: true });
assert.equal(page.body.data.results.length, 2);
assert.equal(page.body.data.results[0].id, h3.id, 'newest (the cancelled one) first');
assert.ok(page.body.data.results[0].cancelledAt && page.body.data.results[0].createdAt);
const completedOnly = (await call('GET', '/drivers/share/rides?status=completed', tHist)).body.data;
assert.equal(completedOnly.pagination.total, 2);
assert.equal(completedOnly.results[0].id, h2.id, 'newest completed first');
const row = completedOnly.results[0];
assert.ok(row.completedAt && row.acceptedAt && row.createdAt);
assert.equal(row.settlement.driverEarnings > 0, true);
assert.equal(row.collectedVia, 'cash');
assert.ok(row.passenger.name && row.pickup.lat && row.drop.lng && row.fareBreakdown.perSeat);
assert.equal(row.otp, undefined, 'the rider OTP is never in a driver payload');
assert.equal((await call('GET', '/drivers/share/rides?status=active', tHist)).body.data.pagination.total, 0);
assert.equal((await call('GET', '/drivers/share/rides', tSolo)).body.data.pagination.total, 0, 'only my own rides');
assert.equal((await call('GET', '/drivers/share/rides')).status, 401);

// ---- R10: owner service state on /drivers/me
const me = (await call('GET', '/drivers/me', tokenFor(fleetOff._id, 'driver'))).body.data;
assert.equal(me.ownerServiceActive, false);
assert.match(me.ownerServiceReason, /subscription has ended/);
assert.equal((await call('GET', '/drivers/me', tokenFor(fleetOn._id, 'driver'))).body.data.ownerServiceActive, true);
assert.equal((await call('GET', '/drivers/me', tHist)).body.data.ownerServiceActive, null, 'null for a solo driver');


// ====================================================================== R12: the rider picks the vehicle
const fare = await import('../src/modules/taxi/shareRide/services/shareRideFare.js');
assert.equal(fare.vehicleCapacityOf({ category: 'auto' }), 3, 'an auto without a configured capacity seats 3');
assert.equal(fare.vehicleCapacityOf({}), 4);
assert.equal(fare.vehicleCapacityOf({ capacity: 7 }), 7);
assert.equal(fare.maxSeatsFor({ capacity: 4 }), 3);
assert.equal(fare.maxSeatsFor({ capacity: 9 }), 6, 'capped at SHARE_MAX_SEATS');
const mkType = async (doc) => (await Vehicle.collection.insertOne({ transport_type: 'taxi', is_taxi: 'taxi', active: true, status: 1, ...doc })).insertedId;
const suvType = await mkType({ name: 'SUV', icon_types: 'suv', category: 'car', capacity: 6, is_accept_share_ride: 1 });
const autoType = await mkType({ name: 'Auto', icon_types: 'auto', category: 'auto', capacity: 3, is_accept_share_ride: 1 });
const bikeType = await mkType({ name: 'Bike', icon_types: 'bike', category: 'bike', capacity: 1, is_accept_share_ride: 1 });
const offType = await mkType({ name: 'Mini Off', icon_types: 'car', category: 'car', capacity: 4, is_accept_share_ride: 0 });
const tariffRow = (id, name, base, perKm) => ({ type_id: String(id), vehicle_type_name: name, base_price: base, base_distance: 2, price_per_distance: perKm, rider_platform_fee: 5, rider_platform_fee_type: 'percentage' });
const deps2 = {
  loadRoute: async () => ({ distanceMeters: 20000 }),
  loadTariffs: async () => ({ tariffs: [tariffRow(carType, "Sedan", 60, 14), tariffRow(suvType, "SUV", 50, 12), tariffRow(autoType, "Auto", 30, 9), tariffRow(bikeType, "Bike", 10, 5), tariffRow(offType, "Mini Off", 70, 15)] }),
};
const sedanDriver = await mkDriver(20);
const suvDriver = await mkDriver(21, { vehicleTypeId: suvType, vehicleTypeIds: [suvType] });
const autoDriver = await mkDriver(22, { vehicleType: 'auto', vehicleIconType: 'auto', vehicleTypeId: autoType, vehicleTypeIds: [autoType] });
const bikeDriver = await mkDriver(23, { vehicleType: 'bike', vehicleIconType: 'bike', vehicleTypeId: bikeType, vehicleTypeIds: [bikeType] });
for (const d of [sedanDriver, suvDriver, autoDriver, bikeDriver]) await addPass(d._id);
// the earlier drivers would show up in "who is told": park them
await Driver.updateMany({ _id: { $nin: [sedanDriver._id, suvDriver._id, autoDriver._id, bikeDriver._id] } }, { $set: { isOnline: false } });

// T15 / T21 / T25: options for the route
const opts = await svc.vehicleOptionsForRider({ pickup: place(RAJWADA), drop: place(DEWAS) }, deps2);
assert.equal(opts.available, true);
const byName = Object.fromEntries(opts.options.map((o) => [o.name, o]));
assert.deepEqual(Object.keys(byName).sort(), ['Auto', 'SUV', 'Sedan'], 'T21/T25: no bike, no type the admin switched off');
assert.deepEqual([byName.Sedan.maxSeats, byName.SUV.maxSeats, byName.Auto.maxSeats], [3, 5, 2], 'T15: seats limited by the vehicle');
assert.deepEqual([byName.Sedan.perSeat, byName.SUV.perSeat, byName.Auto.perSeat], [218, 186, 134], 'each from its own tariff');
assert.equal(byName.SUV.capacity, 6);
assert.equal(byName.Sedan.available, true);
assert.ok(byName.Sedan.nearbyDrivers >= 1 && byName.Sedan.etaMinutes >= 1);
assert.equal(byName.Auto.available, true, 'the auto driver is online nearby');
await Driver.updateOne({ _id: autoDriver._id }, { $set: { isOnline: false } });
const noAuto = (await svc.vehicleOptionsForRider({ pickup: place(RAJWADA), drop: place(DEWAS) }, deps2)).options.find((o) => o.name === 'Auto');
assert.equal(noAuto.available, false);
assert.equal(noAuto.nearbyDrivers, 0);
assert.match(noAuto.reason, /No Auto nearby/);
await Driver.updateOne({ _id: autoDriver._id }, { $set: { isOnline: true } });
assert.equal((await svc.vehicleOptionsForRider({ pickup: place(RAJWADA), drop: place([RAJWADA[0] + 0.0001, RAJWADA[1]]) }, deps2)).available, false, 'too short a trip');
const rs = { sedan: await mkUser(31), suv: await mkUser(32), auto: await mkUser(33), legacy: await mkUser(34), http: await mkUser(35) };

// T16: a sedan takes 3 seats at most; bad vehicles are refused
await failsWith(svc.createShareRide({ user: rs.sedan, body: { ...body(RAJWADA, DEWAS, 4), vehicleTypeId: String(carType) }, deps: deps2 }), 400, 'SEATS_EXCEED_CAPACITY', 'T16');
await failsWith(svc.quoteForRider({ ...body(RAJWADA, DEWAS, 4), vehicleTypeId: String(carType) }, deps2), 400, 'SEATS_EXCEED_CAPACITY', 'the quote refuses too');
await failsWith(svc.createShareRide({ user: rs.sedan, body: { ...body(RAJWADA, DEWAS, 2), vehicleTypeId: String(new mongoose.Types.ObjectId()) }, deps: deps2 }), 400, 'VEHICLE_NOT_AVAILABLE', 'unknown vehicle');
await failsWith(svc.createShareRide({ user: rs.sedan, body: { ...body(RAJWADA, DEWAS, 1), vehicleTypeId: String(bikeType) }, deps: deps2 }), 400, 'VEHICLE_NOT_AVAILABLE', 'bike');
await failsWith(svc.createShareRide({ user: rs.sedan, body: { ...body(RAJWADA, DEWAS, 1), vehicleTypeId: String(offType) }, deps: deps2 }), 400, 'VEHICLE_NOT_AVAILABLE', 'switched off by admin');
await failsWith(svc.createShareRide({ user: rs.sedan, body: { ...body(RAJWADA, DEWAS, 1), vehicleTypeId: 'not-an-id' }, deps: deps2 }), 400, 'VEHICLE_NOT_AVAILABLE', 'bad id');

// T17: the SUV takes 5 seats, priced from the SUV tariff
const suvRide = await svc.createShareRide({ user: rs.suv, body: { ...body(RAJWADA, DEWAS, 5), vehicleTypeId: String(suvType) }, deps: deps2 });
assert.equal(suvRide.seats, 5);
assert.equal(suvRide.fareBreakdown.perSeat, 186);
assert.equal(suvRide.fareBreakdown.tariffName, 'SUV');
assert.deepEqual(suvRide.vehicleRequested, { vehicleTypeId: String(suvType), name: 'SUV', capacity: 6 });
assert.equal(String((await ShareRide.findById(suvRide.id)).vehicleTypeId), String(suvType));

// T18: only the SUV driver is told and shown it
const toldSuv = (await svc.notifyNewRequest(await ShareRide.findById(suvRide.id))).map(String);
assert.deepEqual(toldSuv, [String(suvDriver._id)], 'T18: only the SUV driver');
assert.ok((await svc.listRequestsForDriver(suvDriver._id)).requests.some((x) => x.id === suvRide.id));
assert.ok(!(await svc.listRequestsForDriver(sedanDriver._id)).requests.some((x) => x.id === suvRide.id));
assert.ok(!(await svc.listRequestsForDriver(autoDriver._id)).requests.some((x) => x.id === suvRide.id));
// T19
await failsWith(svc.acceptShareRequest({ driverId: sedanDriver._id, rideId: suvRide.id }), 409, 'VEHICLE_MISMATCH', 'T19');
await svc.cancelByRider({ userId: rs.suv._id, rideId: suvRide.id });

// T22 / T26: an auto drives share rides too, with its own seat limit
assert.equal((await svc.getDriverShareStatus(autoDriver._id)).eligible, true, 'T22');
await failsWith(svc.createShareRide({ user: rs.auto, body: { ...body(RAJWADA, DEWAS, 3), vehicleTypeId: String(autoType) }, deps: deps2 }), 400, 'SEATS_EXCEED_CAPACITY', 'T26');
const autoRide = await svc.createShareRide({ user: rs.auto, body: { ...body(RAJWADA, DEWAS, 2), vehicleTypeId: String(autoType) }, deps: deps2 });
assert.deepEqual((await svc.notifyNewRequest(await ShareRide.findById(autoRide.id))).map(String), [String(autoDriver._id)], 'T22: the auto driver is told');
const accAuto = await svc.acceptShareRequest({ driverId: autoDriver._id, rideId: autoRide.id });
assert.equal(accAuto.trip.seatsTotal, 2, 'an auto of capacity 3 offers 2 seats');
await svc.cancelByRider({ userId: rs.auto._id, rideId: autoRide.id });

// T23 / T24: a bike cannot; the owner can make a trip for an auto
const bikeStatus = await svc.getDriverShareStatus(bikeDriver._id);
assert.deepEqual([bikeStatus.eligible, bikeStatus.code], [false, 'NOT_SHARE_VEHICLE'], 'T23');
assert.match(bikeStatus.reason, /not available for bike drivers/);
const autoFleet = await mkDriver(24, { owner_id: ownerA._id, vehicleType: 'auto', vehicleIconType: 'auto', vehicleTypeId: autoType, vehicleTypeIds: [autoType] });
const autoTrip = await svc.ownerCreateTrip({ ownerId: ownerA._id, driverId: autoFleet._id, origin: place(RAJWADA), destination: place(DEWAS) });
assert.equal(autoTrip.status, 'open', 'T24');
assert.equal(autoTrip.seatsTotal, 2);
assert.equal(autoTrip.vehicle.type, 'auto');
await svc.ownerCancelTrip({ ownerId: ownerA._id, tripId: autoTrip.id });

// T20: an older app build (no vehicle) works as before: 1 to 4 seats, any car driver
await failsWith(svc.createShareRide({ user: rs.legacy, body: body(RAJWADA, DEWAS, 5), deps: deps2 }), 400, 'SEATS_INVALID', 'old limit stays 4');
const legacy = await svc.createShareRide({ user: rs.legacy, body: body(RAJWADA, DEWAS, 2), deps: deps2 });
assert.equal(legacy.vehicleRequested, null);
assert.ok((await svc.listRequestsForDriver(sedanDriver._id)).requests.some((x) => x.id === legacy.id), 'T20: the sedan driver sees it');
assert.ok((await svc.listRequestsForDriver(suvDriver._id)).requests.some((x) => x.id === legacy.id), 'and the SUV driver');
await svc.cancelByRider({ userId: rs.legacy._id, rideId: legacy.id });

// the route: 'vehicle-options' is not swallowed by /users/share-rides/:id
const tRider = tokenFor(rs.http._id, 'user');
const viaHttp = await call('GET', '/users/share-rides/vehicle-options?pickup[lat]=22.7183&pickup[lng]=75.8553&drop[lat]=22.9676&drop[lng]=76.0534', tRider);
assert.equal(viaHttp.status, 200, JSON.stringify(viaHttp.body));
assert.equal(viaHttp.body.data.available, false, 'no zone or tariff in the test database');
assert.equal((await call('POST', '/users/share-rides/vehicle-options', tRider, { pickup: place(RAJWADA), drop: place(DEWAS) })).status, 200);
assert.equal((await call('POST', '/users/share-rides/vehicle-options', tRider, { pickup: { lat: 'x' }, drop: {} })).status, 400);
assert.equal((await call('POST', '/users/share-rides/vehicle-options', undefined, {})).status, 401);
assert.equal((await call('POST', '/users/share-rides/quote', tRider, { ...body(RAJWADA, DEWAS, 1), vehicleTypeId: 'zzz' })).body.code, 'VEHICLE_NOT_AVAILABLE');


// ====================================================================== seats left decide who is offered a request
const seatUsers = await Promise.all([41, 42, 43, 44, 45, 46, 47].map(mkUser));
const busyDrv = await mkDriver(40); // sedan: 3 shareable seats
const control = await mkDriver(41); // idle sedan, same place
await addPass(busyDrv._id);
await addPass(control._id);
await Driver.updateMany({ _id: { $nin: [busyDrv._id, control._id] } }, { $set: { isOnline: false } });
const sedanBody = (pickup, drop, seats) => ({ ...body(pickup, drop, seats), vehicleTypeId: String(carType) });
// twoV riders (1 seat each) are booked on the busyDrv driver's trip: 1 seat left
for (const user of seatUsers.slice(0, 2)) {
  const booked = await svc.createShareRide({ user, body: sedanBody(RAJWADA, DEWAS, 1), deps: deps2 });
  await svc.acceptShareRequest({ driverId: busyDrv._id, rideId: booked.id });
}
const busyTrip = await svc.getDriverTrip(busyDrv._id);
assert.deepEqual([busyTrip.seatsTotal, busyTrip.seatsTaken, busyTrip.seatsFree], [3, 2, 1]);

const twoV = await svc.createShareRide({ user: seatUsers[2], body: sedanBody(RAJWADA, DEWAS, 2), deps: deps2 });
const oneV = await svc.createShareRide({ user: seatUsers[3], body: sedanBody(RAJWADA, DEWAS, 1), deps: deps2 });
const toldTwo = (await svc.notifyNewRequest(await ShareRide.findById(twoV.id))).map(String);
const toldOne = (await svc.notifyNewRequest(await ShareRide.findById(oneV.id))).map(String);
assert.ok(!toldTwo.includes(String(busyDrv._id)), '1 seat left: the 2-seat request is NOT offered');
assert.ok(toldTwo.includes(String(control._id)), 'an idle driver with room still gets it');
assert.ok(toldOne.includes(String(busyDrv._id)), 'the 1-seat request fits the 1 seat left');
const listedBusy = (await svc.listRequestsForDriver(busyDrv._id)).requests.map((x) => x.id);
assert.ok(!listedBusy.includes(twoV.id) && listedBusy.includes(oneV.id), 'the driver list follows the same rule');
await failsWith(svc.acceptShareRequest({ driverId: busyDrv._id, rideId: twoV.id, tripId: busyTrip.id }), 409, 'NO_FREE_SEATS', 'accepting it anyway');
const tooBig = await svc.acceptShareRequest({ driverId: busyDrv._id, rideId: twoV.id }).catch((error) => error);
assert.equal(tooBig.details.cardCode, 'SEATS_EXCEED_CAPACITY', 'the offer card gets a stable code');
// a driver with riders on board is not told about a request that is off their line, even if it is next door
const offLine = await svc.createShareRide({ user: seatUsers[4], body: sedanBody(AIRPORT, [AIRPORT[0], AIRPORT[1] + 0.05], 1), deps: deps2 });
const toldOff = (await svc.notifyNewRequest(await ShareRide.findById(offLine.id))).map(String);
assert.ok(!toldOff.includes(String(busyDrv._id)), 'busyDrv on another line: not told');
assert.ok(toldOff.includes(String(control._id)));
assert.ok(((await ShareRide.findById(offLine.id)).notifiedDriverIds || []).map(String).includes(String(control._id)), 'who was told is remembered (to close their cards later)');

// ---- the offer card payloadV: strings only, real addresses, per-driver distance
const whenV = new Date(Date.now() + 20 * 60e3);
const sampleV = {
  _id: oid(), passenger: { name: 'Amit Kumar' }, seats: 2, fare: 179.6, expiresAt: whenV,
  pickup: { address: 'Selected on map', location: { coordinates: RAJWADA } }, drop: { address: 'Connaught Place, Delhi', location: { coordinates: DEWAS } },
};
const payloadV = svc.offerPayload(sampleV, { location: { coordinates: [RAJWADA[0], RAJWADA[1] + 0.01] } }, oid());
assert.ok(Object.values(payloadV).every((v) => typeof v === 'string'), 'FCM data must be strings');
assert.deepEqual([payloadV.type, payloadV.riderName, payloadV.seats, payloadV.fare], ['share_request', 'Amit', '2', '180']);
assert.equal(payloadV.pickupAddress, 'the pickup point', 'a placeholder address is never read aloud');
assert.equal(payloadV.dropAddress, 'Connaught Place, Delhi');
assert.equal(payloadV.shareRideId, payloadV.rideId);
assert.ok(payloadV.shareTripId.length === 24);
assert.equal(payloadV.pickupDistanceKm, '1.1');
assert.equal(payloadV.expiresInSeconds, '30');
assert.equal(svc.offerPayload({ ...sampleV, pickup: { address: '', location: { coordinates: RAJWADA } } }, null, null).pickupAddress, 'the pickup point', 'empty address');
assert.equal(svc.offerPayload(sampleV, null, null).pickupDistanceKm, '', 'no GPS: no distance');
assert.equal(svc.offerPayload({ ...sampleV, expiresAt: new Date(Date.now() + 8000) }, null, null).expiresInSeconds, '8', 'never longer than the request lives');

// ---- reject and accept are safe to repeat (the card may be answered by a killed app)
const rejector = control;
assert.deepEqual(await svc.rejectShareRequest({ driverId: rejector._id, rideId: oneV.id }), { rideId: oneV.id, rejected: true });
assert.deepEqual(await svc.rejectShareRequest({ driverId: rejector._id, rideId: oneV.id }), { rideId: oneV.id, rejected: true }, 'twice is fine');
assert.equal((await svc.rejectShareRequest({ driverId: rejector._id, rideId: String(oid()) })).rejected, true, 'unknown request');
assert.ok(!(await svc.listRequestsForDriver(rejector._id)).requests.some((x) => x.id === oneV.id), 'a rejected request is gone for that driver');
await failsWith(svc.acceptShareRequest({ driverId: rejector._id, rideId: oneV.id }), 409, 'REQUEST_DECLINED', 'accept after reject');
const tCtrl = tokenFor(control._id, 'driver');
assert.equal((await call('POST', `/drivers/share/requests/${twoV.id}/reject`, tCtrl, {})).status, 200);
assert.equal((await call('POST', `/drivers/share/requests/${twoV.id}/reject`, undefined, {})).status, 401);
const firstV = await svc.acceptShareRequest({ driverId: busyDrv._id, rideId: oneV.id });
const repeated = await svc.acceptShareRequest({ driverId: busyDrv._id, rideId: oneV.id });
assert.equal(repeated.alreadyAccepted, true, 'the same driver accepting twice gets the same answer');
assert.equal(repeated.ride.id, firstV.ride.id);
assert.equal((await svc.getDriverTrip(busyDrv._id)).seatsTaken, 3, 'and no seat is takenV twice');
const takenV = await call('POST', `/drivers/share/requests/${oneV.id}/accept`, tCtrl, {});
assert.equal(takenV.status, 409);
assert.equal(takenV.body.code, 'REQUEST_TAKEN');
assert.equal(takenV.body.details.cardCode, 'ALREADY_HANDLED', 'T4: another driver gets a clear code');

// ---- hourly rental offers carry the package, and no drop
const dispatchV = await import('../src/modules/taxi/services/dispatchService.js');
assert.deepEqual(dispatchV.rentalOfferFields({ serviceType: 'hourly_rental', rental: { packagePriceId: oid(), includedMinutes: 240, includedKm: 40 } }), { packageHours: '4', packageKm: '40' });
assert.deepEqual(dispatchV.rentalOfferFields({ serviceType: 'hourly_rental', rental: { packagePriceId: oid(), includedMinutes: 90, includedKm: 15 } }), { packageHours: '1.5', packageKm: '15' });
assert.deepEqual(dispatchV.rentalOfferFields({ serviceType: 'ride' }), {}, 'a normal ride is untouched');

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('share ride v2: all checks passed');
process.exit(0);
