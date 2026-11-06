// City / airport / bike / auto rides from request to settlement, against a THROWAWAY, STANDALONE Mongo (like production).
//   CITY_RIDES_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testCityRides.mjs
// Drops its own database (city_rides_test) when done. Never point it at production.
//
// Covers: the server fare formula and POST /rides/quote, the stored serverQuote + mismatch flag (never rejects), cash / UPI /
// booked-online / rider-paid-online / rider-wallet / user-subscription payment, promo, waiting charge, airport ride, bike
// (platform fee), auto (fixed commission), driver on a pass / on commission / fleet owner, rider and driver cancellation fees
// (who gets them), tips, a package row never pricing a city ride, settlement not wiping the pricing snapshot, and the admin detail.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.CITY_RIDES_TEST_MONGODB_URI;
if (!uri) throw new Error('Set CITY_RIDES_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB_NAME: 'city_rides_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test' });

const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) =>
  String(url).startsWith('http://127.0.0.1') ? realFetch(url, ...rest) : Promise.reject(new Error('offline in test'));

const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/modules/taxi/services/tokenService.js');
const rides = await import('../src/modules/taxi/services/rideService.js');
const dispatch = await import('../src/modules/taxi/services/dispatchService.js');
const quoteService = await import('../src/modules/taxi/services/fareQuoteService.js');
const { installStandaloneTransactionShim } = await import('../src/config/database.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { Zone } = await import('../src/modules/taxi/driver/models/Zone.js');
const { DriverSubscription } = await import('../src/modules/taxi/driver/models/DriverSubscription.js');
const { WalletTransaction } = await import('../src/modules/taxi/driver/models/WalletTransaction.js');
const { User } = await import('../src/modules/taxi/user/models/User.js');
const { UserWallet } = await import('../src/modules/taxi/user/models/UserWallet.js');
const { UserSubscription } = await import('../src/modules/taxi/user/models/UserSubscription.js');
const { Admin } = await import('../src/modules/taxi/admin/models/Admin.js');
const { Airport } = await import('../src/modules/taxi/admin/models/Airport.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { SetPrice } = await import('../src/modules/taxi/admin/models/SetPrice.js');
const { Owner } = await import('../src/modules/taxi/admin/models/Owner.js');
const { OwnerWalletTransaction } = await import('../src/modules/taxi/admin/models/OwnerWalletTransaction.js');
const { PromoCode } = await import('../src/modules/taxi/admin/promotions/models/PromoCode.js');
const { Ride } = await import('../src/modules/taxi/user/models/Ride.js');

await mongoose.connect(uri, { dbName: 'city_rides_test' });
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
const oid = () => new mongoose.Types.ObjectId();
const r2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- the formula (pure), same as the rider web app
{
  const rule = { base_price: 70, base_distance: 2, price_per_distance: 15, time_price: 2, service_tax: 5 };
  const q = quoteService.computeCityFare({ rule, distanceMeters: 8000, durationMinutes: 20 });
  assert.deepEqual([q.basePrice, q.extraKm, q.distanceAmount, q.timeAmount, q.subtotal, q.tax, q.total], [70, 6, 90, 40, 200, 10, 210]);
  const short = quoteService.computeCityFare({ rule, distanceMeters: 1270, durationMinutes: 5 });
  assert.deepEqual([short.timeAmount, short.subtotal, short.total], [0, 70, 74], 'within the base distance: base price only (+tax), no time');
  const surged = quoteService.computeCityFare({ rule, distanceMeters: 8000, durationMinutes: 20, surgeMultiplier: 1.5 });
  assert.deepEqual([surged.fareBeforeSurge, surged.surgeAmount, surged.total], [210, 105, 315], 'surge multiplies the fare');
  const fees = quoteService.computeCityFare({ rule: { ...rule, admin_commision_type: 2, admin_commision: 5 }, distanceMeters: 8000, durationMinutes: 20, airportFee: 60 });
  assert.deepEqual([fees.platformFee, fees.airportFee, fees.total], [5, 60, 275]);
  const pct = quoteService.computeCityFare({ rule: { ...rule, admin_commision_type: 1, admin_commision: 10 }, distanceMeters: 8000, durationMinutes: 20 });
  assert.deepEqual([pct.platformFee, pct.total], [21, 231], 'percentage platform fee is on the fare');
  assert.equal(quoteService.compareFareToQuote({ appFare: 210, quote: q }), null);
  assert.equal(quoteService.compareFareToQuote({ appFare: 214, quote: q }), null, 'within Rs 5');
  assert.equal(quoteService.compareFareToQuote({ appFare: 219, quote: q }), null, 'within 5%');
  const off = quoteService.compareFareToQuote({ appFare: 180, quote: q });
  assert.deepEqual([off.difference, off.serverTotal, off.percent], [-30, 210, -14.29]);
  assert.equal(quoteService.compareFareToQuote({ appFare: 210, quote: fees }), null, 'an app that omits both fees is accepted');
}

// ---------------------------------------------------------------- the city: zone, airport, vehicles, tariffs
const sl = (await (await import('../src/modules/taxi/admin/models/ServiceLocation.js')).ServiceLocation.collection.insertOne({ name: 'Indore', service_location_name: 'Indore', status: 'active', active: true })).insertedId;
const PICKUP = [75.8577, 22.7196];
const DROP = [75.9, 22.76];
const AIRPORT = [75.8011, 22.7218];
const ring = (c, d) => [[[c[0] - d, c[1] - d], [c[0] + d, c[1] - d], [c[0] + d, c[1] + d], [c[0] - d, c[1] + d], [c[0] - d, c[1] - d]]];
const zone = (await Zone.collection.insertOne({ name: 'Indore', service_location_id: sl, active: true, status: 'active', geometry: { type: 'Polygon', coordinates: ring(PICKUP, 0.3) } })).insertedId;
await Airport.collection.insertOne({ name: 'Indore Airport', code: 'IDR', service_location_id: sl, zone_id: zone, location: { type: 'Point', coordinates: AIRPORT }, active: true, status: 'active', pickup_availability: true, drop_availability: true, support_airport_fee: 50, airport_surge: 10 });

const mkVehicle = async (name, icon) => (await Vehicle.collection.insertOne({ name, icon_types: icon, category: icon, capacity: 4, transport_type: 'taxi', is_taxi: 'taxi', active: true, status: 1, is_accept_share_ride: 0, dispatch_type: 'normal' })).insertedId;
const sedan = await mkVehicle('Sedan', 'car');
const bike = await mkVehicle('Bike', 'bike');
const auto = await mkVehicle('Auto', 'auto');
const row = (vehicle, extra) => SetPrice.create({
  zone_id: zone, service_location_id: sl, vehicle_type: vehicle, transport_type: 'taxi', pricing_scope: 'ride', active: 1, status: 'active',
  payment_type: ['cash', 'online', 'wallet'], base_price: 70, base_distance: 2, price_per_distance: 15, time_price: 2, service_tax: 5,
  waiting_charge: 2, free_waiting_before: 3, free_waiting_after: 3, admin_commision_type: 1, admin_commision: 0,
  admin_commission_type_from_driver: 1, admin_commission_from_driver: 10, admin_commission_type_for_owner: 1, admin_commission_for_owner: 10,
  user_cancellation_fee_type: 'fixed', user_cancellation_fee: 20, driver_cancellation_fee_type: 'fixed', driver_cancellation_fee: 30, cancellation_fee_goes_to: 'driver',
  ...extra,
});
const sedanRow = await row(sedan);
// a newer outstation/rental PACKAGE row for the same vehicle and city must never price a city ride
await row(sedan, { pricing_scope: 'package', package_kind: 'intercity', package_destination: 'Bhopal', admin_commission_from_driver: 50, user_cancellation_fee: 999, updatedAt: new Date(Date.now() + 60000) });
const bikeRow = await row(bike, { base_price: 25, price_per_distance: 6, time_price: 1, service_tax: 0, admin_commision_type: 2, admin_commision: 5, cancellation_fee_goes_to: 'admin', user_cancellation_fee: 10 });
const autoRow = await row(auto, { base_price: 30, price_per_distance: 8, time_price: 1, service_tax: 0, admin_commission_type_from_driver: 2, admin_commission_from_driver: 12 });

const rider = await User.create({ name: 'Rider', phone: '9000000041', city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
await Admin.collection.insertOne({ name: 'Super', email: 'super@example.com', password: 'x', createdAt: new Date() });
const tRider = tokenFor(rider._id, 'user');
const tAdmin = tokenFor((await Admin.collection.findOne({ email: 'super@example.com' }))._id, 'admin');
const setRiderWallet = (balance) => UserWallet.updateOne({ userId: rider._id }, { $set: { balance, refundWallet: 0, transactions: [] } }, { upsert: true });
const riderWallet = async () => (await UserWallet.findOne({ userId: rider._id }).lean()) || { balance: 0, refundWallet: 0 };
await setRiderWallet(500);

let phoneN = 10;
const mkDriver = (vehicle, icon, extra = {}) => Driver.create({
  name: `Driver ${phoneN}`, phone: `91000000${phoneN++}`, password: 'x-test-pass', approve: true, status: 'approved', isOnline: true, isOnRide: false,
  vehicleType: icon, vehicleTypeId: vehicle, vehicleTypeIds: [vehicle], vehicleNumber: `MP09AB${phoneN}`, vehicleColor: 'white',
  location: { type: 'Point', coordinates: PICKUP }, wallet: { balance: 1000 }, ...extra,
});
const withPass = (driverId) => DriverSubscription.collection.insertOne({
  driverId, planId: oid(), planName: 'Day', amount: 50, vehicleClasses: ['car', 'bike', 'auto'], startsAt: new Date(Date.now() - 3600e3),
  expiresAt: new Date(Date.now() + 24 * 3600e3), status: 'active', paymentMethod: 'wallet', paidAt: new Date(), tripsCovered: 0, commissionWaived: 0,
});
const balanceOf = async (driver) => r2((await Driver.findById(driver._id).lean()).wallet?.balance || 0);
const txOf = (rideId) => WalletTransaction.find({ rideId }).sort({ createdAt: 1 }).lean();

const book = (vehicle, fare, extra = {}) => rides.createRideRecord({
  userId: rider._id, pickupCoords: PICKUP, dropCoords: DROP, pickupAddress: 'A', dropAddress: 'B', fare,
  vehicleTypeId: String(vehicle), paymentMethod: 'cash', serviceType: 'ride', estimatedDistanceMeters: 8000, estimatedDurationMinutes: 20, ...extra,
});
// accept -> arrive -> (wait) -> start -> end
const drive = async (ride, driver, { waitMinutes = 0, collectedVia, stopBeforeEnd = false } = {}) => {
  const id = String(ride._id);
  await rides.acceptRideAssignment({ rideId: id, driverId: driver._id });
  await rides.updateRideLifecycle({ rideId: id, driverId: driver._id, nextStatus: 'arriving' });
  if (waitMinutes) await Ride.updateOne({ _id: id }, { $set: { arrivedAt: new Date(Date.now() - waitMinutes * 60000) } });
  await rides.updateRideLifecycle({ rideId: id, driverId: driver._id, nextStatus: 'started' });
  if (stopBeforeEnd) return null;
  await rides.updateRideLifecycle({ rideId: id, driverId: driver._id, nextStatus: 'completed', collectedVia });
  return Ride.findById(id).lean();
};
const details = async (ride) => (await call('GET', `/admin/rides/${ride._id}/details`, tAdmin)).body.data;

// ================================================================ 1. THE SERVER QUOTE ENDPOINT
{
  const q = await call('POST', '/rides/quote', tRider, { pickup: PICKUP, drop: DROP, vehicleTypeIds: [String(sedan), String(bike)], estimatedDistanceMeters: 8000, estimatedDurationMinutes: 20 });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const byName = Object.fromEntries(q.body.data.quotes.map((x) => [x.name, x]));
  assert.equal(byName.Sedan.total, 210, 'sedan: 70 + 6 km x 15 + 20 min x 2 = 200, +5% tax');
  assert.equal(byName.Sedan.setPriceId, String(sedanRow._id), 'the ride tariff, not the newer package row');
  assert.deepEqual([byName.Bike.subtotal, byName.Bike.platformFee, byName.Bike.total], [81, 5, 86], 'bike: 25 + 36 + 20, + Rs 5 platform fee');
  assert.equal(q.body.data.category, 'city');
  const all = await call('POST', '/rides/quote', tRider, { pickup: PICKUP, drop: DROP, estimatedDistanceMeters: 8000, estimatedDurationMinutes: 20 });
  assert.equal(all.body.data.quotes.length, 3, 'no vehicleTypeIds = every active vehicle');
  assert.equal((await call('POST', '/rides/quote', null, { pickup: PICKUP, drop: DROP })).status, 401);
  assert.equal((await call('POST', '/rides/quote', tRider, { pickup: PICKUP })).status, 400);
  const air = await call('POST', '/rides/quote', tRider, { pickup: PICKUP, drop: AIRPORT, vehicleTypeIds: [String(sedan)], estimatedDistanceMeters: 8000, estimatedDurationMinutes: 20 });
  assert.deepEqual([air.body.data.category, air.body.data.quotes[0].airportFee, air.body.data.quotes[0].total], ['airport', 60, 270], 'airport surge 10 + support fee 50 on top');
}

// ================================================================ 2. CASH RIDE, DRIVER ON COMMISSION
const onCommission = await mkDriver(sedan, 'car');
const cash = await book(sedan, 210);
assert.equal(String(cash.pricingSnapshot.setPriceId), String(sedanRow._id), 'booked on the ride tariff of its zone, not the package row');
assert.equal(cash.pricingSnapshot.admin_commission_from_driver, 10);
assert.deepEqual([cash.pricingSnapshot.serverQuote.total, cash.pricingSnapshot.serverQuote.fareMismatch], [210, null], 'app and tariff agree');
const cashDone = await drive(cash, onCommission);
assert.deepEqual([cashDone.fare, cashDone.commissionAmount, cashDone.driverEarnings, cashDone.paymentMethod, cashDone.waitingCharge], [210, 21, 189, 'cash', 0]);
assert.equal(await balanceOf(onCommission), 979, 'cash ride: only the 10% commission leaves the driver wallet');
const cashTx = await txOf(cash._id);
assert.deepEqual([cashTx.length, cashTx[0].type, cashTx[0].amount], [1, 'commission_deduction', -21]);
// settlement used to replace the whole pricing snapshot, wiping the owner commission, waiting terms and the server quote
assert.deepEqual([cashDone.pricingSnapshot.waiting_charge, cashDone.pricingSnapshot.admin_commission_for_owner, cashDone.pricingSnapshot.serverQuote.total], [2, 10, 210], 'settlement keeps the snapshot');
assert.equal(String(cashDone.pricingSnapshot.setPriceId), String(sedanRow._id));

// ---- the admin detail shows the numbers
{
  const d = await details(cash);
  assert.deepEqual([d.fare.final, d.fare.serverQuote.total, d.fare.serverQuote.difference, d.fare.serverQuote.mismatch], [210, 210, 0, null]);
  assert.deepEqual([d.settlement.settled, d.settlement.commission, d.settlement.driverEarnings], [true, 21, 189]);
  assert.equal(d.settlement.driverWallet[0].amount, -21);
  assert.equal(d.snapshots.tariff.base_price, 70);
}

// ================================================================ 3. A FARE THAT DISAGREES WITH THE TARIFF IS KEPT AND FLAGGED, NEVER REJECTED
{
  const cheap = await book(sedan, 180);
  assert.equal(cheap.fare, 180, 'the fare the app sent is what is charged');
  assert.equal(cheap.pricingSnapshot.serverQuote.fareMismatch.difference, -30);
  const d = await details(cheap);
  assert.deepEqual([d.fare.serverQuote.total, d.fare.serverQuote.difference, d.fare.serverQuote.mismatch.percent], [210, -30, -14.29]);
  await dispatch.cancelRideByUser({ rideId: String(cheap._id), userId: rider._id });
}

// ================================================================ 4. UPI TO THE DRIVER, DRIVER ON A DAILY PASS
const onPass = await mkDriver(sedan, 'car');
await withPass(onPass._id);
const upi = await drive(await book(sedan, 210), onPass, { collectedVia: 'upi' });
assert.deepEqual([upi.collectedVia, upi.paymentMethod, upi.commissionAmount, upi.driverEarnings], ['upi', 'cash', 0, 210], 'UPI is cash-like; a pass keeps the whole fare');
assert.equal(await balanceOf(onPass), 1000, 'nothing is deducted on a pass');
assert.equal((await DriverSubscription.findOne({ driverId: onPass._id }).lean()).commissionWaived, 21, 'the waiver is counted');

// ================================================================ 5. BOOKED AS ONLINE: the platform pays the driver
{
  const d = await mkDriver(sedan, 'car');
  const done = await drive(await book(sedan, 210, { paymentMethod: 'online' }), d);
  assert.deepEqual([done.paymentMethod, done.commissionAmount, done.driverEarnings], ['online', 21, 189]);
  assert.equal(await balanceOf(d), 1189, 'online fare: earnings are credited to the wallet');
}

// ================================================================ 6. RIDER PAID THE FARE ONLINE IN THE APP (cash-like settlement, wallet already credited)
{
  const d = await mkDriver(sedan, 'car');
  const ride = await book(sedan, 210);
  await rides.acceptRideAssignment({ rideId: String(ride._id), driverId: d._id });
  // what verifyRazorpayRideFare does: the fare reaches the driver's wallet and the ride is marked paid online
  await Ride.updateOne({ _id: ride._id }, { $set: { collectedVia: 'online', driverPaymentCollection: { provider: 'razorpay', providerPaymentId: 'pay_x', source: 'rider_fare_online', status: 'paid', amount: 210, paidAt: new Date() } } });
  const walletMod = await import('../src/modules/taxi/driver/services/walletService.js');
  await walletMod.applyDriverWalletAdjustment({ driverId: d._id, rideId: ride._id, amount: 210, type: 'adjustment', description: 'Ride fare paid online by rider' });
  await rides.updateRideLifecycle({ rideId: String(ride._id), driverId: d._id, nextStatus: 'arriving' });
  await rides.updateRideLifecycle({ rideId: String(ride._id), driverId: d._id, nextStatus: 'started' });
  await rides.updateRideLifecycle({ rideId: String(ride._id), driverId: d._id, nextStatus: 'completed', collectedVia: 'cash' });
  const done = await Ride.findById(ride._id).lean();
  assert.deepEqual([done.collectedVia, done.paymentMethod, done.commissionAmount], ['online', 'cash', 21], 'whatever the driver taps, it stays online');
  assert.equal(await balanceOf(d), 1189, '210 credited by the payment, 21 commission taken: same net as every other way');
}

// ================================================================ 7. RIDER PAYS FROM THE APP WALLET AFTER THE TRIP, WITH A TIP
{
  const d = await mkDriver(sedan, 'car');
  const done = await drive(await book(sedan, 210), d);
  assert.equal(await balanceOf(d), 979);
  await setRiderWallet(500);
  const paid = await call('POST', `/rides/${done._id}/complete-payment/wallet`, tRider, { rating: 5, comment: 'ok', tipAmount: 20 });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  assert.equal((await riderWallet()).balance, 270, 'fare 210 + tip 20 debited from the rider wallet');
  assert.equal(await balanceOf(d), 979 + 210 + 20, 'the driver gets the fare the platform now holds, plus the whole tip');
  const after = await Ride.findById(done._id).lean();
  assert.deepEqual([after.feedback.tipAmount, after.paymentMethod], [20, 'online']);
  assert.equal((await details(done)).feedback.tip, 20);
  const again = await call('POST', `/rides/${done._id}/complete-payment/wallet`, tRider, { rating: 5, tipAmount: 20 });
  assert.equal(again.status, 409, 'feedback and payment only once');
}

// ================================================================ 8. USER SUBSCRIPTION COVERS THE FARE
{
  await UserSubscription.create({ userId: rider._id, planId: oid(), name: 'Monthly', vehicle_type_id: sedan, benefit_type: 'limited', ride_limit: 5, rides_used: 0, status: 'active', active: true, expiresAt: new Date(Date.now() + 30 * 864e5) });
  const d = await mkDriver(sedan, 'car');
  const ride = await book(sedan, 210);
  assert.deepEqual([ride.subscriptionUsage.covered, ride.paymentMethod, ride.driverPaymentCollection.status], [true, 'online', 'paid']);
  const done = await drive(ride, d, { waitMinutes: 20 });
  assert.equal(done.waitingCharge, 0, 'no waiting charge on a plan-covered ride');
  assert.deepEqual([done.commissionAmount, done.driverEarnings], [21, 189]);
  assert.equal(await balanceOf(d), 1189, 'the platform pays the driver for a covered ride');
  assert.equal((await UserSubscription.findOne({ userId: rider._id }).lean()).rides_used, 1);
  await UserSubscription.deleteMany({ userId: rider._id });
  const promoRide = await book(sedan, 210, { promo_code: 'NOPE' }).catch((e) => e);
  assert.ok(promoRide instanceof Error, 'an unknown promo is refused');
}

// ================================================================ 9. PROMO CODE
{
  await PromoCode.create({ service_location_id: sl, code: 'SAVE20', discount_percentage: 20, maximum_discount_amount: 30, from_date: new Date(Date.now() - 864e5), to_date: new Date(Date.now() + 864e5), uses_per_user: 3, transport_type: 'all' });
  const d = await mkDriver(sedan, 'car');
  const ride = await book(sedan, 210, { promo_code: 'save20' });
  assert.deepEqual([ride.fare, ride.baseFare, ride.promo.discount_amount], [180, 210, 30], '20% capped at Rs 30 comes off the fare; the quote stays 210');
  assert.equal(ride.pricingSnapshot.serverQuote.fareMismatch, null, 'a promo is not a fare mismatch (the app sent the undiscounted 210)');
  const done = await drive(ride, d);
  assert.deepEqual([done.fare, done.commissionAmount, done.driverEarnings], [180, 18, 162], 'commission is on what the rider pays');
  assert.equal((await details(ride)).fare.promo.discount, 30);
}

// ================================================================ 10. WAITING CHARGE AT THE END
{
  const d = await mkDriver(sedan, 'car');
  const ride = await book(sedan, 210);
  const done = await drive(ride, d, { waitMinutes: 10 });
  // 10 minutes at the pickup, 3 free, 7 x Rs 2
  assert.deepEqual([done.waitingMinutes, done.waitingCharge, done.fare], [7, 14, 224], 'the waiting charge is added to the fare');
  assert.deepEqual([done.commissionAmount, done.driverEarnings], [22.4, 201.6], 'and settled with it');
  assert.equal(await balanceOf(d), 977.6);
  assert.equal(done.baseFare, 210, 'the quoted fare is untouched');
  const detail = await details(ride);
  assert.deepEqual([detail.fare.waitingMinutes, detail.fare.waitingCharge, detail.fare.final], [7, 14, 224]);
  const free = await drive(await book(sedan, 210), await mkDriver(sedan, 'car'), { waitMinutes: 3 });
  assert.deepEqual([free.waitingCharge, free.fare], [0, 210], 'the free minutes are free');
}

// ================================================================ 11. AIRPORT RIDE
{
  const d = await mkDriver(sedan, 'car');
  const noFee = await book(sedan, 210, { dropCoords: AIRPORT });
  assert.equal(noFee.pricingSnapshot.serverQuote.fareMismatch, null, 'an app that does not add the airport fee is not flagged (the flat fee is the apps\' to add)');
  await dispatch.cancelRideByUser({ rideId: String(noFee._id), userId: rider._id });
  const ride = await book(sedan, 270, { dropCoords: AIRPORT });
  assert.deepEqual([ride.trip_category.category, ride.trip_category.airport_name, ride.trip_category.airport_fee], ['airport', 'Indore Airport', 60]);
  assert.equal(ride.pricingSnapshot.serverQuote.total, 270);
  assert.equal(ride.pricingSnapshot.serverQuote.fareMismatch, null);
  const done = await drive(ride, d);
  assert.deepEqual([done.fare, done.commissionAmount, done.driverEarnings], [270, 27, 243]);
  const detail = await details(ride);
  assert.deepEqual([detail.kind.key, detail.typeDetails.airport, detail.typeDetails.airportFee], ['airport', 'Indore Airport', 60]);
}

// ================================================================ 12. BIKE (platform fee) AND AUTO (fixed commission)
{
  const bd = await mkDriver(bike, 'bike');
  const ride = await book(bike, 86, { platformFee: 5 });
  assert.equal(ride.pricingSnapshot.rider_platform_fee, 5);
  assert.deepEqual([ride.pricingSnapshot.serverQuote.total, ride.pricingSnapshot.serverQuote.fareMismatch], [86, null]);
  const done = await drive(ride, bd);
  // 10% of the driver's part (86 - 5 = 81) = 8.1, plus the Rs 5 fee that was never the driver's
  assert.deepEqual([done.commissionAmount, done.driverEarnings], [13.1, 72.9]);
  assert.equal(await balanceOf(bd), 986.9);
  const tooBig = await book(bike, 86, { platformFee: 50 });
  assert.equal(tooBig.pricingSnapshot.rider_platform_fee, 5, 'a platform fee above the tariff is capped');
  await dispatch.cancelRideByUser({ rideId: String(tooBig._id), userId: rider._id });

  const ad = await mkDriver(auto, 'auto');
  const autoDone = await drive(await book(auto, 98), ad);
  assert.deepEqual([autoDone.commissionAmount, autoDone.driverEarnings], [12, 86], 'a fixed commission is the same on any fare');
  assert.equal(await balanceOf(ad), 988);
}

// ================================================================ 13. FLEET DRIVER (the owner is settled, not the driver)
{
  const owner = await Owner.create({ name: 'Owner', company_name: 'Fleet', mobile: '9200000077', email: 'o@example.com', password: 'x-test-pass', approve: true, status: 'approved', billing: { mode: 'commission' }, wallet: { balance: 0 } });
  const fleet = await mkDriver(sedan, 'car', { owner_id: owner._id });
  const ride = await book(sedan, 210);
  const done = await drive(ride, fleet);
  assert.deepEqual([String(done.ownerId), done.commissionAmount, done.driverEarnings], [String(owner._id), 21, 189]);
  const ot = await OwnerWalletTransaction.find({ rideId: ride._id }).lean();
  assert.deepEqual([ot.length, ot[0].type, ot[0].amount, ot[0].kind], [1, 'commission_deduction', 21, 'debit'], 'cash fleet ride: the owner owes the commission');
  assert.equal(await balanceOf(fleet), 1000, 'the fleet driver wallet is untouched');
  const d = await details(ride);
  assert.equal(d.settlement.fleetOwnerId, String(owner._id));
  assert.equal(d.settlement.ownerWallet[0].amount, 21);
}

// ================================================================ 14. CANCELLATION FEES
{
  // rider cancels BEFORE any driver accepted: nothing to pay
  await setRiderWallet(100);
  const searching = await book(sedan, 210);
  await dispatch.cancelRideByUser({ rideId: String(searching._id), userId: rider._id });
  assert.equal((await riderWallet()).balance, 100, 'no driver yet: no fee');

  // rider cancels AFTER a driver accepted: Rs 20 from the rider, to the driver (this tariff says goes_to driver)
  const d = await mkDriver(sedan, 'car');
  const accepted = await book(sedan, 210);
  await rides.acceptRideAssignment({ rideId: String(accepted._id), driverId: d._id });
  await dispatch.cancelRideByUser({ rideId: String(accepted._id), userId: rider._id });
  assert.equal((await riderWallet()).balance, 80, 'Rs 20 (the sedan zone row, not the Rs 999 package row)');
  assert.equal(await balanceOf(d), 1020, 'goes to the driver');
  await dispatch.cancelRideByUser({ rideId: String(accepted._id), userId: rider._id });
  assert.equal((await riderWallet()).balance, 80, 'cancelling twice charges once');

  // the bike tariff sends the fee to admin, not the driver
  const bd = await mkDriver(bike, 'bike');
  const bikeRide = await book(bike, 86);
  await rides.acceptRideAssignment({ rideId: String(bikeRide._id), driverId: bd._id });
  await dispatch.cancelRideByUser({ rideId: String(bikeRide._id), userId: rider._id });
  assert.equal((await riderWallet()).balance, 70, 'Rs 10 on the bike tariff');
  assert.equal(await balanceOf(bd), 1000, 'admin keeps it');
  const cancelled = await details(bikeRide);
  assert.equal(cancelled.cancellation.by !== undefined, true);

  // a rider with no money left cannot be charged (the fee is skipped, the cancellation still happens)
  await setRiderWallet(5);
  const poor = await book(sedan, 210);
  await rides.acceptRideAssignment({ rideId: String(poor._id), driverId: d._id });
  await dispatch.cancelRideByUser({ rideId: String(poor._id), userId: rider._id });
  assert.equal((await Ride.findById(poor._id).lean()).status, 'cancelled');
  assert.equal((await riderWallet()).balance, 5);

  // driver cancels an upcoming scheduled ride: Rs 30 from the driver to the rider's refund wallet
  await setRiderWallet(0);
  const d2 = await mkDriver(sedan, 'car');
  const later = await book(sedan, 210, { scheduledAt: new Date(Date.now() + 4 * 3600e3).toISOString() });
  await rides.acceptRideAssignment({ rideId: String(later._id), driverId: d2._id });
  await dispatch.cancelScheduledRideByDriver({ rideId: String(later._id), driverId: d2._id });
  assert.equal(await balanceOf(d2), 970, 'Rs 30 driver cancellation fee');
  assert.equal((await riderWallet()).refundWallet, 30, 'goes to the rider');
}

// ================================================================ 15. A PACKAGE ROW NEVER PRICES A CITY RIDE (cancellation / settlement lookups too)
{
  const lookup = await rides.resolveSetPriceForRide({ zoneId: zone, serviceLocationId: sl, transportType: 'taxi', vehicleTypeId: sedan, excludePackages: true });
  assert.equal(String(lookup._id), String(sedanRow._id));
}

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('city rides: all checks passed');
process.exit(0);
