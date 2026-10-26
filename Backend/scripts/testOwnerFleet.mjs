// Smoke test for the fleet-owner endpoints, against a THROWAWAY Mongo.
//   FEED_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testOwnerFleet.mjs
// Drops its own database (owner_fleet_test) when done. Never point it at production.
import assert from 'node:assert/strict';
import http from 'node:http';

const uri = process.env.FEED_TEST_MONGODB_URI;
if (!uri) throw new Error('Set FEED_TEST_MONGODB_URI to a throwaway Mongo');

Object.assign(process.env, {
  MONGODB_URI: uri,
  MONGODB_DB_NAME: 'owner_fleet_test',
  JWT_SECRET: 'test-secret',
  FIREBASE_SERVICE_ACCOUNT_JSON: '',
  FIREBASE_DATABASE_URL: '',
});

const { default: mongoose } = await import('mongoose');
const { default: express } = await import('express');
const { driverRouter } = await import('../src/modules/taxi/driver/routes/driverRoutes.js');
const { errorHandler } = await import('../src/modules/taxi/middlewares/errorMiddleware.js');
const { signAccessToken } = await import('../src/modules/taxi/services/tokenService.js');

await mongoose.connect(uri, { dbName: 'owner_fleet_test' });
await mongoose.connection.dropDatabase();
const col = (name) => mongoose.connection.collection(name);

const app = express();
app.use(express.json());
app.use('/api/v1/drivers', driverRouter);
app.use(errorHandler);
const server = http.createServer(app).listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/v1/drivers`;

const oid = () => new mongoose.Types.ObjectId();
const call = async (token, method, url, body) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const makeOwner = async (extra) => {
  const _id = oid();
  await col('taxiowners').insertOne({
    _id, name: 'Owner', mobile: `97${Math.floor(Math.random() * 1e8)}`, active: true, ...extra,
  });
  return signAccessToken({ sub: String(_id), role: 'owner' });
};
const ownerDoc = async (token) => (await col('taxiowners').findOne({}, { sort: { _id: -1 } }));

// ---- 2.1 pending vs not-an-owner ----
const pendingToken = await makeOwner({ approve: false, status: 'pending' });
const pending = await call(pendingToken, 'GET', '/fleet/drivers');
assert.deepEqual([pending.status, pending.json.code], [403, 'OWNER_PENDING_APPROVAL']);

const approvedToken = await makeOwner({ approve: true, status: 'approved' });
const owner = await ownerDoc(approvedToken);
assert.equal((await call(approvedToken, 'GET', '/fleet/drivers')).status, 200);

// ---- zones, vehicle ----
const zoneA = oid();
const zoneB = oid();
await col('taxizones').insertMany([
  { _id: zoneA, name: 'Zone A', active: true, status: 'active' },
  { _id: zoneB, name: 'Zone B', active: true, status: 'active' },
]);
const vehicle = oid();
await col('taxifleetvehicles').insertOne({
  _id: vehicle, owner_id: owner._id, active: true, car_brand: 'Maruti', car_model: 'Dzire',
  license_plate_number: 'MP09AB1234', car_color: 'White', status: 'approved',
});

// ---- create driver with a zone ----
const created = await call(approvedToken, 'POST', '/fleet/drivers', { name: 'Ravi', phone: '9000000001', salary: 15000, zoneId: String(zoneA) });
assert.equal(created.status, 201, JSON.stringify(created.json));
const driverId = created.json.data.id;
assert.equal(String((await col('taxidrivers').findOne({ _id: new mongoose.Types.ObjectId(driverId) })).zoneId), String(zoneA));
assert.equal((await call(approvedToken, 'POST', '/fleet/drivers', { name: 'X', phone: '9000000002', zoneId: 'nope' })).status, 400);

// ---- PATCH changes only what it carries ----
const assign = await call(approvedToken, 'PATCH', `/fleet/drivers/${driverId}`, { assignedFleetVehicleId: String(vehicle) });
assert.equal(assign.status, 200, JSON.stringify(assign.json));
assert.equal(assign.json.data.zone.zoneId, String(zoneA), 'zone kept when only the vehicle is sent');

const rename = await call(approvedToken, 'PATCH', `/fleet/drivers/${driverId}`, { name: 'Ravi K' });
assert.equal(rename.status, 200, JSON.stringify(rename.json));
assert.equal(rename.json.data.name, 'Ravi K');
assert.equal(rename.json.data.salary, 15000, 'salary kept');
assert.equal(rename.json.data.assignedVehicle.vehicleId, String(vehicle), 'vehicle kept');
assert.equal(rename.json.data.zone.zoneId, String(zoneA), 'zone kept');

const moved = await call(approvedToken, 'PATCH', `/fleet/drivers/${driverId}`, { zoneId: String(zoneB) });
assert.equal(moved.json.data.zone.zoneId, String(zoneB));
assert.equal(moved.json.data.assignedVehicle.vehicleId, String(vehicle), 'vehicle kept when only the zone is sent');

const cleared = await call(approvedToken, 'PATCH', `/fleet/drivers/${driverId}`, { zoneId: '', assignedFleetVehicleId: '' });
assert.deepEqual([cleared.json.data.zone, cleared.json.data.assignedVehicle], [null, null], 'empty string still clears');

// ---- delete ----
await col('taxidrivers').updateOne({ _id: new mongoose.Types.ObjectId(driverId) }, { $set: { isOnRide: true } });
assert.equal((await call(approvedToken, 'DELETE', `/fleet/drivers/${driverId}`)).status, 409, 'not while on a ride');
await col('taxidrivers').updateOne({ _id: new mongoose.Types.ObjectId(driverId) }, { $set: { isOnRide: false } });
const otherOwnerToken = await makeOwner({ approve: true, status: 'approved' });
assert.equal((await call(otherOwnerToken, 'DELETE', `/fleet/drivers/${driverId}`)).status, 404, 'another owner cannot delete it');
assert.equal((await call(approvedToken, 'DELETE', `/fleet/drivers/${driverId}`)).status, 200);
assert.ok((await col('taxidrivers').findOne({ _id: new mongoose.Types.ObjectId(driverId) })).deletedAt);
assert.equal((await call(approvedToken, 'GET', '/fleet/drivers')).json.data.results?.length ?? 0, 0, 'deleted driver is not listed');

// ---- 2.2 fleet vehicle documents ----
const doc = (slug, account_type) => ({
  name: slug, slug, account_type, active: true, is_required: true, template_type: 'document',
  image_type: 'image', key: slug, createdAt: new Date(), updatedAt: new Date(),
});
await col('taxidriverneededdocuments').insertMany([
  doc('licence', 'individual'), doc('fleet-rc', 'fleet_drivers'), doc('both-doc', 'both'),
]);
const templates = await call(approvedToken, 'GET', '/document-templates?role=fleet_vehicle');
const names = (templates.json?.data?.results || []).map((t) => t.slug || t.name);
assert.ok(names.includes('fleet-rc') && names.includes('both-doc'), `fleet docs listed: ${names}`);
assert.ok(!names.includes('licence'), 'individual-driver documents are not asked of fleet vehicles');

console.log('owner fleet: all checks passed');
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
server.close();
process.exit(0);
