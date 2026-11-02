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

// ---- T3 / T4 / R1.3: an empty trip also matches by GPS; a trip with a rider does not
const d3 = await mkDriver(3, { location: { type: 'Point', coordinates: AIRPORT } });
await addPass(d3._id);
const stale = await ShareTrip.create({
  driverId: d3._id, createdBy: 'driver', seatsTotal: 3, seatsTaken: 0, vehicleSnapshot: { type: 'car', number: 'MH12SV333' },
  origin: { address: 'Rajwada', location: { type: 'Point', coordinates: RAJWADA } }, destination: { address: 'Dewas', location: { type: 'Point', coordinates: DEWAS } },
});
const nearAirport = await svc.createShareRide({ user: users[3], body: body(AIRPORT, [AIRPORT[0], AIRPORT[1] + 0.05]), deps });
let listing = await svc.listRequestsForDriver(d3._id);
assert.ok(listing.requests.some((x) => x.id === nearAirport.id), 'T3: the empty trip does not block a rider next to the driver');
await Driver.updateOne({ _id: d3._id }, { $set: { locationUpdatedAt: ago(10) } });
assert.ok(!(await svc.listRequestsForDriver(d3._id)).requests.some((x) => x.id === nearAirport.id), 'a stale GPS fix does not count');
await Driver.updateOne({ _id: d3._id }, { $set: { locationUpdatedAt: new Date() } });
await svc.acceptShareRequest({ driverId: d3._id, rideId: nearAirport.id });
const rebased = await ShareTrip.findById(stale._id);
assert.equal(rebased.seatsTaken, 1, 'T3: the rider was added');
assert.ok(Math.abs(rebased.destination.location.coordinates[1] - (AIRPORT[1] + 0.05)) < 1e-9, 'the first rider defines the new line');
assert.ok(Math.abs(rebased.origin.location.coordinates[0] - AIRPORT[0]) < 1e-9);
// T4: now it has a rider: only requests along the new line are shown
const farAway = await svc.createShareRide({ user: users[4], body: body(DEWAS, RAJWADA), deps });
assert.ok(!(await svc.listRequestsForDriver(d3._id)).requests.some((x) => x.id === farAway.id), 'T4: with a rider on board only the line matters');
await svc.cancelByRider({ userId: users[4]._id, rideId: farAway.id });

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
await failsWith(svc.ownerCreateTrip({ ownerId: ownerA._id, driverId: bikeFleet._id, origin: place(RAJWADA), destination: place(DEWAS) }), 409, 'NOT_CAR', 'bike');
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
assert.equal((await svc.getDriverShareStatus(bikeFleet._id)).code, 'NOT_CAR');
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

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('share ride v2: all checks passed');
process.exit(0);
