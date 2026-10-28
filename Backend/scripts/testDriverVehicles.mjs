// Smoke test for several vehicles per driver, against a THROWAWAY Mongo.
//   DRIVER_VEHICLES_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testDriverVehicles.mjs
// Drops its own database (driver_vehicles_test) when done. Never point it at production.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.DRIVER_VEHICLES_TEST_MONGODB_URI;
if (!uri) throw new Error('Set DRIVER_VEHICLES_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, {
  MONGODB_URI: uri, MONGODB_DB_NAME: 'driver_vehicles_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test',
});

const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { DriverVehicleRequest } = await import('../src/modules/taxi/driver/models/DriverVehicleRequest.js');
const svc = await import('../src/modules/taxi/driver/services/driverVehicleService.js');

await mongoose.connect(uri, { dbName: 'driver_vehicles_test' });
await mongoose.connection.dropDatabase();

const failsWith = async (promise, status, label) => {
  try { await promise; } catch (error) { assert.equal(error.statusCode ?? error.status, status, `${label}: ${error.message}`); return error; }
  assert.fail(`${label}: expected ${status}`);
};
// The same shape dispatch uses to pick drivers for a ride of one vehicle type.
const receives = async (driverId, vehicleTypeId) =>
  Boolean(await Driver.exists({
    _id: driverId, isOnline: true, isOnRide: false,
    $or: [{ vehicleTypeId: { $in: [vehicleTypeId] } }, { vehicleTypeIds: { $in: [vehicleTypeId] } }],
  }));

const vehicleDoc = (name, icon) => ({ name, icon_types: icon, transport_type: 'taxi', active: true, status: 1 });
const bikeType = await Vehicle.collection.insertOne({ ...vehicleDoc('Roozgar Bike', 'bike'), createdAt: new Date() });
const carType = await Vehicle.collection.insertOne({ ...vehicleDoc('Roozgar Sedan', 'car'), createdAt: new Date() });
const bikeId = bikeType.insertedId;
const carId = carType.insertedId;

const driver = await Driver.create({
  name: 'Test Driver', phone: '9000000099', password: 'x-test-password', approve: true, status: 'approved', isOnline: true,
  vehicleType: 'bike', vehicleTypeId: bikeId, vehicleTypeIds: [bikeId], vehicleIconType: 'bike',
  vehicleNumber: 'MH12AB1234', vehicleColor: 'black',
});
const did = driver._id;

// 1. a driver who never added a vehicle still has exactly one, and it is active
let list = await svc.listDriverVehicles(did);
assert.equal(list.vehicles.length, 1);
assert.equal(list.vehicles[0].isActive, true);
assert.equal(list.vehicles[0].vehicleNumber, 'MH12AB1234');
assert.equal(list.canAdd, true);

// 2. requesting a car: validation, then pending, and nothing changes for dispatch
await failsWith(svc.requestDriverVehicle(did, { vehicleTypeId: carId, vehicleNumber: 'BAD', vehicleColor: 'white' }), 400, 'bad plate');
await failsWith(svc.requestDriverVehicle(did, { vehicleTypeId: carId, vehicleNumber: 'MH14CD5678' }), 400, 'no color');
await failsWith(svc.requestDriverVehicle(did, { vehicleTypeId: new mongoose.Types.ObjectId(), vehicleNumber: 'MH14CD5678', vehicleColor: 'white' }), 404, 'unknown type');
await failsWith(svc.requestDriverVehicle(did, { vehicleTypeId: bikeId, vehicleNumber: 'mh 12-ab 1234', vehicleColor: 'red' }), 409, 'own current number');
const request = await svc.requestDriverVehicle(did, { vehicleTypeId: carId, vehicleNumber: 'mh14 cd-5678', vehicleColor: 'white', vehicleMake: 'Maruti', vehicleModel: 'Dzire' });
assert.equal(request.status, 'pending');
assert.equal(request.vehicleNumber, 'MH14CD5678');
await failsWith(svc.requestDriverVehicle(did, { vehicleTypeId: carId, vehicleNumber: 'MH14CD5678', vehicleColor: 'white' }), 409, 'duplicate pending');
const afterRequest = await Driver.findById(did).lean();
assert.equal(afterRequest.approve, true);
assert.equal(afterRequest.isOnline, true);
assert.equal(String(afterRequest.vehicleTypeId), String(bikeId));
assert.equal(await receives(did, carId), false, 'a pending car must not receive car bookings');
assert.equal(await receives(did, bikeId), true);
list = await svc.listDriverVehicles(did);
assert.equal(list.requests.length, 1);
assert.equal(list.vehicles.length, 1);

// 3. admin approval adds it to the list but does not switch to it; approving twice fails
const approved = await svc.approveDriverVehicleRequest(request.id);
assert.equal(approved.status, 'approved');
await failsWith(svc.approveDriverVehicleRequest(request.id), 404, 'approve twice');
list = await svc.listDriverVehicles(did);
assert.equal(list.vehicles.length, 2);
assert.equal(list.requests.length, 0);
const bike = list.vehicles.find((v) => v.vehicleNumber === 'MH12AB1234');
const car = list.vehicles.find((v) => v.vehicleNumber === 'MH14CD5678');
assert.equal(bike.isActive, true);
assert.equal(car.isActive, false);
assert.equal(await receives(did, carId), false, 'approved but not active: still no car bookings');

// 4. switching: refused mid-ride; afterwards bookings follow the active vehicle
await Driver.updateOne({ _id: did }, { isOnRide: true });
await failsWith(svc.activateDriverVehicle(did, car.id), 409, 'switch while on ride');
await Driver.updateOne({ _id: did }, { isOnRide: false });
list = await svc.activateDriverVehicle(did, car.id);
assert.equal(list.activeVehicleId, car.id);
assert.equal(await receives(did, carId), true, 'car active -> car bookings');
assert.equal(await receives(did, bikeId), false, 'car active -> no bike bookings');
const onCar = await Driver.findById(did).lean();
assert.equal(onCar.vehicleNumber, 'MH14CD5678');
assert.equal(onCar.vehicleType, 'car');
assert.equal(onCar.vehicleMake, 'Maruti');
assert.equal(onCar.isOnline, true, 'switching keeps the driver online');

// 5. edits made to the active vehicle survive switching away and back
await Driver.updateOne({ _id: did }, { vehicleColor: 'silver' });
await svc.activateDriverVehicle(did, bike.id);
assert.equal(await receives(did, bikeId), true);
assert.equal(await receives(did, carId), false);
await svc.activateDriverVehicle(did, car.id);
assert.equal((await Driver.findById(did).lean()).vehicleColor, 'silver');
await svc.activateDriverVehicle(did, car.id); // already active: no-op
await failsWith(svc.removeDriverVehicle(did, car.id), 409, 'remove active');
list = await svc.removeDriverVehicle(did, bike.id);
assert.equal(list.vehicles.length, 1);
await failsWith(svc.activateDriverVehicle(did, bike.id), 404, 'removed vehicle');

// 6. reject and cancel; a number owned by another driver cannot be requested
await failsWith(svc.requestDriverVehicle(did, { vehicleTypeId: bikeId, vehicleNumber: 'MH14CD5678', vehicleColor: 'x' }), 409, 'already mine');
const second = await svc.requestDriverVehicle(did, { vehicleTypeId: bikeId, vehicleNumber: 'KA051234', vehicleColor: 'blue' });
const rejected = await svc.rejectDriverVehicleRequest(second.id, { reason: 'Photo is unclear' });
assert.equal(rejected.status, 'rejected');
list = await svc.listDriverVehicles(did);
assert.equal(list.requests[0].status, 'rejected');
assert.equal(list.requests[0].rejectionReason, 'Photo is unclear');
const third = await svc.requestDriverVehicle(did, { vehicleTypeId: bikeId, vehicleNumber: 'KA059999', vehicleColor: 'blue' });
await svc.cancelDriverVehicleRequest(did, third.id);
await failsWith(svc.cancelDriverVehicleRequest(did, third.id), 404, 'cancel twice');

// 7. admin listing
const other = await Driver.create({
  name: 'Other', phone: '9000000098', password: 'x-test-password', approve: true, status: 'approved',
  vehicleType: 'car', vehicleTypeId: carId, vehicleTypeIds: [carId], vehicleNumber: 'DL1ABCD1234', vehicleColor: 'grey',
});
await failsWith(svc.requestDriverVehicle(did, { vehicleTypeId: carId, vehicleNumber: 'DL1ABCD1234', vehicleColor: 'grey' }), 409, "other driver's number");
const pendingForOther = await svc.requestDriverVehicle(other._id, { vehicleTypeId: bikeId, vehicleNumber: 'GJ011111', vehicleColor: 'red' });
const adminList = await svc.listDriverVehicleRequests({ status: 'pending' });
assert.equal(adminList.results.length, 1);
assert.equal(adminList.pendingCount, 1);
assert.equal(adminList.results[0].driver.name, 'Other');
assert.equal(adminList.results[0].vehicleTypeName, 'Roozgar Bike');
assert.equal((await svc.listDriverVehicleRequests({ status: 'pending', search: 'GJ01' })).results.length, 1);
assert.equal((await svc.listDriverVehicleRequests({ status: 'pending', search: 'nomatch' })).results.length, 0);
assert.equal((await svc.listDriverVehicleRequests({ status: 'all' })).results.length, 3); // approved + rejected + pending; cancelled is hidden

// 8. fleet drivers and unapproved drivers cannot add vehicles
await Driver.updateOne({ _id: other._id }, { owner_id: new mongoose.Types.ObjectId() });
await failsWith(svc.requestDriverVehicle(other._id, { vehicleTypeId: carId, vehicleNumber: 'GJ012222', vehicleColor: 'red' }), 403, 'fleet driver');
await Driver.updateOne({ _id: other._id }, { owner_id: null, approve: false });
await failsWith(svc.requestDriverVehicle(other._id, { vehicleTypeId: carId, vehicleNumber: 'GJ012222', vehicleColor: 'red' }), 409, 'unapproved driver');
assert.ok(pendingForOther.id);
assert.equal(await DriverVehicleRequest.countDocuments({ status: 'pending' }), 1);

await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('driver vehicles: all checks passed');
process.exit(0);
