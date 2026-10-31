// HTTP-level smoke test for Share Ride: real express app, real auth middleware,
// real controllers, against a THROWAWAY Mongo. testShareRide.mjs covers the
// service rules; this covers the wiring the apps actually hit (paths, tokens,
// roles, response shape, read-only admin, rate limit).
//   SHARE_RIDE_HTTP_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testShareRideHttp.mjs
// Drops its own database (share_ride_http_test) when done. Never point it at production.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.SHARE_RIDE_HTTP_TEST_MONGODB_URI;
if (!uri) throw new Error('Set SHARE_RIDE_HTTP_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB_NAME: 'share_ride_http_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test' });

// Calls to this test's own server go through; anything else (Google, OSRM, push) is refused.
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
const { Admin } = await import('../src/modules/taxi/admin/models/Admin.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');

await mongoose.connect(uri, { dbName: 'share_ride_http_test' });
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

const RAJWADA = [75.8553, 22.7183];
const VIJAY_NAGAR = [75.8937, 22.7533];
const DEWAS = [76.0534, 22.9676];
const place = ([lng, lat], address) => ({ lat, lng, address });

// ---- people
const carType = (await Vehicle.collection.insertOne({ name: 'Sedan', icon_types: 'car', capacity: 4, transport_type: 'taxi', active: true, status: 1 })).insertedId;
const user = await User.create({ name: 'Asha Rider', phone: '9000000011', city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
const other = await User.create({ name: 'Other Rider', phone: '9000000012', city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
const owner = await Owner.create({ name: 'Owner', company_name: 'Fleet Co', mobile: '9200000001', email: 'o@example.com', password: 'x-test-pass', approve: true, status: 'approved' });
const mkDriver = (n, extra = {}) => Driver.create({
  name: `Driver ${n}`, phone: `91000000${10 + n}`, password: 'x-test-pass', approve: true, status: 'approved', isOnline: true,
  vehicleType: 'car', vehicleTypeId: carType, vehicleTypeIds: [carType], vehicleNumber: `MH12AB10${n}${n}`, vehicleColor: 'white',
  location: { type: 'Point', coordinates: RAJWADA }, ...extra,
});
const driver = await mkDriver(1);
const fleet = await mkDriver(2, { owner_id: owner._id });
const bikeDriver = await mkDriver(3, { vehicleType: 'bike' });
await Admin.collection.insertOne({ name: 'Admin', email: 'a@example.com', password: 'x', createdAt: new Date() });
const adminDoc = await Admin.collection.findOne({ email: 'a@example.com' });
for (const d of [driver, fleet]) {
  await DriverSubscription.collection.insertOne({
    driverId: d._id, planId: new mongoose.Types.ObjectId(), planName: 'Day', amount: 50, vehicleClasses: ['car'],
    startsAt: new Date(Date.now() - 3600e3), expiresAt: new Date(Date.now() + 24 * 3600e3), status: 'active', paymentMethod: 'wallet',
    paidAt: new Date(), tripsCovered: 0, commissionWaived: 0,
  });
}
const tUser = tokenFor(user._id, 'user');
const tOther = tokenFor(other._id, 'user');
const tDriver = tokenFor(driver._id, 'driver');
const tFleet = tokenFor(fleet._id, 'driver');
const tBike = tokenFor(bikeDriver._id, 'driver');
const tOwner = tokenFor(owner._id, 'owner');
const tAdmin = tokenFor(adminDoc._id, 'admin');

// ---- auth wiring
assert.equal((await call('GET', '/users/share-rides')).status, 401, 'no token');
assert.equal((await call('GET', '/users/share-rides', tDriver)).status, 403, 'a driver token is not a rider');
assert.equal((await call('GET', '/drivers/share/status', tUser)).status, 403, 'a rider token is not a driver');
assert.equal((await call('GET', '/drivers/fleet/share/overview', tDriver)).status, 403, 'a driver token is not an owner');
assert.equal((await call('GET', '/admin/share-rides/overview', tOwner)).status, 403, 'an owner token is not an admin');

// ---- rider: no tariff in this empty database, so the quote says so cleanly
const quote = await call('POST', '/users/share-rides/quote', tUser, { pickup: place(RAJWADA, 'Rajwada'), drop: place(DEWAS, 'Dewas'), seats: 2 });
assert.equal(quote.status, 200);
assert.equal(quote.body.success, true);
assert.equal(quote.body.data.available, false);
assert.match(quote.body.data.reason, /not available/i);
const refused = await call('POST', '/users/share-rides', tUser, { pickup: place(RAJWADA, 'Rajwada'), drop: place(DEWAS, 'Dewas'), seats: 2 });
assert.equal(refused.status, 422, 'no tariff here: the request is refused, not created');
assert.equal((await call('POST', '/users/share-rides/quote', tUser, { pickup: { lat: 'x' }, drop: {} })).status, 400, 'bad location');
assert.equal(await ShareRide.countDocuments(), 0);

// a request created the way the app would (the server prices it from a tariff; tests supply one)
const deps = {
  loadRoute: async () => ({ distanceMeters: 20000 }),
  loadTariffs: async () => ({
    tariffs: [{ type_id: String(carType), vehicle_type_name: 'Sedan', base_price: 50, base_distance: 2, price_per_distance: 12, rider_platform_fee: 5, rider_platform_fee_type: 'percentage' }],
  }),
};
const made = await svc.createShareRide({ user, body: { pickup: place(RAJWADA, 'Rajwada'), drop: place(DEWAS, 'Dewas'), seats: 2 }, deps });

const mine = await call('GET', '/users/share-rides?status=active', tUser);
assert.equal(mine.status, 200);
assert.equal(mine.body.data.length, 1);
assert.match(mine.body.data[0].otp, /^\d{4}$/, 'the rider sees their OTP');
assert.equal(mine.body.data[0].fare, 391);
assert.equal((await call('GET', `/users/share-rides/${made.id}`, tOther)).status, 404, 'another rider cannot read it');
assert.equal((await call('GET', `/users/share-rides/${made.id}`, tUser)).status, 200);

// ---- driver
const status = await call('GET', '/drivers/share/status', tDriver);
assert.equal(status.status, 200);
assert.equal(status.body.data.eligible, true);
assert.equal(status.body.data.trip, null);
const bike = await call('GET', '/drivers/share/status', tBike);
assert.equal(bike.body.data.eligible, false, 'a bike driver is told why');
const requests = await call('GET', '/drivers/share/requests', tDriver);
assert.equal(requests.status, 200);
assert.equal(requests.body.data.source, 'idle');
assert.equal(requests.body.data.requests.length, 1);
const asSeen = requests.body.data.requests[0];
assert.equal(asSeen.id, made.id);
assert.deepEqual(asSeen.passenger, { name: 'Asha' }, 'the driver sees a first name only before accepting');
assert.ok(!('otp' in asSeen));
const bikeAccept = await call('POST', `/drivers/share/requests/${made.id}/accept`, tBike, {});
assert.equal(bikeAccept.status, 403);
const accepted = await call('POST', `/drivers/share/requests/${made.id}/accept`, tDriver, {});
assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
assert.equal(accepted.body.data.ride.status, 'accepted');
assert.equal(accepted.body.data.trip.seatsTaken, 2);
assert.equal((await call('POST', `/drivers/share/requests/${made.id}/accept`, tFleet, {})).status, 409, 'already taken');
const trip = await call('GET', '/drivers/share/trip', tDriver);
assert.equal(trip.body.data.riders.length, 1);
assert.equal(trip.body.data.riders[0].passenger.phone, '9000000011', 'full details after accepting');
const track = await call('GET', `/users/share-rides/${made.id}`, tUser);
assert.equal(track.body.data.status, 'accepted');
assert.equal(track.body.data.driver.name, 'Driver 1', 'the rider sees who is coming');
const otp = track.body.data.otp;
assert.equal((await call('POST', `/drivers/share/rides/${made.id}/pickup`, tDriver, { otp: otp === '1111' ? '2222' : '1111' })).status, 400, 'wrong otp');
assert.equal((await call('POST', `/drivers/share/rides/${made.id}/pickup`, tDriver, { otp })).status, 200);
assert.equal((await call('POST', `/users/share-rides/${made.id}/cancel`, tUser, {})).status, 409, 'cannot cancel once on board');
const finished = await call('POST', `/drivers/share/rides/${made.id}/complete`, tDriver, { collectedVia: 'cash' });
assert.equal(finished.status, 200);
assert.equal(finished.body.data.settlement.driverEarnings, 372);
assert.equal(finished.body.data.settlement.platformFee, 19);
assert.equal((await call('POST', `/drivers/share/rides/${made.id}/complete`, tDriver, { collectedVia: 'cash' })).status, 409, 'complete only once');
const earn = await call('GET', '/drivers/share/earnings', tDriver);
assert.equal(earn.body.data.rides, 1);
assert.equal(earn.body.data.driverEarnings, 372);
assert.equal((await call('POST', `/drivers/share/trips/${trip.body.data.id}/complete`, tDriver, {})).status, 200);
assert.equal((await call('GET', '/drivers/share/trip', tDriver)).body.data, null);
const done = await call('GET', `/users/share-rides/${made.id}`, tUser);
assert.equal(done.body.data.status, 'completed');
assert.equal((await call('GET', '/users/share-rides?status=history', tUser)).body.data.length, 1);

// ---- owner
assert.equal((await call('POST', '/drivers/fleet/share/trips', tOwner, { driverId: String(fleet._id), origin: { lat: 'x' }, destination: {} })).status, 400, 'bad places');
const created = await call('POST', '/drivers/fleet/share/trips', tOwner, {
  driverId: String(fleet._id), origin: place(RAJWADA, 'Indore'), destination: place(DEWAS, 'Dewas'), seatsTotal: 2,
});
assert.equal(created.status, 201, JSON.stringify(created.body));
assert.equal(created.body.data.createdBy, 'owner');
assert.equal((await call('POST', '/drivers/fleet/share/trips', tOwner, { driverId: String(driver._id), origin: place(RAJWADA), destination: place(DEWAS) })).status, 404, 'not my fleet');
const second = await svc.createShareRide({ user: other, body: { pickup: place(VIJAY_NAGAR, 'Vijay Nagar'), drop: place(DEWAS, 'Dewas'), seats: 1 }, deps });
assert.equal((await call('POST', `/drivers/share/requests/${second.id}/accept`, tFleet, {})).status, 200, 'the fleet driver takes a rider on the owner trip');
const otpSecond = (await call('GET', `/users/share-rides/${second.id}`, tOther)).body.data.otp;
await call('POST', `/drivers/share/rides/${second.id}/pickup`, tFleet, { otp: otpSecond });
await call('POST', `/drivers/share/rides/${second.id}/complete`, tFleet, { collectedVia: 'upi' });
const over = await call('GET', '/drivers/fleet/share/overview', tOwner);
assert.equal(over.status, 200);
assert.equal(over.body.data.totals.rides, 1);
assert.equal(over.body.data.drivers.length, 1);
assert.equal(over.body.data.drivers[0].shareEnabled, true);
assert.equal((await call('GET', '/drivers/fleet/share/rides', tOwner)).body.data.results.length, 1);
assert.equal((await call('GET', '/drivers/fleet/share/trips?status=active', tOwner)).body.data.length, 1);
const off = await call('PATCH', `/drivers/fleet/share/drivers/${fleet._id}`, tOwner, { enabled: false });
assert.equal(off.body.data.shareEnabled, false);
assert.equal((await call('GET', '/drivers/share/status', tFleet)).body.data.eligible, false, 'switched off by the owner');
assert.equal((await call('PATCH', `/drivers/fleet/share/drivers/${driver._id}`, tOwner, { enabled: false })).status, 404, 'not my driver');
const tripId = created.body.data.id;
assert.equal((await call('POST', `/drivers/fleet/share/trips/${tripId}/cancel`, tOwner, {})).status, 200);

// ---- admin: sees it all, changes nothing
const adm = await call('GET', '/admin/share-rides/overview', tAdmin);
assert.equal(adm.status, 200);
assert.equal(adm.body.data.totals.rides, 2);
assert.equal(adm.body.data.walletPending, 0);
const admRides = await call('GET', '/admin/share-rides/rides?status=completed', tAdmin);
assert.equal(admRides.body.data.results.length, 2);
assert.equal(admRides.body.data.paginator.total, 2);
assert.equal((await call('GET', '/admin/share-rides/rides?search=Asha', tAdmin)).body.data.results.length, 1);
assert.ok((await call('GET', '/admin/share-rides/trips', tAdmin)).body.data.results.length >= 2);
for (const [method, path] of [['POST', '/admin/share-rides/trips'], ['PATCH', `/admin/share-rides/rides/${made.id}`], ['DELETE', `/admin/share-rides/rides/${made.id}`], ['PUT', '/admin/share-rides/overview']]) {
  const r = await call(method, path, tAdmin, {});
  assert.ok([404, 405].includes(r.status), `admin ${method} ${path} must not exist (got ${r.status})`);
}
assert.equal(await ShareRide.countDocuments({ status: 'completed' }), 2, 'admin calls changed nothing');

// ---- quote is rate limited (it calls a billed routing service)
let limited = 0;
for (let i = 0; i < 70; i += 1) {
  const r = await call('POST', '/users/share-rides/quote', tOther, { pickup: place(RAJWADA), drop: place(DEWAS), seats: 1 });
  if (r.status === 429) limited += 1;
}
assert.ok(limited > 0, 'too many quotes are refused with 429');

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('share ride http: all checks passed');
process.exit(0);
