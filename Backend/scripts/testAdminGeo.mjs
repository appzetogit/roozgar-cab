// Admin Heat Map + Gods Eye endpoints against a THROWAWAY Mongo.
//   ADMIN_GEO_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testAdminGeo.mjs
// Drops its own database (admin_geo_test) when done. Never point it at production.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.ADMIN_GEO_TEST_MONGODB_URI;
if (!uri) throw new Error('Set ADMIN_GEO_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB_NAME: 'admin_geo_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test' });

const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/modules/taxi/services/tokenService.js');
const { Admin } = await import('../src/modules/taxi/admin/models/Admin.js');
const { Ride } = await import('../src/modules/taxi/user/models/Ride.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { SafetyAlert } = await import('../src/modules/taxi/common/models/SafetyAlert.js');

await mongoose.connect(uri, { dbName: 'admin_geo_test' });
await mongoose.connection.dropDatabase();

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const get = async (path, token) => {
  const r = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  const locA = new mongoose.Types.ObjectId();
  const locB = new mongoose.Types.ObjectId();
  const { insertedId: superId } = await Admin.collection.insertOne({ name: 'Super', email: 'super@example.com', password: 'x', createdAt: new Date() });
  const { insertedId: subId } = await Admin.collection.insertOne({
    name: 'Sub', email: 'sub@example.com', password: 'x', admin_type: 'subadmin', service_location_ids: [locA], createdAt: new Date(),
  });
  const token = signAccessToken({ sub: String(superId), role: 'admin' });
  const subToken = signAccessToken({ sub: String(subId), role: 'admin' });

  const pt = (lat, lng) => ({ type: 'Point', coordinates: [lng, lat] });
  const hoursAgo = (h) => new Date(Date.now() - h * 3600e3);
  const busyDriverId = new mongoose.Types.ObjectId();
  const ride = (over) => ({
    userId: new mongoose.Types.ObjectId(), status: 'searching', liveStatus: 'searching', fare: 100, serviceType: 'ride',
    pickupLocation: pt(22.72, 75.86), dropLocation: pt(22.75, 75.9), pickupAddress: 'Vijay Nagar, Indore', dropAddress: 'Palasia, Indore',
    adminDeletedAt: null, service_location_id: locA, createdAt: new Date(), updatedAt: new Date(), ...over,
  });
  await Ride.collection.insertMany([
    ride({}), // searching, today
    ride({ status: 'completed', liveStatus: 'completed', createdAt: hoursAgo(72) }),
    ride({ status: 'cancelled', liveStatus: 'completed', createdAt: hoursAgo(1), pickupLocation: pt(22.9, 75.7) }),
    ride({ pickupLocation: { type: 'Point', coordinates: [0, 0] } }), // website placeholder: skipped on the map
    ride({ serviceType: 'intercity', service_location_id: locB }), // other location
    ride({ status: 'ongoing', liveStatus: 'started', driverId: busyDriverId, fare: 250 }),
  ]);

  const fresh = new Date();
  const mkDriver = (n, over) => ({
    name: `Driver ${n}`, phone: `90000000${n}`, isOnline: true, isOnRide: false, deletedAt: null, service_location_id: locA,
    location: pt(22.7 + n / 100, 75.85), locationUpdatedAt: fresh, createdAt: fresh, updatedAt: fresh, vehicleNumber: `MP09-${n}`, ...over,
  });
  await Driver.collection.insertMany([
    mkDriver(1, {}),
    mkDriver(2, { _id: busyDriverId, isOnRide: true, heading: 90 }),
    mkDriver(3, { locationUpdatedAt: hoursAgo(2), updatedAt: hoursAgo(2) }), // stale GPS
    mkDriver(4, { isOnline: false }),
    mkDriver(5, { location: pt(0, 0) }), // no GPS fix
    mkDriver(6, { service_location_id: locB }),
  ]);
  await SafetyAlert.collection.insertMany([
    { status: 'active', sourceApp: 'user', rideId: null, location: pt(22.71, 75.86), riderName: 'R', createdAt: new Date(), updatedAt: new Date() },
    { status: 'resolved', sourceApp: 'user', location: pt(22.71, 75.86), createdAt: new Date(), updatedAt: new Date() },
  ]);

  // auth
  assert.equal((await get('/admin/geo/live')).status, 401);
  assert.equal((await get('/admin/geo/heatmap-points')).status, 401);

  // heatmap: requests, [0,0] skipped
  let r = await get('/admin/geo/heatmap-points?layer=requests', token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let d = r.body.data;
  assert.equal(d.points.length, 5, 'six rides minus the [0,0] one');
  assert.equal(d.mapped, 5);
  assert.equal(d.truncated, false);
  assert.ok(d.byArea[0].count >= 3 && /Vijay Nagar/.test(d.byArea[0].label), 'top area is the busiest pickup');
  assert.equal(d.byHour.reduce((a, b) => a + b, 0), 5);
  assert.equal(d.points.every((p) => p.lat > 22 && p.lng > 75), true, 'lat/lng order');

  // filters
  const day = (h) => new Date(Date.now() - h * 3600e3).toISOString().slice(0, 10);
  d = (await get(`/admin/geo/heatmap-points?from=${day(24)}`, token)).body.data;
  assert.equal(d.points.length, 4, 'date range drops the 72h-old ride');
  d = (await get('/admin/geo/heatmap-points?layer=completed', token)).body.data;
  assert.equal(d.points.length, 1);
  d = (await get('/admin/geo/heatmap-points?layer=cancelled', token)).body.data;
  assert.equal(d.points.length, 1);
  d = (await get('/admin/geo/heatmap-points?kind=outstation', token)).body.data;
  assert.equal(d.points.length, 1);
  d = (await get('/admin/geo/heatmap-points?status=searching', token)).body.data;
  assert.equal(d.points.length, 2, 'two searching rides with a real pickup (locA + locB)');
  d = (await get('/admin/geo/heatmap-points?layer=drivers', token)).body.data;
  assert.equal(d.points.length, 4, 'online drivers with a real fix; offline and [0,0] excluded');
  d = (await get('/admin/geo/heatmap-points?layer=sos', token)).body.data;
  assert.equal(d.points.length, 2);

  // sub-admin sees only their service location
  d = (await get('/admin/geo/heatmap-points', subToken)).body.data;
  assert.equal(d.points.length, 4);

  // live
  r = await get('/admin/geo/live', token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  d = r.body.data;
  assert.deepEqual(d.drivers.map((x) => x.name).sort(), ['Driver 1', 'Driver 2', 'Driver 6'], 'only fresh, online, with GPS');
  const busy = d.drivers.find((x) => x.name === 'Driver 2');
  assert.equal(busy.isOnRide, true);
  assert.ok(busy.rideId, 'driver on a trip links to its ride');
  assert.equal(busy.heading, 90);
  assert.equal(d.rides.length, 4, 'searching + ongoing rides (completed/cancelled excluded)');
  assert.equal(d.counts.onlineDrivers, 3);
  assert.equal(d.counts.onTripDrivers, 1);
  assert.equal(d.counts.idleDrivers, 2);
  assert.equal(d.counts.searchingRides, 3);
  assert.equal(d.counts.openAlerts, 1);
  assert.equal(d.alerts[0].lat, 22.71);
  assert.ok(d.at);
  d = (await get('/admin/geo/live', subToken)).body.data;
  assert.deepEqual(d.drivers.map((x) => x.name).sort(), ['Driver 1', 'Driver 2']);
  assert.equal(d.rides.length, 3);

  console.log('admin geo: all assertions passed');
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  server.close();
}
process.exit(0);
