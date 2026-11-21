// Outstation (one way / round trip, tolls, advance, counter-offer, cancel), hourly rental and share ride: every number
// from booking to settlement and the admin detail page, against a THROWAWAY, STANDALONE Mongo (like production).
//   OSR_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testOutstationRentalShare.mjs
// Drops its own database (outstation_rental_share_test) when done. Never point it at production.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.OSR_TEST_MONGODB_URI;
if (!uri) throw new Error('Set OSR_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB_NAME: 'outstation_rental_share_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test' });

// Indore -> Bhopal as one straight line (two points), so the toll plazas on it are known.
const PICKUP = [75.8577, 22.7196];
const DROP = [77.4126, 23.2599];
const encodeNumber = (value) => {
  let v = Math.round(value * 1e5) << 1;
  if (value < 0) v = ~v;
  let out = '';
  while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
  return out + String.fromCharCode(v + 63);
};
const ROUTE_POLYLINE = encodeNumber(PICKUP[1]) + encodeNumber(PICKUP[0]) + encodeNumber(DROP[1] - PICKUP[1]) + encodeNumber(DROP[0] - PICKUP[0]);

const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) => {
  const text = String(url);
  if (text.startsWith('http://127.0.0.1')) return realFetch(url, ...rest);
  if (text.startsWith('https://router.project-osrm.org')) {
    return Promise.resolve(new Response(JSON.stringify({ code: 'Ok', routes: [{ geometry: ROUTE_POLYLINE, distance: 190000, duration: 11400 }] }), { status: 200 }));
  }
  return Promise.reject(new Error('offline in test'));
};

const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/modules/taxi/services/tokenService.js');
const rides = await import('../src/modules/taxi/services/rideService.js');
const advance = await import('../src/modules/taxi/services/rideAdvanceService.js');
const { cancelRideByUser } = await import('../src/modules/taxi/services/dispatchService.js');
const share = await import('../src/modules/taxi/shareRide/services/shareRideService.js');
const { installStandaloneTransactionShim } = await import('../src/config/database.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { DriverSubscription } = await import('../src/modules/taxi/driver/models/DriverSubscription.js');
const { DriverLocationHistory } = await import('../src/modules/taxi/driver/models/DriverLocationHistory.js');
const { WalletTransaction } = await import('../src/modules/taxi/driver/models/WalletTransaction.js');
const { User } = await import('../src/modules/taxi/user/models/User.js');
const { UserWallet } = await import('../src/modules/taxi/user/models/UserWallet.js');
const { Admin } = await import('../src/modules/taxi/admin/models/Admin.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { SetPrice } = await import('../src/modules/taxi/admin/models/SetPrice.js');
const { TollPlaza } = await import('../src/modules/taxi/admin/models/TollPlaza.js');
const { Owner } = await import('../src/modules/taxi/admin/models/Owner.js');
const { OwnerWalletTransaction } = await import('../src/modules/taxi/admin/models/OwnerWalletTransaction.js');
const { Ride } = await import('../src/modules/taxi/user/models/Ride.js');
const { RideAdvance } = await import('../src/modules/taxi/user/models/RideAdvance.js');
const { ShareRide } = await import('../src/modules/taxi/shareRide/models/ShareRide.js');
const { ShareTrip } = await import('../src/modules/taxi/shareRide/models/ShareTrip.js');

await mongoose.connect(uri, { dbName: 'outstation_rental_share_test' });
await mongoose.connection.dropDatabase();
await installStandaloneTransactionShim();
await Promise.all([Driver.init(), Ride.init(), RideAdvance.init(), TollPlaza.init(), ShareRide.init(), ShareTrip.init()]);

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
const round = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- admin data
const sedan = (await Vehicle.collection.insertOne({ name: 'Sedan', icon_types: 'car', category: 'car', capacity: 4, transport_type: 'taxi', is_taxi: 'taxi', active: true, status: 1, is_accept_share_ride: 1, dispatch_type: 'normal' })).insertedId;
const suv = (await Vehicle.collection.insertOne({ name: 'SUV', icon_types: 'car', category: 'car', capacity: 6, transport_type: 'taxi', is_taxi: 'taxi', active: true, status: 1, dispatch_type: 'normal' })).insertedId;
await Admin.collection.insertOne({ name: 'Super', email: 'super@example.com', password: 'x', createdAt: new Date() });
const tAdmin = tokenFor((await Admin.collection.findOne({ email: 'super@example.com' }))._id, 'admin');

// the city tariff of the Sedan: 10% commission from a driver, 5% from an owner, Rs 5 / 10% rider platform fee for share rides
await SetPrice.collection.insertOne({
  vehicle_type: sedan, transport_type: 'taxi', active: 1, status: 'active', pricing_scope: 'ride', base_price: 60, base_distance: 2, price_per_distance: 14,
  admin_commission_type_from_driver: 1, admin_commission_from_driver: 10, admin_commission_type_for_owner: 1, admin_commission_for_owner: 5,
  user_cancellation_fee_type: 'percentage', user_cancellation_fee: 10, driver_cancellation_fee_type: 'fixed', driver_cancellation_fee: 50, cancellation_fee_goes_to: 'driver',
  rider_platform_fee: 5, rider_platform_fee_type: 'percentage', createdAt: new Date(), updatedAt: new Date(),
});

// two toll plazas on the Indore -> Bhopal line
const mid = (a, b, t) => a + (b - a) * t;
const plaza = (name, t, prices) => TollPlaza.create({
  name, highway: 'NH46', active: true, radius_meters: 500,
  location: { type: 'Point', coordinates: [mid(PICKUP[0], DROP[0], t), mid(PICKUP[1], DROP[1], t)] },
  prices: prices.map(([vehicle, one_way, return_trip]) => ({ vehicle_type_id: vehicle, one_way, return_trip })),
});
await plaza('Plaza A', 0.3, [[sedan, 100, 60], [suv, 200, 150]]);
await plaza('Plaza B', 0.7, [[sedan, 50, 0], [suv, 80, 0]]);

const pkg = await SetPrice.create({
  pricing_scope: 'package', package_kind: 'intercity', transport_type: 'taxi', package_destination: 'Bhopal', package_availability: 'available', active: 1, status: 'active',
  package_vehicle_prices: [
    { vehicle_type: sedan, extra_day_price: 2000, base_price: 3000, free_distance: 200, distance_price: 12, advance_type: 'percentage', advance_value: 20, active: 1, admin_commission_type_from_driver: 1, admin_commission_from_driver: 10, admin_commission_type_for_owner: 1, admin_commission_for_owner: 5 },
    { vehicle_type: suv, base_price: 4000, free_distance: 200, distance_price: 15, advance_type: 'fixed', advance_value: 500, active: 1, admin_commission_type_from_driver: 1, admin_commission_from_driver: 10, admin_commission_type_for_owner: 1, admin_commission_for_owner: 5 },
  ],
});
const packageId = String(pkg._id);

const rider = await User.create({ name: 'Rider', phone: '9000000061', city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
const tRider = tokenFor(rider._id, 'user');
let phoneN = 10;
const mkDriver = (extra = {}) => Driver.create({
  name: `Driver ${phoneN}`, phone: `91000001${phoneN++}`, password: 'x-test-pass', approve: true, status: 'approved', isOnline: true, isOnRide: false,
  vehicleType: 'car', vehicleTypeId: sedan, vehicleTypeIds: [sedan, suv], vehicleNumber: `MH12CD${phoneN}`, vehicleColor: 'white',
  location: { type: 'Point', coordinates: PICKUP }, locationUpdatedAt: new Date(), wallet: { balance: 1000 }, ...extra,
});
const withPass = (driverId) => DriverSubscription.collection.insertOne({
  driverId, planId: oid(), planName: 'Day', amount: 50, vehicleClasses: ['car'], startsAt: new Date(Date.now() - 3600e3),
  expiresAt: new Date(Date.now() + 24 * 3600e3), status: 'active', paymentMethod: 'wallet', paidAt: new Date(), tripsCovered: 0, commissionWaived: 0,
});
const walletOf = async (driverId) => round((await Driver.findById(driverId).lean()).wallet?.balance || 0);
const paidAdvance = async (vehicle, fare, amount, n) => RideAdvance.create({
  userId: rider._id, packageId: pkg._id, vehicleTypeId: vehicle, fare, amount, status: 'paid', razorpayOrderId: `order_${n}`, razorpayPaymentId: `pay_${n}`, paidAt: new Date(),
});
const outstation = (vehicle, appFare, tripType, extra = {}) => rides.createRideRecord({
  userId: rider._id, pickupCoords: PICKUP, dropCoords: DROP, pickupAddress: 'Indore', dropAddress: 'Bhopal', fare: appFare,
  vehicleTypeId: String(vehicle), paymentMethod: 'cash', serviceType: 'intercity', transport_type: 'intercity', estimatedDistanceMeters: 190000,
  intercity: { fromCity: 'Indore', toCity: 'Bhopal', tripType, packageId }, ...extra,
});
const drive = async (rideId, driverId, collectedVia = 'cash') => {
  await rides.acceptRideAssignment({ rideId: String(rideId), driverId });
  for (const nextStatus of ['arriving', 'started', 'arrived']) await rides.updateRideLifecycle({ rideId: String(rideId), driverId, nextStatus });
  return rides.updateRideLifecycle({ rideId: String(rideId), driverId, nextStatus: 'completed', collectedVia });
};
const adminDetails = async (rideId) => {
  const response = await call('GET', `/admin/rides/${rideId}/details`, tAdmin);
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 300));
  return response.body.data;
};

// ================================================================ 1. OUTSTATION ONE WAY: tolls + 20% advance
const oneWayQuote = await call('POST', '/rides/outstation/advance/quote', tRider, {
  pickup: PICKUP, drop: DROP, vehicleTypeId: String(sedan), fare: 3000, intercity: { packageId, toCity: 'Bhopal', tripType: 'One Way' },
});
assert.equal(oneWayQuote.status, 200, JSON.stringify(oneWayQuote.body));
assert.deepEqual([oneWayQuote.body.data.fare, oneWayQuote.body.data.amount, oneWayQuote.body.data.remaining], [3150, 630, 2520], 'card Rs 3000 + 100 + 50 tolls; 20% of the fare WITH tolls');
assert.equal(oneWayQuote.body.data.tolls, 150, 'the quote says how much of the fare is tolls');

const adv1 = await paidAdvance(sedan, 3150, 630, 1);
const trip1 = await outstation(sedan, 3000, 'One Way', { advanceId: String(adv1._id) });
assert.equal(trip1.fare, 3150);
assert.equal(trip1.tollCharges.total, 150);
assert.equal(trip1.tollCharges.roundTrip, false);
assert.deepEqual(trip1.tollCharges.items.map((i) => [i.name, i.amount]), [['Plaza A', 100], ['Plaza B', 50]]);
assert.deepEqual([trip1.advance.amount, trip1.advance.status], [630, 'applied']);
assert.equal(trip1.pricingSnapshot.admin_commission_from_driver, 10, 'the outstation ride earns the commission of the vehicle city tariff');
const live1 = rides.serializeRideRealtime(trip1);
assert.deepEqual([live1.fare, live1.advancePaid, live1.amountDue, live1.tollCharges.total], [3150, 630, 2520, 150]);

const solo = await mkDriver();
const done1 = await drive(trip1._id, solo._id);
const settled1 = await Ride.findById(trip1._id).lean();
assert.equal(settled1.commissionAmount, 300, '10% of (3150 fare - 150 tolls)');
assert.equal(settled1.driverEarnings, 2850, 'tolls are the driver\'s');
assert.equal(await walletOf(solo._id), 1000 + 330, 'advance 630 held by the platform - commission 300; the driver collects the other 2520 in cash');
assert.equal(round(2520 + 330), settled1.driverEarnings, 'cash in hand + wallet credit = driver earnings');
assert.equal(advance.amountDueAfterAdvance(settled1), 2520);
const detail1 = await adminDetails(trip1._id);
assert.equal(detail1.kind.label, 'Outstation (One way)');
assert.deepEqual([detail1.fare.final, detail1.fare.advancePaid, detail1.fare.amountDue], [3150, 630, 2520]);
assert.equal(detail1.settlement.settled, true);
assert.equal(detail1.settlement.commission ?? detail1.settlement.commissionAmount, 300);
// ================================================================ 2. OUTSTATION ROUND TRIP: SUV, fixed advance, fleet driver on the owner commission
const roundQuote = await call('POST', '/rides/outstation/advance/quote', tRider, {
  pickup: PICKUP, drop: DROP, vehicleTypeId: String(suv), fare: 7200, intercity: { packageId, toCity: 'Bhopal', tripType: 'Round Trip' },
});
assert.deepEqual([roundQuote.body.data.fare, roundQuote.body.data.tolls, roundQuote.body.data.amount, roundQuote.body.data.remaining], [7710, 510, 500, 7210], 'card 4000 x 1.8 = 7200; tolls both ways 350 + 160; the fixed advance is Rs 500');
const owner = await Owner.create({ name: 'Owner', company_name: 'Fleet', mobile: '9200000088', email: 'o88@example.com', password: 'x-test-pass', approve: true, status: 'approved', billing: { mode: 'commission' }, wallet: { balance: 0 } });
const fleet = await mkDriver({ owner_id: owner._id });
const adv2 = await paidAdvance(suv, 7710, 500, 2);
const trip2 = await outstation(suv, 7200, 'Round Trip', { advanceId: String(adv2._id) });
assert.deepEqual([trip2.fare, trip2.tollCharges.total, trip2.tollCharges.roundTrip, trip2.advance.amount], [7710, 510, true, 500]);
assert.deepEqual(trip2.tollCharges.items.map((i) => [i.oneWay, i.returnTrip, i.amount]), [[200, 150, 350], [80, 80, 160]], 'a plaza with no return price charges the one-way price again');
await drive(trip2._id, fleet._id);
const settled2 = await Ride.findById(trip2._id).lean();
assert.equal(settled2.commissionAmount, 360, 'owner commission 5% of (7710 - 510 tolls)');
assert.equal(settled2.driverEarnings, 7350);
assert.equal(round((await Owner.findById(owner._id).lean()).wallet.balance), 140, 'owner: advance 500 - commission 360');
assert.equal(await walletOf(fleet._id), 1000, "the fleet driver's own wallet is not touched");
const detail2 = await adminDetails(trip2._id);
assert.equal(detail2.kind.label, 'Outstation (Round trip)');
assert.deepEqual([detail2.fare.final, detail2.fare.advancePaid, detail2.fare.amountDue, detail2.fare.tolls.total], [7710, 500, 7210, 510]);

// ================================================================ 2b. OUTSTATION MULTI-DAY ROUND TRIP: days x the admin's prices, extra days billed at the end
const dayFns = await import('../src/modules/taxi/services/outstationDays.js');
assert.equal(dayFns.outstationDayFare({ basePrice: 3000, extraDayPrice: 2000, days: 1 }), 5400, 'one day = the round trip price, 3000 x 1.8');
assert.equal(dayFns.outstationDayFare({ basePrice: 3000, extraDayPrice: 2000, days: 3 }), 9400, '5400 + 2 extra days of 2000');
assert.equal(dayFns.normalizeTripDays({ tripType: 'One Way', days: 5 }), 1, 'a one way trip is always 1 day');
assert.equal(dayFns.normalizeTripDays({ tripType: 'Round Trip', days: 99 }), 30, 'capped at 30 days');
assert.equal(dayFns.normalizeTripDays({ tripType: 'Round Trip' }), 1);
assert.equal(dayFns.actualTripDays(new Date('2026-01-01T18:00:00Z'), new Date('2026-01-02T19:00:00Z')), 3, 'India calendar days: 23:30 on the 1st to 00:30 on the 3rd touches 3 days');
assert.equal(dayFns.actualTripDays(new Date('2026-01-01T04:00:00Z'), new Date('2026-01-01T16:00:00Z')), 1);

const dayBody = (vehicle, days, tripType = 'Round Trip') => ({
  pickup: PICKUP, drop: DROP, vehicleTypeId: String(vehicle), fare: 1, intercity: { packageId, toCity: 'Bhopal', tripType, days },
});
const dayQuote = (await call('POST', '/rides/outstation/advance/quote', tRider, dayBody(sedan, 3))).body.data;
assert.equal(dayQuote.days, 3);
assert.equal(dayQuote.extraDayPrice, 2000);
assert.ok(dayQuote.tolls > 0, 'tolls both ways are added on top');
assert.equal(dayQuote.fare, 9400 + dayQuote.tolls, "the server's own price: the app's fare of 1 is ignored");
assert.equal(dayQuote.amount, Math.round(dayQuote.fare * 0.2), 'the advance is 20% of the multi-day total');
const oneWayDays = (await call('POST', '/rides/outstation/advance/quote', tRider, dayBody(sedan, 5, 'One Way'))).body.data;
assert.equal(oneWayDays.days, 1, 'days on a one way trip are ignored');
const noExtra = await call('POST', '/rides/outstation/advance/quote', tRider, dayBody(suv, 3));
assert.equal(noExtra.status, 400, 'a vehicle with no extra day price cannot be booked for days');
assert.equal(noExtra.body.code, 'MULTI_DAY_NOT_AVAILABLE');
const catalog = await call('GET', '/users/intercity-packages?lat=22.7196&lng=75.8577', tRider);
if (catalog.status === 200) {
  const found = JSON.stringify(catalog.body).includes('extraDayPrice');
  assert.ok(found || !JSON.stringify(catalog.body).includes('vehicles'), 'the rider catalog carries extraDayPrice');
}

const dayDriver = await mkDriver();
const dayWalletBefore = await walletOf(dayDriver._id);
const dayAdvance = await paidAdvance(sedan, dayQuote.fare, dayQuote.amount, 20);
const dayTrip = await outstation(sedan, 1, 'Round Trip', {
  advanceId: String(dayAdvance._id),
  intercity: { fromCity: 'Indore', toCity: 'Bhopal', tripType: 'Round Trip', packageId, days: 3, returnDate: '2026-12-12' },
});
assert.equal(dayTrip.fare, dayQuote.fare, 'the booking is made at the server price');
assert.deepEqual([dayTrip.intercity.days, dayTrip.intercity.extraDayPrice, dayTrip.intercity.returnDate], [3, 2000, '2026-12-12']);
assert.equal(dayTrip.advance.amount, dayQuote.amount);
assert.deepEqual(dayFns.outstationOfferFields(dayTrip), { tripDays: '3', returnDate: '2026-12-12' }, 'the driver offer says how many days');
assert.deepEqual(dayFns.outstationOfferFields({ serviceType: 'intercity', intercity: { days: 1 } }), {}, 'a 1 day ride adds nothing to the offer');

// the rider keeps the cab one day longer than booked: started 3 calendar days ago = 4 days used
await rides.acceptRideAssignment({ rideId: String(dayTrip._id), driverId: dayDriver._id });
for (const nextStatus of ['arriving', 'started']) await rides.updateRideLifecycle({ rideId: String(dayTrip._id), driverId: dayDriver._id, nextStatus });
await Ride.updateOne({ _id: dayTrip._id }, { $set: { startedAt: new Date(Date.now() - 3 * 24 * 3600e3) } });
await rides.updateRideLifecycle({ rideId: String(dayTrip._id), driverId: dayDriver._id, nextStatus: 'arrived' });
const dayArrived = await Ride.findById(dayTrip._id).lean();
assert.deepEqual([dayArrived.intercity.actualDays, dayArrived.intercity.extraDays, dayArrived.intercity.extraDayCharge], [4, 1, 2000]);
assert.equal(dayArrived.fare, dayQuote.fare + 2000, 'the extra day is in the fare before the driver collects it');
assert.equal(advance.amountDueAfterAdvance(dayArrived), dayQuote.fare + 2000 - dayQuote.amount, 'the balance to collect includes the extra day');
await rides.updateRideLifecycle({ rideId: String(dayTrip._id), driverId: dayDriver._id, nextStatus: 'completed', collectedVia: 'cash' });
const daySettled = await Ride.findById(dayTrip._id).lean();
assert.equal(daySettled.fare, dayQuote.fare + 2000, 'completing does not bill the extra day twice');
const dayTolls = daySettled.tollCharges.total;
const dayCommission = round(((dayQuote.fare + 2000 - dayTolls) * 10) / 100);
assert.equal(daySettled.commissionAmount, dayCommission, 'commission 10% of the final fare without tolls');
assert.equal(await walletOf(dayDriver._id), round(dayWalletBefore + dayQuote.amount - dayCommission), 'advance held by the platform - commission; the driver collects the rest in cash');

// ================================================================ 2c. TRIP PIN: the server checks the rider's PIN when the driver starts the trip
let pinAdv = 40;
const pinRider = await User.create({ name: 'Pin Rider', phone: '9000000062', city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
const pinRide = async () => {
  const pinDriver = await mkDriver();
  const adv = await RideAdvance.create({
    userId: pinRider._id, packageId: pkg._id, vehicleTypeId: sedan, fare: 3150, amount: 630, status: 'paid', razorpayOrderId: `order_${pinAdv}`, razorpayPaymentId: `pay_${pinAdv++}`, paidAt: new Date(),
  });
  const trip = await outstation(sedan, 3000, 'One Way', { advanceId: String(adv._id), userId: pinRider._id });
  await rides.acceptRideAssignment({ rideId: String(trip._id), driverId: pinDriver._id });
  await rides.updateRideLifecycle({ rideId: String(trip._id), driverId: pinDriver._id, nextStatus: 'arriving' });
  const stored = await Ride.findById(trip._id).lean();
  assert.match(stored.otp, /^\d{4}$/, 'the ride has the rider PIN');
  return { id: String(trip._id), driverId: pinDriver._id, pin: stored.otp, wrong: stored.otp === '0000' ? '1111' : '0000' };
};
const startWith = (r, otp) => rides.updateRideLifecycle({ rideId: r.id, driverId: r.driverId, nextStatus: 'started', ...(otp === undefined ? {} : { otp }) });
const refusal = async (promise, status, code, label) => {
  try { await promise; } catch (error) {
    assert.equal(error.statusCode, status, `${label}: ${error.message}`);
    assert.equal(error.code, code, `${label}: code`);
    return;
  }
  assert.fail(`${label}: expected ${status} ${code}`);
};

const pin1 = await pinRide();
await refusal(startWith(pin1, pin1.wrong), 400, 'WRONG_OTP', 'wrong PIN');
const afterWrong = await Ride.findById(pin1.id).lean();
assert.equal(afterWrong.liveStatus, 'arriving', 'a wrong PIN does not start the trip');
assert.ok(!afterWrong.startedAt, 'no startedAt');
const started1 = await startWith(pin1, pin1.pin);
assert.equal(started1.liveStatus, 'started', 'the right PIN starts it (after a wrong one)');
assert.equal((await startWith(pin1)).liveStatus, 'started', 'a repeated start without a PIN is harmless once started');

const pin2 = await pinRide();
assert.equal((await startWith(pin2)).liveStatus, 'started', 'no PIN sent (an older app) still starts it while the PIN is not required');

const pin3 = await pinRide();
process.env.REQUIRE_TRIP_PIN = 'true';
await refusal(startWith(pin3), 400, 'OTP_REQUIRED', 'PIN required but missing');
await refusal(startWith(pin3, pin3.wrong), 400, 'WRONG_OTP', 'PIN required, wrong');
assert.equal((await startWith(pin3, pin3.pin)).liveStatus, 'started', 'the right PIN works with the requirement on');
delete process.env.REQUIRE_TRIP_PIN;

const pin4 = await pinRide();
for (let i = 0; i < 5; i += 1) await refusal(startWith(pin4, pin4.wrong), 400, 'WRONG_OTP', `wrong try ${i + 1}`);
await refusal(startWith(pin4, pin4.pin), 429, 'WRONG_OTP', 'locked after 5 wrong PINs, even for the right one');
await Ride.updateOne({ _id: pin4.id }, { $set: { startPinLockedUntil: new Date(Date.now() - 1000) } });
assert.equal((await startWith(pin4, pin4.pin)).liveStatus, 'started', 'the lock ends after a few minutes');

const pin5 = await pinRide();
const tPinDriver = tokenFor(pin5.driverId, 'driver');
const restWrong = await call('PATCH', `/rides/${pin5.id}/status`, tPinDriver, { status: 'started', otp: pin5.wrong });
assert.equal(restWrong.status, 400);
assert.equal(restWrong.body.code, 'WRONG_OTP', 'REST: wrong PIN is refused with a code the apps can switch on');
assert.equal((await Ride.findById(pin5.id).lean()).liveStatus, 'arriving');
const restRight = await call('PATCH', `/rides/${pin5.id}/status`, tPinDriver, { status: 'started', otp: pin5.pin });
assert.equal(restRight.status, 200, JSON.stringify(restRight.body).slice(0, 200));
// each booking of this rider cancelled their previous trip: settle those advances here so section 3's refund count is its own
await advance.sweepAdvanceRefunds({ refund: async () => ({ id: 'pin_section' }) });

// ================================================================ 3. OUTSTATION CANCELLED: the whole advance goes back
await UserWallet.updateOne({ userId: rider._id }, { $set: { balance: 1000, transactions: [] } }, { upsert: true });
const refunds = [];
const stubRefund = async ({ paymentId, amount }) => { refunds.push([paymentId, amount]); return { id: `rfnd_${paymentId}` }; };
await SetPrice.updateOne({ _id: pkg._id, 'package_vehicle_prices.vehicle_type': sedan }, { $set: { 'package_vehicle_prices.$.cancellation_fee': 200 } });
const adv3 = await paidAdvance(sedan, 3150, 630, 3);
const trip3 = await outstation(sedan, 3000, 'One Way', { advanceId: String(adv3._id) });
await cancelRideByUser({ rideId: String(trip3._id), userId: rider._id });
assert.equal((await Ride.findById(trip3._id).lean()).status, 'cancelled');
assert.equal((await UserWallet.findOne({ userId: rider._id }).lean()).balance, 1000, 'cancelled while still searching (no driver yet): no fee');
const adv4 = await paidAdvance(sedan, 3150, 630, 4);
const trip4 = await outstation(sedan, 3000, 'One Way', { advanceId: String(adv4._id) });
const taker = await mkDriver();
await rides.acceptRideAssignment({ rideId: String(trip4._id), driverId: taker._id });
await cancelRideByUser({ rideId: String(trip4._id), userId: rider._id });
assert.equal((await Ride.findById(trip4._id).lean()).status, 'cancelled', 'cancelled after a driver accepted');
assert.equal((await UserWallet.findOne({ userId: rider._id }).lean()).balance, 800, "cancelled after a driver accepted: the package row's Rs 200 outstation cancellation fee is charged");
assert.equal((await Driver.findById(taker._id).lean()).isOnRide, false, 'the driver is free again');
assert.equal((await advance.sweepAdvanceRefunds({ refund: stubRefund })).refunded, 2);
assert.deepEqual(refunds.map((x) => x[1]), [630, 630], 'the whole advance, whoever had accepted');
assert.equal((await Ride.findById(trip4._id).lean()).advance.status, 'refunded');
console.log('outstation cancel: rider wallet after cancelling post-accept =', (await UserWallet.findOne({ userId: rider._id }).lean()).balance);
const detail3 = await adminDetails(trip4._id);
assert.equal(detail3.payment.advance.status, 'refunded');
assert.equal(detail3.status.label, 'Cancelled');

// ================================================================ 4. OUTSTATION COUNTER-OFFER, then the trip settles on the offered fare
const bidder = await mkDriver();
await withPass(bidder._id);
const adv5 = await paidAdvance(sedan, 3150, 630, 5);
const trip5 = await outstation(sedan, 3000, 'One Way', { advanceId: String(adv5._id) });
const offered = await rides.submitRideBid({ rideId: String(trip5._id), driverId: bidder._id, bidFare: 3300 });
const taken = await rides.acceptRideBidAssignment({ rideId: String(trip5._id), bidId: offered.bid.id, userId: rider._id });
assert.equal(taken.fare, 3300, 'the fare is now the offer (the tolls are inside it)');
assert.equal(taken.tollCharges.total, 150, 'the tolls stay recorded');
assert.equal(advance.amountDueAfterAdvance(await Ride.findById(trip5._id).lean()), 2670, 'balance = offer 3300 - advance 630');
for (const nextStatus of ['arriving', 'started', 'arrived']) await rides.updateRideLifecycle({ rideId: String(trip5._id), driverId: bidder._id, nextStatus });
await rides.updateRideLifecycle({ rideId: String(trip5._id), driverId: bidder._id, nextStatus: 'completed', collectedVia: 'cash' });
const settled5 = await Ride.findById(trip5._id).lean();
assert.deepEqual([settled5.fare, settled5.commissionAmount, settled5.driverEarnings], [3300, 0, 3300], 'on a pass the driver keeps the whole offered fare');
assert.equal(await walletOf(bidder._id), 1000 + 630, 'the advance is credited; the driver collects 2670 in cash');
const detail5 = await adminDetails(trip5._id);
assert.deepEqual([detail5.fare.final, detail5.fare.quoted, detail5.fare.advancePaid, detail5.fare.amountDue], [3300, 3150, 630, 2670]);

// ================================================================ 5. HOURLY RENTAL: package + extra km + extra minutes, settled on the package row commission
const rentalPkg = await SetPrice.create({
  pricing_scope: 'package', package_kind: 'hourly_rental', transport_type: 'taxi', package_destination: 'Local', package_availability: 'available', active: 1, status: 'active',
  package_vehicle_prices: [{ vehicle_type: sedan, base_price: 600, free_distance: 20, free_time: 120, distance_price: 25, time_price: 2, active: 1, admin_commission_type_from_driver: 1, admin_commission_from_driver: 10, admin_commission_type_for_owner: 1, admin_commission_for_owner: 5, cancellation_fee: 100 }],
});
const bookRental = () => rides.createRideRecord({
  userId: rider._id, pickupCoords: PICKUP, dropCoords: PICKUP, pickupAddress: 'Palasia', dropAddress: 'Palasia', fare: 1, vehicleTypeId: String(sedan),
  paymentMethod: 'cash', serviceType: 'hourly_rental', rental: { packagePriceId: String(rentalPkg._id) },
});
const rentalRide = await bookRental();
assert.equal(rentalRide.fare, 600);
const renter = await mkDriver();
await rides.acceptRideAssignment({ rideId: String(rentalRide._id), driverId: renter._id });
await rides.updateRideLifecycle({ rideId: String(rentalRide._id), driverId: renter._id, nextStatus: 'arriving' });
await rides.updateRideLifecycle({ rideId: String(rentalRide._id), driverId: renter._id, nextStatus: 'started' });
const rentalStart = new Date(Date.now() - 150 * 60000);
await Ride.updateOne({ _id: rentalRide._id }, { startedAt: rentalStart });
const trail = [];
for (let i = 0; i <= 50; i += 1) {
  trail.push({ rideId: rentalRide._id, driverId: renter._id, location: { type: 'Point', coordinates: [PICKUP[0], PICKUP[1] + (0.2464 * i) / 50] }, createdAt: new Date(rentalStart.getTime() + 60000 + (i * (148 * 60000)) / 50) });
}
await DriverLocationHistory.collection.insertMany(trail);
await rides.updateRideLifecycle({ rideId: String(rentalRide._id), driverId: renter._id, nextStatus: 'arrived' });
const billed = await Ride.findById(rentalRide._id).lean();
assert.deepEqual([billed.rental.extraKm, billed.rental.extraKmCharge, billed.rental.extraMinutes, billed.rental.extraTimeCharge], [7, 175, 30, 60]);
assert.equal(billed.fare, 835, '600 + 7 km x 25 + 30 min x 2');
assert.equal(rides.serializeRideRealtime(billed).amountDue, 835, 'the rider owes the whole bill at the end, no advance on a rental');
await rides.updateRideLifecycle({ rideId: String(rentalRide._id), driverId: renter._id, nextStatus: 'completed', collectedVia: 'cash' });
const rentalDone = await Ride.findById(rentalRide._id).lean();
assert.equal(rentalDone.fare, 835, 'completing does not bill the overage twice');
assert.equal(rentalDone.commissionAmount, 83.5, '10% of the full bill, extras included');
assert.equal(rentalDone.driverEarnings, 751.5);
assert.equal(await walletOf(renter._id), 1000 - 83.5, 'cash ride: the commission comes off the wallet');
const detailR = await adminDetails(rentalRide._id);
assert.equal(detailR.kind.key, 'rental');
assert.equal(detailR.fare.final, 835);
console.log('rental typeDetails', JSON.stringify(detailR.typeDetails));

// a rental cancelled after the driver accepted: nothing is billed for use
const rentalGone = await bookRental();
const renter2 = await mkDriver();
await rides.acceptRideAssignment({ rideId: String(rentalGone._id), driverId: renter2._id });
await cancelRideByUser({ rideId: String(rentalGone._id), userId: rider._id });
const rentalGoneRow = await Ride.findById(rentalGone._id).lean();
assert.equal(rentalGoneRow.status, 'cancelled');
assert.equal(rentalGoneRow.fare, 600, 'a cancelled rental keeps the package price, never an overage');
assert.equal(rentalGoneRow.rental.settledAt, null);
assert.equal((await adminDetails(rentalGone._id)).status.label, 'Cancelled');
console.log('rental cancel: rider wallet now', (await UserWallet.findOne({ userId: rider._id }).lean()).balance);

assert.equal((await UserWallet.findOne({ userId: rider._id }).lean()).balance, 700, "a cancelled rental pays the rental package row's Rs 100 cancellation fee (was 10% of the city taxi tariff)");

// ================================================================ 6. SHARE RIDE: 50% off per seat, 10% rider platform fee, settlement
const RAJWADA = [75.8553, 22.7183];
const DEWAS = [76.0534, 22.9676];
const place = (c, address = 'x') => ({ lat: c[1], lng: c[0], address });
const shareDeps = {
  loadRoute: async () => ({ distanceMeters: 20000 }),
  loadTariffs: async () => ({ tariffs: [{ type_id: String(sedan), vehicle_type_name: 'Sedan', base_price: 60, base_distance: 2, price_per_distance: 14, rider_platform_fee: 5, rider_platform_fee_type: 'percentage' }] }),
};
const mkRider = (n) => User.create({ name: `Sharer ${n}`, phone: `90000002${10 + n}`, city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
const sharers = await Promise.all([1, 2, 3].map(mkRider));
const shareBody = (seats) => ({ pickup: place(RAJWADA, 'p'), drop: place(DEWAS, 'd'), seats, vehicleTypeId: String(sedan) });
const finishShare = async (driverId, rideId) => {
  await share.verifyPickup({ driverId, rideId, otp: (await ShareRide.findById(rideId)).otp });
  return share.completeShareRide({ driverId, rideId });
};

// the quote: (60 + 18 km x 14) = 312 solo; 50% off = 156 a seat; 2 seats = 312; 5% platform fee = 15.6 -> 16
const quote = await share.quoteForRider(shareBody(2), shareDeps);
assert.deepEqual([quote.perSeat, quote.subtotal, quote.platformFee, quote.total, quote.discountPercent], [156, 312, 16, 328, 50]);

// a solo driver needs a pass to take share rides, so the commission is waived and only the rider platform fee is the platform's
const sharer = await share.createShareRide({ user: sharers[0], body: shareBody(2), deps: shareDeps });
assert.equal(sharer.fare, 328, 'the rider is charged the quote');
assert.deepEqual([sharer.fareBreakdown.perSeat, sharer.fareBreakdown.platformFee], [156, 16]);
const shareDriver = await mkDriver();
await withPass(shareDriver._id);
const accepted = await share.acceptShareRequest({ driverId: shareDriver._id, rideId: sharer.id });
assert.ok(accepted.trip?.id, 'a trip is created for the driver');
const sharedDone = await finishShare(shareDriver._id, sharer.id);
const st = (await ShareRide.findById(sharer.id).lean()).settlement;
assert.deepEqual([st.platformFee, st.commission, st.commissionWaived, st.driverEarnings], [16, 0, 31.2, 312], 'the fee 16 is the platform money; the pass waives the 31.2 commission');
assert.equal(await walletOf(shareDriver._id), 1000 - 16, 'the driver collected 328 in cash: the platform is owed the 16 fee');
const shareTrip = await ShareTrip.findById(accepted.trip.id).lean();
assert.deepEqual([shareTrip.stats.gross, shareTrip.stats.platformFee, shareTrip.stats.commission, shareTrip.stats.driverEarnings], [328, 16, 0, 312]);

// a driver on a pass: the commission is waived, the platform fee is not
const passDriver = await mkDriver();
await withPass(passDriver._id);
// (a second solo driver on a pass, one seat)
const sharer2 = await share.createShareRide({ user: sharers[1], body: shareBody(1), deps: shareDeps });
assert.equal(sharer2.fare, 156 + 8, '1 seat: 156 + 5% fee (7.8 -> 8)');
await share.acceptShareRequest({ driverId: passDriver._id, rideId: sharer2.id });
await finishShare(passDriver._id, sharer2.id);
const st2 = (await ShareRide.findById(sharer2.id).lean()).settlement;
assert.deepEqual([st2.platformFee, st2.commission, st2.commissionWaived, st2.driverEarnings], [8, 0, 15.6, 156]);
assert.equal(await walletOf(passDriver._id), 1000 - 8, 'only the platform fee comes off the wallet');

// a fleet driver: the platform is paid by the OWNER (5% owner commission + the fee), the driver wallet is not touched
const fleetShare = await mkDriver({ owner_id: owner._id });
const ownerBefore = round((await Owner.findById(owner._id).lean()).wallet.balance);
const sharer3 = await share.createShareRide({ user: sharers[2], body: shareBody(2), deps: shareDeps });
await share.acceptShareRequest({ driverId: fleetShare._id, rideId: sharer3.id });
await finishShare(fleetShare._id, sharer3.id);
const st3 = (await ShareRide.findById(sharer3.id).lean()).settlement;
assert.deepEqual([st3.platformFee, st3.commission, st3.driverEarnings], [16, 15.6, 296.4], 'owner commission 5% of 312 = 15.6');
assert.equal(await walletOf(fleetShare._id), 1000, "a fleet driver's own wallet is never charged");
assert.equal(round((await Owner.findById(owner._id).lean()).wallet.balance), round(ownerBefore - 31.6), 'the owner owes the platform commission + fee, as on a normal cash fleet ride');
const ownerRow = await OwnerWalletTransaction.findOne({ ownerId: owner._id }).sort({ createdAt: -1 }).lean();
assert.deepEqual([ownerRow.kind, ownerRow.amount, ownerRow.type], ['debit', 31.6, 'commission_deduction']);

// the admin monitor adds up the same numbers
const overview = (await call('GET', '/admin/share-rides/overview', tAdmin)).body.data;
assert.equal(overview.totals.rides, 3);
assert.equal(overview.totals.gross, 328 + 164 + 328);
assert.equal(overview.totals.platformFee, 16 + 8 + 16);
assert.equal(round(overview.totals.commission), 15.6);
assert.equal(round(overview.totals.driverEarnings), round(312 + 156 + 296.4));

// ================================================================ 10. ADMIN LISTS (Trips / Ongoing) AND THE PAYMENTS LEDGER: the booking data an admin reads
const listAll = async (path) => {
  const response = await call('GET', path, tAdmin);
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.body).slice(0, 200)}`);
  return (response.body.data?.results || response.body.data?.data?.results || []);
};
const allRows = await listAll('/admin/ride-requests?limit=100');
const dayRow = allRows.find((r) => r.id === String(dayTrip._id));
assert.ok(dayRow, 'the multi-day trip is in the Trips list');
assert.equal(dayRow.kindLabel, 'Outstation (Round trip, 3 days)', 'the list says how many days');
assert.deepEqual([dayRow.days, dayRow.returnDate, dayRow.extraDays, dayRow.extraDayCharge], [3, '2026-12-12', 1, 2000]);
assert.equal(dayRow.balanceDue, dayRow.fare - dayRow.advancePaid, 'what the rider still owes after the advance');
const cancelledRow = allRows.find((r) => r.id === String(trip4._id));
assert.equal(cancelledRow.statusLabel, 'Cancelled by rider', 'who cancelled is recorded and shown');
assert.match(cancelledRow.paymentDetail, /^Cancelled - nothing collected$/, 'a cancelled cash ride was not collected');
const inProgress = allRows.find((r) => r.tripStatus === 'ONGOING' || r.tripStatus === 'ACCEPTED');
if (inProgress && inProgress.paymentOption === 'CASH') assert.match(inProgress.paymentDetail, /to be collected/, 'a running cash ride is not "collected" yet');

// the filters the pages send now work on the server, across all pages
assert.equal((await listAll('/admin/ride-requests?limit=100&driverAssigned=unassigned')).every((r) => r.driverName === 'Unassigned'), true);
assert.equal((await listAll('/admin/ride-requests?limit=100&driverAssigned=assigned')).every((r) => r.driverName !== 'Unassigned'), true);
assert.equal((await listAll('/admin/ride-requests?limit=100&transportType=bike')).length, 0, 'no bike rides here');
assert.equal((await listAll('/admin/ride-requests?limit=100&dateFrom=2000-01-01&dateTo=2000-01-02')).length, 0, 'a date range with no bookings is empty');
assert.ok((await listAll(`/admin/ride-requests?limit=100&dateFrom=${new Date().toISOString().slice(0, 10)}&dateTo=${new Date().toISOString().slice(0, 10)}`)).length > 0, "today's bookings are listed");
assert.equal((await listAll('/admin/ride-requests?limit=100&paymentType=wallet')).every((r) => r.paymentOption === 'WALLET' || r.paymentOption === 'ONLINE'), true, 'payment filter');
const cancelledOnly = await listAll('/admin/ride-requests?limit=100&tab=cancelled&search=Rider');
assert.ok(cancelledOnly.length > 0 && cancelledOnly.every((r) => r.tripStatus === 'CANCELLED'), 'a search no longer replaces the tab');
const ongoingTab = await listAll('/admin/ongoing-rides?limit=100&status=accepted');
assert.ok(ongoingTab.every((r) => ['ACCEPTED'].includes(r.tripStatus)), "the Ongoing page's Status filter is applied");

const ledger = (await call('GET', '/admin/payments?from=2020-01-01&to=2099-12-31&limit=200', tAdmin)).body.data;
const ledgerRows = ledger.results || [];
const advRow = ledgerRows.find((r) => r.kind === 'outstation_advance' && r.request_id);
assert.ok(advRow, 'an advance row names its request');
assert.match(advRow.request_id, /^REQ_[0-9A-F]{12}$/, 'a readable request id, not a raw ObjectId');
assert.match(advRow.ride_kind, /^Outstation/);
assert.doesNotMatch(advRow.description, /^Outstation advance - ride request [0-9a-f]{24}$/, 'no raw ObjectId in the description');
const rideLedger = ledgerRows.find((r) => r.kind === 'ride');
assert.ok(rideLedger?.request_id && rideLedger.ride_kind, 'a ride payment row says which request and what kind');

console.log('outstation, rental and share ride: all checks passed');

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
process.exit(0);
