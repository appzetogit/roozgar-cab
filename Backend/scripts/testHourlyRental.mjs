// Smoke test for Hourly Rental (cab with a driver by the hour/km), against a THROWAWAY Mongo.
//   HOURLY_RENTAL_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testHourlyRental.mjs
// Drops its own database (hourly_rental_test) when done. Never point it at production.
//
// Covers: admin setup over real HTTP (package names, package prices as the admin form
// sends them, permissions), the rider's package list, booking (price from the admin's
// package, not the app), dispatch matching and the accept gate for rental drivers, and
// the bill at the end of the trip (extra km and minutes). The wallet settlement after
// "completed" is not run here: it needs a replica-set Mongo (see the notes in the report).
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.HOURLY_RENTAL_TEST_MONGODB_URI;
if (!uri) throw new Error('Set HOURLY_RENTAL_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB_NAME: 'hourly_rental_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test' });

const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) =>
  String(url).startsWith('http://127.0.0.1') ? realFetch(url, ...rest) : Promise.reject(new Error('offline in test'));

const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/modules/taxi/services/tokenService.js');
const rental = await import('../src/modules/taxi/services/rentalPackageService.js');
const rides = await import('../src/modules/taxi/services/rideService.js');
const { matchDrivers } = await import('../src/modules/taxi/services/matchingService.js');
const admin = await import('../src/modules/taxi/admin/services/adminService.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { DriverSubscription } = await import('../src/modules/taxi/driver/models/DriverSubscription.js');
const { DriverLocationHistory } = await import('../src/modules/taxi/driver/models/DriverLocationHistory.js');
const { User } = await import('../src/modules/taxi/user/models/User.js');
const { Admin } = await import('../src/modules/taxi/admin/models/Admin.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { SetPrice } = await import('../src/modules/taxi/admin/models/SetPrice.js');
const { Ride } = await import('../src/modules/taxi/user/models/Ride.js');
const { ServiceLocation } = await import('../src/modules/taxi/admin/models/ServiceLocation.js');

await mongoose.connect(uri, { dbName: 'hourly_rental_test' });
await mongoose.connection.dropDatabase();
await Promise.all([Driver.init(), Ride.init(), SetPrice.init()]);

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
const failsWith = async (promise, status, label, code) => {
  try { await promise; } catch (error) {
    assert.equal(error.statusCode ?? error.status, status, `${label}: ${error.message}`);
    if (code) assert.equal(error.code, code, `${label}: code`);
    return error;
  }
  assert.fail(`${label}: expected ${status}`);
};

// ---------------------------------------------------------------- people and vehicles
const sedan = (await Vehicle.collection.insertOne({ name: 'Sedan', icon_types: 'car', capacity: 4, transport_type: 'taxi', active: true, status: 1 })).insertedId;
const suv = (await Vehicle.collection.insertOne({ name: 'SUV', icon_types: 'suv', capacity: 6, transport_type: 'taxi', active: true, status: 1 })).insertedId;
const PICKUP = [75.8577, 22.7196]; // [lng, lat], Indore
const DROP_FAR = [75.8577, 22.7196 + 0.2464]; // ~27.4 km due north

await Admin.collection.insertOne({ name: 'Super', email: 'super@example.com', password: 'x', createdAt: new Date() });
await Admin.collection.insertOne({ name: 'Sub', email: 'sub@example.com', password: 'x', admin_type: 'subadmin', permissions: [], createdAt: new Date() });
const superAdmin = await Admin.collection.findOne({ email: 'super@example.com' });
const subAdmin = await Admin.collection.findOne({ email: 'sub@example.com' });
const tSuper = tokenFor(superAdmin._id, 'admin');
const tSub = tokenFor(subAdmin._id, 'admin');

const rider = await User.create({ name: 'Rider', phone: '9000000021', city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
const mkDriver = (n, extra = {}) => Driver.create({
  name: `Driver ${n}`, phone: `91000000${20 + n}`, password: 'x-test-pass', approve: true, status: 'approved', isOnline: true, isOnRide: false,
  vehicleType: 'car', vehicleTypeId: sedan, vehicleTypeIds: [sedan], vehicleNumber: `MH12RT20${n}${n}`, vehicleColor: 'white',
  location: { type: 'Point', coordinates: [PICKUP[0], PICKUP[1] + 0.001 * n] }, ...extra,
});
const withPass = (driverId) => DriverSubscription.collection.insertOne({
  driverId, planId: new mongoose.Types.ObjectId(), planName: 'Day', amount: 50, vehicleClasses: ['car'],
  startsAt: new Date(Date.now() - 3600e3), expiresAt: new Date(Date.now() + 24 * 3600e3), status: 'active', paymentMethod: 'wallet', paidAt: new Date(), tripsCovered: 0, commissionWaived: 0,
});

// ---------------------------------------------------------------- 1. admin sets packages up (HTTP, as the admin form sends them)
const created = await call('POST', '/admin/types/rental-packages', tSuper, { name: '2 Hours / 20 KM', transport_type: 'taxi', short_description: '2 hr / 20 km', status: 'active' });
assert.equal(created.status, 200, JSON.stringify(created.body));
const typeId = created.body.data.id;
assert.equal((await call('POST', '/admin/types/rental-packages', tSuper, { name: '   ' })).status, 400, 'a package needs a name');
assert.equal((await call('GET', '/admin/types/rental-packages', tSub)).status, 403, 'a sub-admin without the pricing permission is refused');
assert.equal((await call('POST', '/admin/types/rental-packages', tSub, { name: 'x' })).status, 403);
assert.equal((await call('GET', '/admin/types/rental-packages')).status, 401);
const listed = await call('GET', '/admin/types/rental-packages', tSuper);
assert.equal(listed.body.data.rental_packages.results.length, 1);

const formRow = (vehicle, price) => ({
  vehicle_type: String(vehicle), base_price: String(price), free_distance: '20', distance_price: '25', free_time: '120', time_price: '2',
  admin_commision_type: '2', admin_commision: '0', admin_commission_type_from_driver: '2', admin_commission_from_driver: '0',
  admin_commission_type_for_owner: '2', admin_commission_for_owner: '0', service_tax: '0', cancellation_fee: '', active: 1,
});
const packagePayload = {
  pricing_scope: 'package', transport_type: 'rental', service_location_id: null, package_type_id: typeId, package_kind: 'hourly_rental',
  package_destination: 'Local', package_availability: 'available', status: 'active', active: 1,
  package_vehicle_prices: [formRow(sedan, 600), formRow(suv, 900)],
};
const price = await call('POST', '/admin/types/set-prices', tSuper, packagePayload);
assert.equal(price.status, 200, JSON.stringify(price.body));
const priceId = String((await SetPrice.findOne({ package_type_id: typeId }).lean())._id);
assert.equal(price.body.data.package_kind, 'hourly_rental');
const stored = await SetPrice.findById(priceId).lean();
assert.equal(stored.package_kind, 'hourly_rental');
assert.equal(String(stored.package_type_id), typeId);
assert.equal(stored.package_vehicle_prices.length, 2);
assert.equal(stored.package_vehicle_prices[0].base_price, 600);
assert.equal(stored.package_vehicle_prices[0].free_time, 120, 'minutes included');
assert.equal(stored.package_vehicle_prices[0].admin_commission_from_driver, 0);

// the package list the admin page reads: only hourly rentals, with the package name
const adminList = await call('GET', '/admin/types/set-prices?scope=package&package_kind=hourly_rental&limit=100', tSuper);
assert.equal(adminList.status, 200);
const adminRows = adminList.body.data?.results || adminList.body.data?.set_prices?.results || adminList.body.results || [];
assert.equal(adminRows.length, 1, JSON.stringify(adminList.body).slice(0, 300));
assert.equal(adminRows[0].package_type_name, '2 Hours / 20 KM');
assert.equal(adminRows[0].package_kind, 'hourly_rental');
// editing a price keeps the package; the admin can change the numbers
const edited = await call('PATCH', `/admin/types/set-prices/${priceId}`, tSuper, { ...packagePayload, package_vehicle_prices: [formRow(sedan, 650), formRow(suv, 900)] });
assert.equal(edited.status, 200, JSON.stringify(edited.body));
assert.equal((await SetPrice.findById(priceId).lean()).package_vehicle_prices[0].base_price, 650);
assert.equal(String((await SetPrice.findById(priceId).lean()).package_type_id), typeId, 'editing keeps the package name');

// a package with prices cannot be deleted from under them
assert.equal((await call('DELETE', `/admin/types/rental-packages/${typeId}`, tSuper)).status, 409);

// ---------------------------------------------------------------- 2. the rider's package list
const catalog = await call('GET', '/users/hourly-rental-packages');
assert.equal(catalog.status, 200);
assert.equal(catalog.body.results.length, 1);
const pkg = catalog.body.results[0];
assert.equal(pkg.name, '2 Hours / 20 KM');
assert.equal(pkg.includedKm, 20);
assert.equal(pkg.includedMinutes, 120);
assert.equal(pkg.startingPrice, 650);
assert.deepEqual(pkg.vehicles.map((v) => v.vehicleName), ['Sedan', 'SUV'], 'cheapest first');
assert.equal(pkg.vehicles[0].extraKmRate, 25);
assert.equal(pkg.vehicles[0].extraMinuteRate, 2);

// a vehicle switched off for rentals leaves every package
await admin.updateVehicleType(String(suv), { rental_enabled: false });
assert.deepEqual((await call('GET', '/users/hourly-rental-packages')).body.results[0].vehicles.map((v) => v.vehicleName), ['Sedan']);
await admin.updateVehicleType(String(suv), { rental_enabled: true });
// a package switched off disappears
await call('PATCH', `/admin/types/rental-packages/${typeId}`, tSuper, { status: 'inactive' });
assert.equal((await call('GET', '/users/hourly-rental-packages')).body.results.length, 0);
await failsWith(rental.resolveHourlyRentalQuote({ packagePriceId: priceId, vehicleTypeId: sedan }), 404, 'a stale app cannot book a switched-off package');
await call('PATCH', `/admin/types/rental-packages/${typeId}`, tSuper, { status: 'active' });

// a city's own price beats the nationwide one for that city
const city = await ServiceLocation.collection.insertOne({ name: 'Indore', service_location_name: 'Indore', status: 'active', active: true });
await SetPrice.create({
  pricing_scope: 'package', package_kind: 'hourly_rental', package_type_id: typeId, service_location_id: city.insertedId, transport_type: 'taxi',
  package_destination: 'Local', package_availability: 'available', status: 'active', active: 1,
  package_vehicle_prices: [{ vehicle_type: sedan, base_price: 500, free_distance: 20, free_time: 120, distance_price: 20, time_price: 2, active: 1 }],
});
const inCity = await rental.listHourlyRentalPackages({ serviceLocationId: String(city.insertedId) });
assert.equal(inCity.length, 1, 'one package, not two');
assert.equal(inCity[0].startingPrice, 500, "the city's price wins");
assert.equal((await rental.listHourlyRentalPackages({ serviceLocationId: null }))[0].startingPrice, 650, 'elsewhere the nationwide price');
await SetPrice.deleteOne({ service_location_id: city.insertedId });

// intercity packages never show a rental, and a rental never shows as intercity
await SetPrice.collection.insertOne({
  pricing_scope: 'package', package_destination: 'Bhopal', transport_type: 'taxi', package_availability: 'available', status: 'active', active: 1,
  package_vehicle_prices: [{ vehicle_type: sedan, base_price: 3000, active: 1 }],
});
const intercity = await call('GET', '/users/intercity-packages');
assert.equal(intercity.status, 200);
const intercityText = JSON.stringify(intercity.body);
assert.ok(intercityText.includes('Bhopal'), 'the old intercity package (no package_kind) is still listed');
assert.ok(!intercityText.includes('Local') && !intercityText.includes('2 Hours'), 'the rental package is not listed as intercity');

// ---------------------------------------------------------------- 3. booking: the price is the admin's, not the app's
const booked = await rides.createRideRecord({
  userId: rider._id, pickupCoords: PICKUP, dropCoords: PICKUP, pickupAddress: 'Palasia', dropAddress: 'Palasia',
  fare: 1, estimatedDistanceMeters: 999999, estimatedDurationMinutes: 1, vehicleTypeId: String(sedan),
  paymentMethod: 'cash', serviceType: 'hourly_rental', rental: { packagePriceId: priceId, packagePrice: 1, extraKmRate: 0 },
});
assert.equal(booked.serviceType, 'hourly_rental');
assert.equal(booked.fare, 650, "the app's fare of Rs 1 is ignored");
assert.equal(booked.baseFare, 650);
assert.equal(booked.estimatedDistanceMeters, 20000, 'estimate is the package allowance');
assert.equal(booked.estimatedDurationMinutes, 120);
assert.equal(booked.rental.packageName, '2 Hours / 20 KM');
assert.equal(booked.rental.extraKmRate, 25, "the app's rate of 0 is ignored");
assert.equal(booked.rental.extraMinuteRate, 2);
assert.equal(booked.pricingNegotiationMode, 'none', 'never bid on');
assert.equal(booked.surge?.multiplier ?? 1, 1, 'no surge');
assert.equal(booked.pricingSnapshot.admin_commission_from_driver, 0, 'commission comes from the package row');
await failsWith(rides.createRideRecord({
  userId: rider._id, pickupCoords: PICKUP, dropCoords: PICKUP, fare: 1, vehicleTypeId: String(sedan), paymentMethod: 'cash', serviceType: 'hourly_rental', rental: {},
}), 400, 'a rental without a package');
await failsWith(rides.createRideRecord({
  userId: rider._id, pickupCoords: PICKUP, dropCoords: PICKUP, fare: 1, vehicleTypeId: String(bike()), paymentMethod: 'cash', serviceType: 'hourly_rental', rental: { packagePriceId: priceId },
}), 400, 'a vehicle that is not in the package');
function bike() { return new mongoose.Types.ObjectId(); }
await Ride.deleteMany({});

// ---------------------------------------------------------------- 4. dispatch: only drivers who take rentals
// five nearest drivers have rentals off; a sixth, farther, has them on
const near = [];
for (let n = 1; n <= 5; n += 1) near.push(await mkDriver(n, { rental: { accepts: false, blockedByAdmin: false } }));
const farOn = await mkDriver(6, { rental: { accepts: true, blockedByAdmin: false } });
const blocked = await mkDriver(7, { rental: { accepts: true, blockedByAdmin: true } });
for (const d of [...near, farOn, blocked]) await withPass(d._id);
const asRide = await matchDrivers(PICKUP, { maxDistance: 3000, vehicleTypeId: String(sedan), serviceType: 'ride' });
assert.equal(asRide.drivers.length, 5, 'a normal ride still goes to the nearest five');
const asRental = await matchDrivers(PICKUP, { maxDistance: 3000, vehicleTypeId: String(sedan), serviceType: 'hourly_rental' });
assert.deepEqual(asRental.drivers.map((d) => d.name), ['Driver 6'], 'a rental skips the rental-off and blocked drivers, and still finds the sixth');
assert.equal(rental.driverTakesRentals(farOn), true);
assert.equal(rental.driverTakesRentals(blocked), false);
assert.equal(rental.driverTakesRentals({}), true, 'drivers from before the field accept rentals');

// ---------------------------------------------------------------- 5. the driver's toggle and the admin's block (HTTP)
const tOff = tokenFor(near[0]._id, 'driver');
const tOn = tokenFor(farOn._id, 'driver');
const pref = await call('GET', '/drivers/me/rental-preference', tOff);
assert.equal(pref.status, 200);
assert.deepEqual(pref.body.data, { accepts: false, blockedByAdmin: false, vehicleRentalEnabled: true, receivesRentals: false });
const turnedOn = await call('PUT', '/drivers/me/rental-preference', tOff, { accepts: true });
assert.equal(turnedOn.body.data.receivesRentals, true);
assert.equal((await Driver.findById(near[0]._id).lean()).rental.accepts, true);
await Driver.updateOne({ _id: near[0]._id }, { 'rental.accepts': false });
assert.equal((await call('GET', '/drivers/me/rental-preference')).status, 401);
const blockIt = await call('PATCH', `/admin/drivers/${farOn._id}/rental-access`, tSuper, { blockedByAdmin: true });
assert.equal(blockIt.status, 200);
assert.equal(blockIt.body.data.receivesRentals, false);
assert.equal((await call('GET', `/admin/drivers/${farOn._id}/rental-access`, tSuper)).body.data.blockedByAdmin, true);
assert.equal((await call('GET', '/drivers/me/rental-preference', tOn)).body.data.blockedByAdmin, true);
await call('PATCH', `/admin/drivers/${farOn._id}/rental-access`, tSuper, { blockedByAdmin: false });
assert.equal((await call('GET', '/admin/drivers/not-an-id/rental-access', tSuper)).status, 404);

// ---------------------------------------------------------------- 6. accept gate, then the trip and its bill
const rentalRide = await rides.createRideRecord({
  userId: rider._id, pickupCoords: PICKUP, dropCoords: PICKUP, pickupAddress: 'Palasia', dropAddress: 'Palasia', fare: 1, vehicleTypeId: String(sedan),
  paymentMethod: 'cash', serviceType: 'hourly_rental', rental: { packagePriceId: priceId },
});
const rideId = String(rentalRide._id);
const refused = await failsWith(rides.acceptRideAssignment({ rideId, driverId: near[0]._id }), 403, 'a driver with rentals off', 'RENTAL_NOT_ENABLED');
assert.match(refused.message, /Accept rental trips/);
await failsWith(rides.acceptRideAssignment({ rideId, driverId: blocked._id }), 403, 'a driver blocked by admin', 'RENTAL_NOT_ENABLED').then((e) => assert.match(e.message, /not allowed/));
await rides.acceptRideAssignment({ rideId, driverId: farOn._id });
assert.equal((await Ride.findById(rideId)).driverId.toString(), String(farOn._id));

await failsWith(rides.updateRideLifecycle({ rideId, driverId: farOn._id, nextStatus: 'completed' }), 409, 'cannot end a rental that never started');
await failsWith(rides.updateRideLifecycle({ rideId, driverId: farOn._id, nextStatus: 'arrived' }), 409, 'arrived is only after started');
await rides.updateRideLifecycle({ rideId, driverId: farOn._id, nextStatus: 'arriving' });
await rides.updateRideLifecycle({ rideId, driverId: farOn._id, nextStatus: 'started' });
let live = await Ride.findById(rideId);
assert.ok(live.startedAt, 'the clock starts at "started"');
assert.equal(live.rental.settledAt, null);

// the driver ran 150 minutes and 27.4 km: 50 GPS fixes along the road
const startedAt = new Date(Date.now() - 150 * 60000);
await Ride.updateOne({ _id: rideId }, { startedAt });
const points = [];
for (let i = 0; i <= 50; i += 1) {
  points.push({
    rideId: live._id, driverId: farOn._id,
    location: { type: 'Point', coordinates: [PICKUP[0], PICKUP[1] + (0.2464 * i) / 50] },
    createdAt: new Date(startedAt.getTime() + 60000 + (i * (148 * 60000)) / 50),
  });
}
await DriverLocationHistory.collection.insertMany(points);
// a GPS jump (hundreds of km in a second) must not be billed
await DriverLocationHistory.collection.insertOne({
  rideId: live._id, driverId: farOn._id, location: { type: 'Point', coordinates: [PICKUP[0] + 3, PICKUP[1]] }, createdAt: new Date(startedAt.getTime() + 60000 + 10),
});

await rides.updateRideLifecycle({ rideId, driverId: farOn._id, nextStatus: 'arrived' });
live = await Ride.findById(rideId);
assert.equal(live.rental.usedMinutes, 150);
assert.equal(live.rental.extraMinutes, 30);
assert.equal(live.rental.extraTimeCharge, 60, '30 min x Rs 2');
assert.ok(live.rental.travelledKm >= 27.3 && live.rental.travelledKm <= 27.5, `km driven ${live.rental.travelledKm}`);
assert.equal(live.rental.extraKm, 7, 'only whole km over 20 are billed');
assert.equal(live.rental.extraKmCharge, 175, '7 km x Rs 25');
assert.equal(live.fare, 650 + 175 + 60, 'package + extra km + extra time');
assert.ok(live.rental.settledAt, 'billed once, at the end of the trip');
// the bill is idempotent
const again = await Ride.findById(rideId);
await rental.applyHourlyRentalCharges(again);
assert.equal(again.fare, 885, 'a second call does not bill again');
// the rider and driver both get the rental terms and the bill in the realtime payload
const payload = rides.serializeRideRealtime(await Ride.findById(rideId));
assert.equal(payload.rental.packageName, '2 Hours / 20 KM');
assert.equal(payload.rental.extraKmCharge, 175);
assert.ok(payload.rental.settledAt);
const history = await rides.listRideHistoryForIdentity({ role: 'user', entityId: rider._id, category: 'rides' });
assert.ok(JSON.stringify(history).includes('2 Hours / 20 KM'), 'a rental is in the rider\'s ride history with its terms');

// ---------------------------------------------------------------- 7. a normal ride is untouched
const normal = await rides.createRideRecord({
  userId: rider._id, pickupCoords: PICKUP, dropCoords: DROP_FAR, pickupAddress: 'a', dropAddress: 'b', fare: 321, vehicleTypeId: String(sedan),
  paymentMethod: 'cash', serviceType: 'ride', estimatedDistanceMeters: 27000, estimatedDurationMinutes: 40,
});
assert.equal(normal.serviceType, 'ride');
assert.equal(normal.fare, 321, 'a normal ride keeps the fare the app quoted');
assert.equal(normal.rental, null);
assert.equal(rides.serializeRideRealtime(normal).rental, null);

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('hourly rental: all checks passed');
process.exit(0);
