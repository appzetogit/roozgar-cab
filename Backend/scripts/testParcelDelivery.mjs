// Parcel / delivery end to end, against a THROWAWAY, STANDALONE Mongo (like production).
//   PARCEL_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testParcelDelivery.mjs
// Drops its own database (parcel_test) when done. Never point it at production.
//
// Covers: scripts/setupParcelDelivery.mjs on an empty-of-delivery DB (dry run, apply, idempotent, keeps admin edits), the
// rider's vehicle catalog and quote, city parcels (cash, online, solo driver on commission, fleet driver), proofs gating
// start and completion, waiting charge, a cancelled parcel, a driver counter-offer, cross-city / unpriced refusals, and
// what the admin Delivery Requests list (with its stat cards) and request details show.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const uri = process.env.PARCEL_TEST_MONGODB_URI;
if (!uri) throw new Error('Set PARCEL_TEST_MONGODB_URI to a throwaway Mongo');
const DB = 'parcel_test';
Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB_NAME: DB, JWT_SECRET: 'test-secret', NODE_ENV: 'test' });

const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) =>
  String(url).startsWith('http://127.0.0.1') ? realFetch(url, ...rest) : Promise.reject(new Error('offline in test'));

const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/modules/taxi/services/tokenService.js');
const rides = await import('../src/modules/taxi/services/rideService.js');
const { installStandaloneTransactionShim } = await import('../src/config/database.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { Zone } = await import('../src/modules/taxi/driver/models/Zone.js');
const { DriverSubscription } = await import('../src/modules/taxi/driver/models/DriverSubscription.js');
const { WalletTransaction } = await import('../src/modules/taxi/driver/models/WalletTransaction.js');
const { User } = await import('../src/modules/taxi/user/models/User.js');
const { Admin } = await import('../src/modules/taxi/admin/models/Admin.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { SetPrice } = await import('../src/modules/taxi/admin/models/SetPrice.js');
const { ServiceLocation } = await import('../src/modules/taxi/admin/models/ServiceLocation.js');
const { GoodsType } = await import('../src/modules/taxi/admin/models/GoodsType.js');
const { Owner } = await import('../src/modules/taxi/admin/models/Owner.js');
const { OwnerWalletTransaction } = await import('../src/modules/taxi/admin/models/OwnerWalletTransaction.js');
const { Ride } = await import('../src/modules/taxi/user/models/Ride.js');
const { Delivery } = await import('../src/modules/taxi/user/models/Delivery.js');
const { RideBid } = await import('../src/modules/taxi/user/models/RideBid.js');

await mongoose.connect(uri, { dbName: DB });
await mongoose.connection.dropDatabase();
await installStandaloneTransactionShim();
await Promise.all([Driver.init(), Ride.init(), Zone.init(), RideBid.init()]);

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (method, p, token, body) => {
  const response = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const tokenFor = (id, role) => signAccessToken({ sub: String(id), role });
const oid = () => new mongoose.Types.ObjectId();
const round = (n) => Math.round(n * 100) / 100;
const km = ([lng1, lat1], [lng2, lat2]) => {
  const r = (x) => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.sin(r(lng2 - lng1) / 2) ** 2 * Math.cos(r(lat1)) * Math.cos(r(lat2));
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
// base covers `free` km, then `perKm`; the straight-line distance is what the server falls back to offline
const priced = (from, to, { base, free, perKm }) => round(base + Math.max(km(from, to) - free, 0) * perKm);

// ---------------------------------------------------------------- the city as an admin would have set it up (taxi side only)
const square = (lng, lat, d = 0.2) => ({ type: 'Polygon', coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] });
const INDORE = [75.8577, 22.7196];
const INDORE_DROP = [75.9, 22.76];
const HYD = [78.4867, 17.385];
const HYD_DROP = [78.52, 17.41];
const BIDAR = [77.5199, 17.9104];
const indoreLoc = (await ServiceLocation.collection.insertOne({ name: 'Indore', service_location_name: 'Indore', status: 'active', active: true })).insertedId;
const hydLoc = (await ServiceLocation.collection.insertOne({ name: 'Hyderabad', service_location_name: 'Hyderabad', status: 'active', active: true })).insertedId;
const bidarLoc = (await ServiceLocation.collection.insertOne({ name: 'Bidar 585401', service_location_name: 'Bidar 585401', status: 'active', active: true })).insertedId;
const indoreZone = (await Zone.create({ name: 'Indore', service_location_id: indoreLoc, geometry: square(...INDORE) }))._id;
const hydZone = (await Zone.create({ name: 'Hyderabad', service_location_id: hydLoc, geometry: square(...HYD) }))._id;
await Zone.create({ name: 'Bidar', service_location_id: bidarLoc, geometry: square(...BIDAR) });

const taxiVehicle = async (name, icon_types, category) => (await Vehicle.collection.insertOne({
  name, icon_types, category, capacity: 2, transport_type: 'taxi', is_taxi: 'taxi', active: true, status: 1, dispatch_type: 'normal',
  admin_commission_type_from_driver: 1, admin_commission_from_driver: 0, admin_commission_type_for_owner: 1, admin_commission_for_owner: 10,
})).insertedId;
const tBike = await taxiVehicle('Bike', 'bike', 'bike');
const tAuto = await taxiVehicle('Auto', 'auto', 'auto');
const tMini = await taxiVehicle('Mini', 'car', 'car');
const taxiRow = (vehicle, zone, loc, { base, free, perKm, driverPct = 0, ownerPct = 10, wait = 2, freeWait = 3 }) => SetPrice.create({
  pricing_scope: 'ride', transport_type: 'taxi', vehicle_type: vehicle, zone_id: zone, service_location_id: loc,
  base_price: base, base_distance: free, price_per_distance: perKm, waiting_charge: wait, free_waiting_before: freeWait,
  payment_type: ['cash', 'online'], admin_commission_type_from_driver: 1, admin_commission_from_driver: driverPct,
  admin_commission_type_for_owner: 1, admin_commission_for_owner: ownerPct, active: 1, status: 'active',
});
await taxiRow(tBike, indoreZone, indoreLoc, { base: 30, free: 2, perKm: 8 });
await taxiRow(tAuto, indoreZone, indoreLoc, { base: 40, free: 2, perKm: 11, driverPct: 10 });
await taxiRow(tMini, indoreZone, indoreLoc, { base: 100, free: 3, perKm: 14 });
await taxiRow(tBike, hydZone, hydLoc, { base: 25, free: 1, perKm: 7 });
await GoodsType.create([{ goods_type_name: 'Documents', goods_types_for: 'both' }, { goods_type_name: 'Furniture', goods_types_for: 'truck' }]);

// ================================================================ 1. THE SETUP SCRIPT
const here = path.dirname(fileURLToPath(import.meta.url));
const runSetup = (...args) => {
  const r = spawnSync('node', ['--no-warnings', path.join(here, 'setupParcelDelivery.mjs'), ...args], { env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
};
const dry = runSetup();
assert.match(dry, /DRY RUN/);
assert.match(dry, /Dry run only, nothing written: 4 delivery price rows to add/, 'Indore: bike, auto, mini; Hyderabad: bike; the unpriced cities add nothing');
assert.equal(await Vehicle.countDocuments({ transport_type: 'delivery' }), 0, 'a dry run writes nothing');
assert.equal(await SetPrice.countDocuments({ transport_type: 'delivery' }), 0);
console.log(dry.split('\n').filter((l) => l && !l.startsWith('[dotenv')).join('\n'));

const applied = runSetup('--apply');
assert.match(applied, /Done: 4 delivery price rows to add/);
const dBike = await Vehicle.findOne({ name: 'Delivery Bike' }).lean();
const dAuto = await Vehicle.findOne({ name: 'Delivery Auto' }).lean();
const dTruck = await Vehicle.findOne({ name: 'Delivery Mini Truck' }).lean();
for (const v of [dBike, dAuto, dTruck]) {
  assert.equal(v.transport_type, 'delivery');
  assert.equal(v.active, true);
  assert.equal(v.status, 1);
  assert.equal(v.rental_enabled, false);
}
assert.deepEqual([dBike.delivery_category, dBike.icon_types, dBike.category], ['2wheeler', 'bike', 'bike']);
assert.deepEqual([dAuto.delivery_category, dAuto.icon_types], ['', 'auto'], 'no "auto" delivery category exists: the Auto tile finds it by name');
assert.deepEqual([dTruck.delivery_category, dTruck.icon_types], ['trucks', 'truck']);
assert.equal(dAuto.admin_commission_from_driver, 0, 'vehicle commission fallback copied from the taxi vehicle');
const rowOf = (vehicle, zone) => SetPrice.findOne({ pricing_scope: 'ride', transport_type: 'delivery', vehicle_type: vehicle._id, zone_id: zone }).lean();
const rBike = await rowOf(dBike, indoreZone);
const rAuto = await rowOf(dAuto, indoreZone);
const rTruck = await rowOf(dTruck, indoreZone);
const rHyd = await rowOf(dBike, hydZone);
assert.deepEqual([rBike.base_price, rBike.base_distance, rBike.price_per_distance, String(rBike.service_location_id)], [30, 2, 8, String(indoreLoc)]);
assert.deepEqual([rAuto.base_price, rAuto.base_distance, rAuto.price_per_distance, rAuto.admin_commission_from_driver], [40, 2, 11, 10]);
assert.deepEqual([rTruck.base_price, rTruck.base_distance, rTruck.price_per_distance], [160, 3, 22.5], 'mini x1.6: 100 -> 160, 14 -> 22.4 -> 22.5');
assert.deepEqual([rHyd.base_price, rHyd.price_per_distance], [25, 7]);
assert.deepEqual([rBike.waiting_charge, rBike.free_waiting_before, rBike.admin_commission_for_owner], [2, 3, 10]);
assert.deepEqual(rBike.payment_type, ['cash', 'online']);
assert.equal(await SetPrice.countDocuments({ transport_type: 'delivery' }), 4);
assert.equal(await SetPrice.countDocuments({ transport_type: 'delivery', service_location_id: bidarLoc }), 0, 'a city with no taxi tariff gets no guessed parcel price');

// idempotent, and an admin's edit is never overwritten
await SetPrice.updateOne({ _id: rBike._id }, { $set: { base_price: 35 } });
const again = runSetup('--apply');
assert.match(again, /Done: 0 delivery price rows to add/);
assert.equal(await Vehicle.countDocuments({ transport_type: 'delivery' }), 3);
assert.equal(await SetPrice.countDocuments({ transport_type: 'delivery' }), 4);
assert.equal((await SetPrice.findById(rBike._id).lean()).base_price, 35, 'the admin edit survived');
await SetPrice.updateOne({ _id: rBike._id }, { $set: { base_price: 30 } });

// ---------------------------------------------------------------- people
const sanchit = await User.create({ name: 'Sender', phone: '9000000061', city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
const rider2 = await User.create({ name: 'Rider Two', phone: '9000000062', city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
await Admin.collection.insertOne({ name: 'Super', email: 'super@example.com', password: 'x', createdAt: new Date() });
const tRider = tokenFor(sanchit._id, 'user');
const tAdmin = tokenFor((await Admin.collection.findOne({ email: 'super@example.com' }))._id, 'admin');
let phoneN = 10;
const mkDriver = (vehicle, extra = {}) => Driver.create({
  name: `Driver ${phoneN}`, phone: `91000001${phoneN++}`, password: 'x-test-pass', approve: true, status: 'approved', isOnline: true, isOnRide: false,
  vehicleType: 'bike', vehicleTypeId: vehicle._id, vehicleTypeIds: [vehicle._id], vehicleNumber: `MP09ZZ${phoneN}`, vehicleColor: 'black',
  location: { type: 'Point', coordinates: INDORE }, ...extra,
});
const withPass = (driverId) => DriverSubscription.collection.insertOne({
  driverId, planId: oid(), planName: 'Day', amount: 50, vehicleClasses: ['bike', 'auto', 'truck'], startsAt: new Date(Date.now() - 3600e3),
  expiresAt: new Date(Date.now() + 24 * 3600e3), status: 'active', paymentMethod: 'wallet', paidAt: new Date(), tripsCovered: 0, commissionWaived: 0,
});
// A solo driver must hold a day pass to take any ride, and a pass waives the commission. `lapse` lets it run out right after
// the pickup, so a trip completed afterwards is settled on commission like one of a driver whose pass ended mid-trip.
const take = async (rideId, driver, { lapse = false } = {}) => {
  if (!driver.owner_id) await withPass(driver._id);
  await rides.acceptRideAssignment({ rideId: String(rideId), driverId: driver._id });
  if (lapse) await DriverSubscription.updateMany({ driverId: driver._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
};
const walletOf = async (id) => round((await Driver.findById(id).lean()).wallet?.balance || 0);
const parcel = { category: 'General Parcel', weight: 'Under 5kg', description: 'Books', senderName: 'Asha', senderMobile: '9876543210', receiverName: 'Ravi', receiverMobile: '9876500000', photos: ['/uploads/a.jpg'], instructions: 'Ring the bell' };
const book = (extra = {}, token = tRider) => call('POST', '/deliveries', token, {
  pickup: INDORE, drop: INDORE_DROP, pickupAddress: 'Vijay Nagar, Indore', dropAddress: 'Rajwada, Indore', fare: 1, // the app's own number must be ignored
  vehicleTypeId: String(dBike._id), vehicleTypeIds: [String(dBike._id)], paymentMethod: 'Cash', parcel, ...extra,
});
const lifecycle = (rideId, driverId, nextStatus, extra = {}) => rides.updateRideLifecycle({ rideId, driverId, nextStatus, ...extra });
const proof = (rideId, driver, stage) => call('POST', `/rides/${rideId}/parcel-proof`, tokenFor(driver._id, 'driver'), { stage, imageUrl: `/uploads/proof-${stage}.jpg` });

// ================================================================ 2. WHAT THE RIDER APP SEES
const catalog = await call('GET', '/users/vehicle-types');
assert.equal(catalog.status, 200);
const items = catalog.body.results || catalog.body.data?.results;
const deliveryVehicles = items.filter((v) => v.active && ['delivery', 'both'].includes(v.transport_type));
assert.deepEqual(deliveryVehicles.map((v) => v.name).sort(), ['Delivery Auto', 'Delivery Bike', 'Delivery Mini Truck'], 'the parcel screen now has vehicles to offer');
assert.equal(items.filter((v) => ['taxi', 'both'].includes(v.transport_type)).some((v) => /^Delivery/.test(v.name)), false, 'the cab list does not');
assert.equal(deliveryVehicles.find((v) => v.name === 'Delivery Mini Truck').delivery_category, 'trucks');

const quoteBody = (vehicle, pickup = INDORE, drop = INDORE_DROP) => ({ vehicleTypeId: String(vehicle._id), pickup, drop });
const q = await call('POST', '/deliveries/quote', tRider, quoteBody(dBike));
assert.equal(q.status, 200, JSON.stringify(q.body));
const bikeFare = priced(INDORE, INDORE_DROP, { base: 30, free: 2, perKm: 8 });
assert.equal(q.body.data.total, bikeFare, 'quote = city row: base 30 for 2 km then 8/km');
assert.equal(q.body.data.tariffSource, 'zone');
assert.equal(q.body.data.zoneName, 'Indore');
assert.ok(bikeFare > 30 && bikeFare < 80, `sane bike fare ${bikeFare}`);
assert.equal((await call('POST', '/deliveries/quote', undefined, quoteBody(dBike))).status, 401);
const hq = await call('POST', '/deliveries/quote', tRider, quoteBody(dBike, HYD, HYD_DROP));
assert.equal(hq.body.data.total, priced(HYD, HYD_DROP, { base: 25, free: 1, perKm: 7 }), "Hyderabad is priced from Hyderabad's row, not Indore's");
const aq = await call('POST', '/deliveries/quote', tRider, quoteBody(dAuto));
assert.equal(aq.body.data.total, priced(INDORE, INDORE_DROP, { base: 40, free: 2, perKm: 11 }));
const tq = await call('POST', '/deliveries/quote', tRider, quoteBody(dTruck));
assert.equal(tq.body.data.total, priced(INDORE, INDORE_DROP, { base: 160, free: 3, perKm: 22.5 }));
// refusals
const noPrice = await call('POST', '/deliveries/quote', tRider, quoteBody(dAuto, HYD, HYD_DROP));
assert.equal(noPrice.status, 200);
assert.equal(noPrice.body.data.total, 0, 'no Auto price in Hyderabad: the quote says 0 ...');
const unpricedBook = await book({ pickup: HYD, drop: HYD_DROP, vehicleTypeId: String(dAuto._id), vehicleTypeIds: [String(dAuto._id)] });
assert.equal(unpricedBook.status, 400);
assert.match(unpricedBook.body.message, /not priced/, '... and booking is refused, never at the app\'s number');
const bidarBook = await book({ pickup: BIDAR, drop: [BIDAR[0] + 0.02, BIDAR[1]] });
assert.equal(bidarBook.status, 400, 'a city nobody priced is not bookable');
const outstation = await book({ drop: HYD_DROP });
assert.equal(outstation.status, 400);
assert.match(outstation.body.message, /within one city only/, 'outstation parcels are refused: parcels are intracity');
assert.equal(await Ride.countDocuments({ serviceType: 'parcel' }), 0, 'nothing was booked by the refusals');
// a goods type that names other vehicles
const wrongGoods = await book({ parcel: { ...parcel, category: 'Furniture' } });
assert.equal(wrongGoods.status, 400);
assert.match(wrongGoods.body.message, /not allowed for the selected vehicle/);

// ================================================================ 3. A CITY PARCEL, CASH, BIKE (driver commission 0)
const b1 = await book();
assert.equal(b1.status, 201, JSON.stringify(b1.body));
const p1 = await Ride.findById(b1.body.data.rideId).lean();
assert.equal(p1.serviceType, 'parcel');
assert.equal(p1.transport_type, 'delivery');
assert.equal(p1.fare, Math.round(bikeFare), 'charged the server price, not the app\'s Rs 1');
assert.equal(p1.paymentMethod, 'cash');
assert.equal(String(p1.service_location_id), String(indoreLoc));
assert.deepEqual([p1.pricingSnapshot.admin_commission_from_driver, p1.pricingSnapshot.admin_commission_for_owner], [0, 10], 'commission from the delivery row');
assert.equal(String(p1.pricingSnapshot.setPriceId), String(rBike._id));
assert.equal(p1.pricingSnapshot.waiting_charge, 2, 'waiting terms locked from the delivery tariff');
assert.equal(p1.pricingSnapshot.free_waiting_before, 3);
assert.equal(p1.pricingSnapshot.delivery_tariff_source, 'zone');
assert.deepEqual([p1.parcel.senderName, p1.parcel.receiverMobile, p1.parcel.photos.length], ['Asha', '9876500000', 1]);
const del1 = await Delivery.findById(p1.deliveryId).lean();
assert.equal(del1.rideId.toString(), String(p1._id));
assert.equal((await call('GET', `/deliveries/${p1.deliveryId}`, tRider)).body.data.fare, Math.round(bikeFare));
assert.equal((await call('GET', '/deliveries/active/me', tRider)).body.data.rideId, String(p1._id), 'the rider sees it as the active delivery');

const d1 = await mkDriver(dBike);
await take(p1._id, d1);
await lifecycle(String(p1._id), d1._id, 'arriving');
await Ride.updateOne({ _id: p1._id }, { $set: { arrivedAt: new Date(Date.now() - 10 * 60e3) } }); // the sender kept the driver waiting 10 minutes
await assert.rejects(lifecycle(String(p1._id), d1._id, 'started'), /photo of the parcel before starting/, 'no pickup photo, no start');
assert.equal((await call('POST', `/rides/${p1._id}/parcel-proof`, tokenFor(d1._id, 'driver'), { stage: 'pickup' })).status, 400, 'a photo is required');
assert.equal((await call('POST', `/rides/${p1._id}/parcel-proof`, tokenFor(d1._id, 'driver'), { stage: 'later', imageUrl: 'x' })).status, 400);
assert.equal((await proof(String(p1._id), await mkDriver(dBike), 'pickup')).status, 404, "another driver cannot add a photo");
assert.equal((await proof(String(p1._id), d1, 'pickup')).status, 200);
await lifecycle(String(p1._id), d1._id, 'started');
await assert.rejects(lifecycle(String(p1._id), d1._id, 'completed'), /photo of the delivered parcel/, 'no delivery photo, no completion');
assert.equal((await proof(String(p1._id), d1, 'delivery')).status, 200);
await lifecycle(String(p1._id), d1._id, 'completed', { collectedVia: 'cash' });
const done1 = await Ride.findById(p1._id).lean();
assert.equal(done1.status, 'completed');
assert.equal(done1.waitingMinutes, 7, '10 minutes waited, 3 free');
assert.equal(done1.waitingCharge, 14, '7 min x Rs 2');
assert.equal(done1.fare, Math.round(bikeFare) + 14, 'fare = trip + waiting');
assert.equal(done1.baseFare, bikeFare, 'the quoted fare is kept beside it');
assert.deepEqual([done1.commissionAmount, done1.driverEarnings], [0, Math.round(bikeFare) + 14], 'driver commission 0%: the driver keeps it all');
assert.equal(await walletOf(d1._id), 0, 'cash trip, 0% commission: nothing to move in the wallet');
assert.equal((await Driver.findById(d1._id).lean()).isOnRide, false);
const mirrored = await Delivery.findById(p1.deliveryId).lean();
assert.deepEqual([mirrored.parcel.pickupProof.url, mirrored.parcel.deliveryProof.url], ['/uploads/proof-pickup.jpg', '/uploads/proof-delivery.jpg']);

// ================================================================ 4. SOLO DRIVER ON COMMISSION (Auto, 10%) AND ONLINE PAYMENT
const autoFare = priced(INDORE, INDORE_DROP, { base: 40, free: 2, perKm: 11 });
const b2 = await book({ vehicleTypeId: String(dAuto._id), vehicleTypeIds: [String(dAuto._id)] });
assert.equal(b2.status, 201, JSON.stringify(b2.body));
const p2 = await Ride.findById(b2.body.data.rideId).lean();
assert.equal(p2.fare, Math.round(autoFare));
const d2 = await mkDriver(dAuto, { vehicleType: 'auto' });
await take(p2._id, d2, { lapse: true });
await lifecycle(String(p2._id), d2._id, 'arriving');
await proof(String(p2._id), d2, 'pickup');
await lifecycle(String(p2._id), d2._id, 'started');
await proof(String(p2._id), d2, 'delivery');
await lifecycle(String(p2._id), d2._id, 'completed', { collectedVia: 'cash' });
const done2 = await Ride.findById(p2._id).lean();
assert.equal(done2.waitingCharge || 0, 0, 'no waiting, no charge');
assert.equal(done2.commissionAmount, round(Math.round(autoFare) * 0.1), '10% of the fare');
assert.equal(done2.driverEarnings, round(Math.round(autoFare) - done2.commissionAmount));
assert.equal(await walletOf(d2._id), -done2.commissionAmount, 'cash: the driver owes the commission');
const row2 = await WalletTransaction.findOne({ driverId: d2._id, rideId: p2._id }).lean();
assert.equal(row2.type, 'commission_deduction');

// online: the platform holds the money, so the driver is credited fare - commission
const b3 = await book({ vehicleTypeId: String(dAuto._id), vehicleTypeIds: [String(dAuto._id)], paymentMethod: 'online' });
assert.equal(b3.status, 201);
const p3 = await Ride.findById(b3.body.data.rideId).lean();
const d2b = await mkDriver(dAuto, { vehicleType: 'auto' });
assert.equal(p3.paymentMethod, 'online', 'the delivery row allows online');
await take(p3._id, d2b, { lapse: true });
await lifecycle(String(p3._id), d2b._id, 'arriving');
await proof(String(p3._id), d2b, 'pickup');
await lifecycle(String(p3._id), d2b._id, 'started');
await proof(String(p3._id), d2b, 'delivery');
await lifecycle(String(p3._id), d2b._id, 'completed');
const done3 = await Ride.findById(p3._id).lean();
assert.equal(done3.paymentMethod, 'online');
assert.equal(done3.commissionAmount, round(Math.round(autoFare) * 0.1));
assert.equal(done3.driverEarnings, round(Math.round(autoFare) - done3.commissionAmount));
assert.equal(await walletOf(d2b._id), done3.driverEarnings, 'online: fare less commission is credited');
assert.equal((await WalletTransaction.findOne({ driverId: d2b._id, rideId: p3._id }).lean()).type, 'ride_earning');

// ================================================================ 5. FLEET DRIVER (owner commission 10%)
const owner = await Owner.create({ name: 'Owner', company_name: 'Fleet', mobile: '9200000078', email: 'o2@example.com', password: 'x-test-pass', approve: true, status: 'approved', billing: { mode: 'commission' }, wallet: { balance: 0 } });
const fleet = await mkDriver(dBike, { owner_id: owner._id });
const b4 = await book({ paymentMethod: 'online' });
const p4 = await Ride.findById(b4.body.data.rideId).lean();
await take(p4._id, fleet);
await lifecycle(String(p4._id), fleet._id, 'arriving');
await proof(String(p4._id), fleet, 'pickup');
await lifecycle(String(p4._id), fleet._id, 'started');
await proof(String(p4._id), fleet, 'delivery');
await lifecycle(String(p4._id), fleet._id, 'completed');
const done4 = await Ride.findById(p4._id).lean();
assert.equal(done4.commissionAmount, round(Math.round(bikeFare) * 0.1), 'owner commission 10% of the parcel fare');
assert.equal(done4.driverEarnings, round(Math.round(bikeFare) - done4.commissionAmount));
assert.equal(round((await Owner.findById(owner._id).lean()).wallet.balance), done4.driverEarnings, 'online parcel: the owner is credited fare - commission');
assert.equal((await OwnerWalletTransaction.findOne({ ownerId: owner._id }).lean()).kind, 'credit');
assert.equal(await walletOf(fleet._id), 0, 'the fleet driver wallet is untouched');

// ================================================================ 6. A CANCELLED PARCEL
const b5 = await book();
const p5 = String(b5.body.data.rideId);
const cancelled = await call('PATCH', `/rides/${p5}/cancel`, tRider, {});
assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
const c5 = await Ride.findById(p5).lean();
assert.deepEqual([c5.status, c5.liveStatus], ['cancelled', 'cancelled']);
assert.equal((await Delivery.findById(c5.deliveryId).lean()).status, 'cancelled', 'the delivery record follows');
assert.equal((await User.findById(sanchit._id).lean()).currentRideId, null, 'the rider is free to book again');
// cancelled after a driver took it: the driver is freed
const b6 = await book();
const p6 = String(b6.body.data.rideId);
const d3 = await mkDriver(dBike);
await take(p6, d3);
assert.equal((await Driver.findById(d3._id).lean()).isOnRide, true);
assert.equal((await call('PATCH', `/rides/${p6}/cancel`, tRider, {})).status, 200);
assert.equal((await Driver.findById(d3._id).lean()).isOnRide, false);
assert.equal(await walletOf(d3._id), 0, 'no fee: the tariff row has no cancellation fee');

// ================================================================ 7. A DRIVER COUNTER-OFFER ON A PARCEL (Mini Truck, fare ~Rs 230)
const truckFare = priced(INDORE, INDORE_DROP, { base: 160, free: 3, perKm: 22.5 });
const b7 = await book({ vehicleTypeId: String(dTruck._id), vehicleTypeIds: [String(dTruck._id)] });
assert.equal(b7.status, 201, JSON.stringify(b7.body));
const p7 = String(b7.body.data.rideId);
assert.equal((await Ride.findById(p7).lean()).fare, Math.round(truckFare));
const truckDriver = await mkDriver(dTruck, { vehicleType: 'car' });
await withPass(truckDriver._id);
const offer = rides.serializeDriverCounterOffer(await Ride.findById(p7));
assert.equal(offer.enabled, true, 'a parcel can be countered like a ride');
const counter = Math.round(truckFare) + 10;
await rides.submitRideBid({ rideId: p7, driverId: truckDriver._id, bidFare: counter });
const bidId = String((await RideBid.findOne({ rideId: p7 }).lean())._id);
const accepted = await rides.acceptRideBidAssignment({ rideId: p7, bidId, userId: sanchit._id });
assert.equal(accepted.fare, counter, 'the fare is now the driver\'s offer');
assert.equal(accepted.baseFare, truckFare);
await lifecycle(p7, truckDriver._id, 'arriving');
await proof(p7, truckDriver, 'pickup');
await lifecycle(p7, truckDriver._id, 'started');
await proof(p7, truckDriver, 'delivery');
await lifecycle(p7, truckDriver._id, 'completed', { collectedVia: 'cash' });
const done7 = await Ride.findById(p7).lean();
assert.equal(done7.fare, counter);
assert.equal(done7.driverEarnings, counter, 'on a pass the driver keeps the whole counter-offer');

// ================================================================ 8. THE ADMIN
const list = await call('GET', '/admin/deliveries?limit=50', tAdmin);
assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 300));
const data = list.body.data;
const rowsAll = data.results || data.data || [];
assert.equal(rowsAll.length, 7, 'every parcel is a Delivery Request: 2 cash, 1 online solo, 1 fleet, 2 cancelled, 1 counter');
assert.ok(rowsAll.every((r) => r.requestId.startsWith('DEL_')));
const row1 = rowsAll.find((r) => r.id === String(p1._id));
assert.deepEqual([row1.tripStatus, row1.fare, row1.userName, row1.driverName], ['COMPLETED', Math.round(bikeFare) + 14, 'Sender', d1.name], 'completed, with the waiting charge in the fare');
assert.deepEqual([row1.parcel.senderName, row1.parcel.receiverName, row1.parcel.category], ['Asha', 'Ravi', 'General Parcel']);
assert.deepEqual([row1.parcel.pickupProof, row1.parcel.deliveryProof], ['/uploads/proof-pickup.jpg', '/uploads/proof-delivery.jpg']);
assert.equal(rowsAll.find((r) => r.id === p5).tripStatus, 'CANCELLED');
assert.equal(rowsAll.find((r) => r.id === p5).driverName, 'Unassigned');
assert.equal(rowsAll.find((r) => r.id === String(p3._id)).paymentOption, 'ONLINE');
assert.equal(row1.paymentOption, 'CASH');
// the stat cards count every parcel, not only the page on screen
const open = await book({}, tokenFor(rider2._id, 'user')); // one still searching (another rider: a new booking cancels the rider's previous active one)
const live = await book({ vehicleTypeId: String(dAuto._id), vehicleTypeIds: [String(dAuto._id)] });
await take(live.body.data.rideId, await mkDriver(dAuto, { vehicleType: 'auto' }));
const stats = (await call('GET', '/admin/deliveries?limit=2&page=2', tAdmin)).body.data.stats;
assert.deepEqual(stats, { total: 9, completed: 5, cancelled: 2, pending: 1, onTrip: 1, today: 9 }, '9 = 5 completed + 2 cancelled + 1 searching + 1 on trip');
assert.equal(open.status, 201);
assert.equal(stats.completed + stats.cancelled + stats.pending + stats.onTrip, stats.total, 'the cards add up');
assert.equal((await call('GET', '/admin/deliveries')).status, 401);

const det = await call('GET', `/admin/rides/${p1._id}/details`, tAdmin);
assert.equal(det.status, 200, JSON.stringify(det.body).slice(0, 300));
const d = det.body.data;
assert.deepEqual([d.kind.key, d.kind.label], ['parcel', 'Parcel Delivery']);
assert.match(d.requestId, /^DEL_[0-9A-F]{12}$/);
assert.deepEqual([d.typeDetails.category, d.typeDetails.weight, d.typeDetails.senderName, d.typeDetails.receiverMobile, d.typeDetails.instructions], ['General Parcel', 'Under 5kg', 'Asha', '9876500000', 'Ring the bell']);
assert.equal(d.typeDetails.pickupProof.url, '/uploads/proof-pickup.jpg');
assert.equal(d.typeDetails.deliveryProof.url, '/uploads/proof-delivery.jpg');
assert.equal(d.requestedVehicle.name, 'Delivery Bike');
assert.deepEqual([d.fare.final, d.fare.quoted, d.fare.waitingMinutes, d.fare.waitingCharge], [Math.round(bikeFare) + 14, bikeFare, 7, 14], 'fare, quoted fare and the waiting that made the difference');
assert.equal(d.fare.advancePaid, 0);
assert.deepEqual([d.settlement.settled, d.settlement.commission, d.settlement.driverEarnings], [true, 0, Math.round(bikeFare) + 14]);
assert.equal(d.snapshots.tariff.base_price, 30, 'the delivery tariff row it was priced from');
assert.equal(d.snapshots.pricing.driverCommission.value, 0);
assert.equal(d.snapshots.tripCategory?.category ?? 'city', 'city');
assert.equal(JSON.stringify(d).includes('"otp"'), false);
const fleetDet = (await call('GET', `/admin/rides/${p4._id}/details`, tAdmin)).body.data;
assert.equal(fleetDet.driver.fleetOwner.name, 'Fleet');
assert.equal(fleetDet.settlement.ownerWallet[0].kind, 'credit');
const goneDet = (await call('GET', `/admin/rides/${p5}/details`, tAdmin)).body.data;
assert.equal(goneDet.status.label, 'Cancelled');
const negoDet = (await call('GET', `/admin/rides/${p7}/details`, tAdmin)).body.data;
assert.equal(negoDet.negotiation.offers.length, 1);
assert.equal(negoDet.fare.quoted, truckFare);
assert.equal(negoDet.fare.final, counter);
// parcels stay out of Trip Requests
const tripRequests = (await call('GET', '/admin/ride-requests?limit=50', tAdmin)).body.data;
assert.equal((tripRequests.results || []).some((r) => r.kind === 'parcel'), false);

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('parcel delivery: all checks passed');
process.exit(0);
