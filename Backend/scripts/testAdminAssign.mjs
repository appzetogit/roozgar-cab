// Admin gives a booking to a driver (only the drivers of the rider's zone who are free), and the new-booking alert to the admin panel,
// against a THROWAWAY Mongo.
//   ADMIN_ASSIGN_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testAdminAssign.mjs
// Drops its own database (admin_assign_test) when done. Never point it at production.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.ADMIN_ASSIGN_TEST_MONGODB_URI;
if (!uri) throw new Error('Set ADMIN_ASSIGN_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB_NAME: 'admin_assign_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test' });

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

await mongoose.connect(uri, { dbName: 'admin_assign_test' });
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

// ---- 1. the list: only this zone's, free, online, right vehicle, able to take a ride; nearest first
const ride = await book();
assert.equal(String(ride.zone_id), String(zoneA), 'the booking carries the zone of the rider pickup');
const list = await call('GET', `/admin/ride-requests/${ride._id}/assignable-drivers`, tAdmin);
assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 200));
const names = list.body.data.drivers.map((d) => d.name);
assert.deepEqual(names, ['Near Driver', 'Farther Driver'], 'only the free, online, approved drivers of Indore City Zone with the booked vehicle and a pass, nearest first');
assert.equal(list.body.data.zone.name, 'Indore City Zone');
assert.ok(list.body.data.drivers[0].distanceKm <= list.body.data.drivers[1].distanceKm);
assert.equal(list.body.data.total, 2);
const everyone = JSON.stringify(list.body);
for (const hidden of [otherZone, offline, busy, wrongVehicle, blocked, unapproved, noPass]) assert.ok(!everyone.includes(hidden.name), `${hidden.name} is not offered`);

// ---- 2. who may do it
assert.equal((await call('GET', `/admin/ride-requests/${ride._id}/assignable-drivers`, tLimited)).status, 403, 'an admin without trips access cannot');
assert.equal((await call('GET', `/admin/ride-requests/${ride._id}/assignable-drivers`)).status, 401);
assert.equal((await call('GET', `/admin/ride-requests/not-an-id/assignable-drivers`, tAdmin)).status, 400);

// ---- 3. a driver from another zone, an offline one or a busy one cannot be assigned
for (const refused of [otherZone, offline, busy, wrongVehicle, blocked, noPass]) {
  const response = await call('POST', `/admin/ride-requests/${ride._id}/assign-driver`, tAdmin, { driverId: String(refused._id) });
  assert.equal(response.status, 409, `${refused.name}: ${JSON.stringify(response.body).slice(0, 160)}`);
}
assert.equal((await call('POST', `/admin/ride-requests/${ride._id}/assign-driver`, tAdmin, {})).status, 400, 'a driver must be chosen');
assert.equal((await Ride.findById(ride._id).lean()).status, 'searching', 'refused assignments change nothing');

// ---- 4. assign one: the ride is accepted by that driver, exactly as if they had accepted it
const assigned = await call('POST', `/admin/ride-requests/${ride._id}/assign-driver`, tAdmin, { driverId: String(near._id) });
assert.equal(assigned.status, 200, JSON.stringify(assigned.body).slice(0, 200));
assert.equal(assigned.body.data.driver.name, 'Near Driver');
const after = await Ride.findById(ride._id).lean();
assert.deepEqual([after.status, after.liveStatus, String(after.driverId)], ['accepted', 'accepted', String(near._id)]);
assert.equal(after.assignedBy, 'admin:Super');
assert.ok(after.assignedAt && after.acceptedAt);
assert.equal((await Driver.findById(near._id).lean()).isOnRide, true, 'the driver is now on this ride');

// ---- 5. it cannot be assigned twice, and the list closes
assert.equal((await call('POST', `/admin/ride-requests/${ride._id}/assign-driver`, tAdmin, { driverId: String(farther._id) })).status, 409);
assert.equal((await call('GET', `/admin/ride-requests/${ride._id}/assignable-drivers`, tAdmin)).status, 409);
const rows = (await call('GET', '/admin/ride-requests?limit=50', tAdmin)).body.data.results;
const row = rows.find((r) => r.id === String(ride._id));
assert.equal(row.assignedBy, 'admin:Super', 'the Trips list shows it was assigned by an admin');
assert.equal(row.driverName, 'Near Driver');

// the driver then runs the trip normally
await rides.updateRideLifecycle({ rideId: String(ride._id), driverId: near._id, nextStatus: 'arriving' });
assert.equal((await Ride.findById(ride._id).lean()).liveStatus, 'arriving');

// ---- 6. a cancelled or already finished booking cannot be assigned
const gone = await book();
await call('POST', `/admin/ride-requests/${gone._id}/cancel`, tAdmin, { reason: 'test' });
assert.equal((await call('POST', `/admin/ride-requests/${gone._id}/assign-driver`, tAdmin, { driverId: String(farther._id) })).status, 409);

// ---- 7. a booking with no zone at its pickup falls back to its city; with neither, nobody is offered
const noZone = await book({ service_location_id: String(sl) });
await Ride.updateOne({ _id: noZone._id }, { $set: { zone_id: null, pickupLocation: { type: 'Point', coordinates: [60, 10] } } });
const fallback = await call('GET', `/admin/ride-requests/${noZone._id}/assignable-drivers`, tAdmin);
assert.equal(fallback.status, 200);
assert.ok(fallback.body.data.drivers.length >= 1, 'the drivers of the booking city are offered');
await Ride.updateOne({ _id: noZone._id }, { $set: { service_location_id: null } });
assert.equal((await call('GET', `/admin/ride-requests/${noZone._id}/assignable-drivers`, tAdmin)).body.data.drivers.length, 0);

// ---- 8. the admin panel hears about every new booking (the alert sound)
const heard = [];
dispatch.setSocketServer({ to: (room) => ({ emit: (event, payload) => heard.push({ room, event, payload }) }) });
const fresh = await book();
await dispatch.announceNewBooking(fresh);
const alert = heard.find((h) => h.event === 'new_booking');
assert.ok(alert, 'new_booking reaches the admin room');
assert.equal(alert.room, dispatch.getAdminRoom());
assert.deepEqual([alert.payload.type, alert.payload.kind, alert.payload.kindLabel], ['city', 'city', 'City Ride']);
assert.match(alert.payload.requestId, /^REQ_[0-9A-F]{12}$/);
assert.deepEqual([alert.payload.userName, alert.payload.fare, alert.payload.pickupAddress], ['Rider One', 200, 'Palasia, Indore']);
heard.length = 0;
const parcelLike = await book({ serviceType: 'parcel', parcel: { category: 'documents', senderName: 'S', receiverName: 'R' } });
await dispatch.announceNewBooking(parcelLike);
assert.match(heard.find((h) => h.event === 'new_booking').payload.requestId, /^DEL_/, 'a parcel keeps its DEL_ id and type');
assert.equal(heard.find((h) => h.event === 'new_booking').payload.type, 'parcel');
// never throws: a ride that is gone is simply not announced
heard.length = 0;
await dispatch.announceNewBooking({ _id: new mongoose.Types.ObjectId() });
assert.equal(heard.length, 0);

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('admin assign + new booking alert: all checks passed');
process.exit(0);
