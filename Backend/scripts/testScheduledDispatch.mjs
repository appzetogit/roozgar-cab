// Scheduled rides: not cancelled early, cancel fields, dispatchStartsAt, against a THROWAWAY Mongo.
//   SCHED_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testAdminAssign.mjs
// Drops its own database (sched_dispatch_test) when done. Never point it at production.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.SCHED_TEST_MONGODB_URI;
if (!uri) throw new Error('Set SCHED_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, { SCHEDULED_DISPATCH_LEAD_MINUTES: '60', MONGODB_URI: uri, MONGODB_DB_NAME: 'sched_dispatch_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test' });

const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) =>
  String(url).startsWith('http://127.0.0.1') ? realFetch(url, ...rest) : Promise.reject(new Error('offline in test'));

const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/modules/taxi/services/tokenService.js');
const rides = await import('../src/modules/taxi/services/rideService.js');
const dispatch = await import('../src/modules/taxi/services/dispatchService.js');
const { installStandaloneTransactionShim } = await import('../src/config/database.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { Zone } = await import('../src/modules/taxi/driver/models/Zone.js');
const { DriverSubscription } = await import('../src/modules/taxi/driver/models/DriverSubscription.js');
const { User } = await import('../src/modules/taxi/user/models/User.js');
const { Admin } = await import('../src/modules/taxi/admin/models/Admin.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { SetPrice } = await import('../src/modules/taxi/admin/models/SetPrice.js');
const { ServiceLocation } = await import('../src/modules/taxi/admin/models/ServiceLocation.js');
const { Ride } = await import('../src/modules/taxi/user/models/Ride.js');

await mongoose.connect(uri, { dbName: 'sched_dispatch_test' });
await mongoose.connection.dropDatabase();
await installStandaloneTransactionShim();
await Promise.all([Driver.init(), Ride.init(), Zone.init()]);

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

const PICKUP = [75.8577, 22.7196];
const DROP = [75.9, 22.76];
const FAR = [78.4867, 17.385]; // another city
const ring = (c, d) => [[[c[0] - d, c[1] - d], [c[0] + d, c[1] - d], [c[0] + d, c[1] + d], [c[0] - d, c[1] + d], [c[0] - d, c[1] - d]]];
const sl = (await ServiceLocation.collection.insertOne({ name: 'Indore', service_location_name: 'Indore', status: 'active', active: true })).insertedId;
const zoneA = (await Zone.collection.insertOne({ name: 'Indore City Zone', service_location_id: sl, active: true, status: 'active', geometry: { type: 'Polygon', coordinates: ring(PICKUP, 0.3) } })).insertedId;
const zoneB = (await Zone.collection.insertOne({ name: 'Hyderabad Zone', service_location_id: sl, active: true, status: 'active', geometry: { type: 'Polygon', coordinates: ring(FAR, 0.3) } })).insertedId;

const mkVehicle = async (name, icon) => (await Vehicle.collection.insertOne({ name, icon_types: icon, category: icon, capacity: 4, transport_type: 'taxi', is_taxi: 'taxi', active: true, status: 1 })).insertedId;
const sedan = await mkVehicle('Sedan', 'car');
const suv = await mkVehicle('SUV', 'suv');
await SetPrice.create({
  zone_id: zoneA, service_location_id: sl, vehicle_type: sedan, transport_type: 'taxi', pricing_scope: 'ride', active: 1, status: 'active',
  payment_type: ['cash'], base_price: 70, base_distance: 2, price_per_distance: 15, time_price: 2, service_tax: 5,
});

const rider = await User.create({ name: 'Rider One', phone: '9000000091', city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
const adminDoc = (await Admin.collection.insertOne({ name: 'Super', email: 'super@example.com', password: 'x', createdAt: new Date() })).insertedId;
const tAdmin = tokenFor(adminDoc, 'admin');
const limited = (await Admin.collection.insertOne({ name: 'Limited', email: 'limited@example.com', password: 'x', admin_type: 'subadmin', permissions: ['users.view'], createdAt: new Date() })).insertedId;
const tLimited = tokenFor(limited, 'admin');

let phoneN = 10;
const mkDriver = (extra = {}) => Driver.create({
  name: `Driver ${phoneN}`, phone: `91000090${phoneN++}`, password: 'x-test-pass', approve: true, status: 'approved', isOnline: true, isOnRide: false,
  vehicleType: 'car', vehicleTypeId: sedan, vehicleTypeIds: [sedan], vehicleNumber: `MP09AB${phoneN}`, vehicleColor: 'white', zoneId: zoneA, service_location_id: sl,
  location: { type: 'Point', coordinates: PICKUP }, wallet: { balance: 1000 }, ...extra,
});
// A driver needs a paid pass to be offered rides unless the admin runs commission only (the default of an empty settings table).
const withPass = (driverId) => DriverSubscription.collection.insertOne({
  driverId, planId: new mongoose.Types.ObjectId(), planName: 'Day', amount: 50, vehicleClasses: ['car'], startsAt: new Date(Date.now() - 3600e3),
  expiresAt: new Date(Date.now() + 24 * 3600e3), status: 'active', paymentMethod: 'wallet', paidAt: new Date(), tripsCovered: 0, commissionWaived: 0,
});
const near = await mkDriver({ name: 'Near Driver' });
const farther = await mkDriver({ name: 'Farther Driver', location: { type: 'Point', coordinates: [PICKUP[0] + 0.02, PICKUP[1]] } });
const otherZone = await mkDriver({ name: 'Other Zone Driver', zoneId: zoneB, location: { type: 'Point', coordinates: FAR } });
const offline = await mkDriver({ name: 'Offline Driver', isOnline: false });
const busy = await mkDriver({ name: 'Busy Driver', isOnRide: true });
const wrongVehicle = await mkDriver({ name: 'SUV Driver', vehicleTypeId: suv, vehicleTypeIds: [suv] });
const blocked = await mkDriver({ name: 'Blocked Driver', wallet: { balance: 1000, isBlocked: true } });
const unapproved = await mkDriver({ name: 'Unapproved Driver', approve: false });
const noPass = await mkDriver({ name: 'No Pass Driver' });
for (const driver of [near, farther, otherZone, offline, busy, wrongVehicle, blocked, unapproved]) await withPass(driver._id);

const book = (extra = {}) => rides.createRideRecord({
  userId: rider._id, pickupCoords: PICKUP, dropCoords: DROP, pickupAddress: 'Palasia, Indore', dropAddress: 'Vijay Nagar, Indore', fare: 200,
  vehicleTypeId: String(sedan), paymentMethod: 'cash', serviceType: 'ride', estimatedDistanceMeters: 8000, estimatedDurationMinutes: 20, ...extra,
});


// pure deadline: pickup in 20 min, regular window 5 min, scheduled window 30 min
const cfg = { maxSearchSeconds: 300, maxScheduledSearchSeconds: 1800 };
const t0 = Date.now();
assert.equal(dispatch.scheduledSearchDeadlineMs(t0 + 20 * 60e3, t0, cfg), t0 + 20 * 60e3, 'searches until pickup');
assert.equal(dispatch.scheduledSearchDeadlineMs(t0 + 2 * 60e3, t0, cfg), t0 + 300e3, 'never shorter than a normal ride');
assert.equal(dispatch.scheduledSearchDeadlineMs(t0 + 5 * 3600e3, t0, cfg), t0 + 1800e3, 'never longer than the scheduled window');

const scheduledAt = new Date(Date.now() + 20 * 60e3);
const ride = await book({ scheduledAt });
await dispatch.startDispatchFlow(ride); // the booking endpoint does this right after creating the ride
await new Promise((resolve) => setTimeout(resolve, 2500));
let fresh = await Ride.findById(ride._id).lean();
assert.equal(fresh.status, 'searching', 'not cancelled while the window is open');
assert.ok(fresh.dispatchTracking.searchStartedAt, 'search start is stored');
const detail = rides.serializeRideRealtime(fresh);
assert.equal(new Date(detail.dispatchStartsAt).getTime(), scheduledAt.getTime() - 60 * 60e3, 'dispatchStartsAt = pickup minus lead');
assert.equal(detail.cancelledBy, '');
assert.equal(detail.cancelReason, '');
assert.equal(detail.cancelledAt, null);

// the window has run out (search began 2 hours ago): a restart closes it with a reason
await Ride.updateOne({ _id: ride._id }, { $set: { 'dispatchTracking.searchStartedAt': new Date(Date.now() - 2 * 3600e3) } });
await dispatch.startDispatchFlow(await Ride.findById(ride._id), { forceRestart: true });
await new Promise((resolve) => setTimeout(resolve, 1500));
fresh = await Ride.findById(ride._id).lean();
assert.equal(fresh.status, 'cancelled');
const cancelled = rides.serializeRideRealtime(fresh);
assert.equal(cancelled.cancelledBy, 'system');
assert.equal(cancelled.cancelReason, 'No driver accepted the request');
assert.ok(cancelled.cancelledAt);

console.log('scheduled dispatch checks passed');
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
server.close();
process.exit(0);
