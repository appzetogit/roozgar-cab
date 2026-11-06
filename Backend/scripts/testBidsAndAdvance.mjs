// Driver counter-offers and the outstation advance, against a THROWAWAY, STANDALONE Mongo (like production).
//   BIDS_ADVANCE_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testBidsAndAdvance.mjs
// Drops its own database (bids_advance_test) when done. Never point it at production.
//
// Covers: the counter range maths, a driver countering a ride offer (limits, steps, who may), the rider's offers list,
// the rider raising the fare (stale offers expire), the rider accepting an offer (fare becomes the offer), a driver
// taking the ride at the quoted fare (offers close); the outstation advance (rule per price row, amount, fallback by
// destination, required before booking, claimed once, mismatch), settlement with an advance (solo driver on a pass,
// on commission, fleet owner), the rider paying the balance, and full refunds (cancel, retry, unused payment).
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.BIDS_ADVANCE_TEST_MONGODB_URI;
if (!uri) throw new Error('Set BIDS_ADVANCE_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB_NAME: 'bids_advance_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test' });

const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) =>
  String(url).startsWith('http://127.0.0.1') ? realFetch(url, ...rest) : Promise.reject(new Error('offline in test'));

const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/modules/taxi/services/tokenService.js');
const rides = await import('../src/modules/taxi/services/rideService.js');
const policy = await import('../src/modules/taxi/services/biddingPolicyService.js');
const advance = await import('../src/modules/taxi/services/rideAdvanceService.js');
const wallet = await import('../src/modules/taxi/driver/services/walletService.js');
const { installStandaloneTransactionShim } = await import('../src/config/database.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { DriverSubscription } = await import('../src/modules/taxi/driver/models/DriverSubscription.js');
const { WalletTransaction } = await import('../src/modules/taxi/driver/models/WalletTransaction.js');
const { User } = await import('../src/modules/taxi/user/models/User.js');
const { UserWallet } = await import('../src/modules/taxi/user/models/UserWallet.js');
const { Admin } = await import('../src/modules/taxi/admin/models/Admin.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { SetPrice } = await import('../src/modules/taxi/admin/models/SetPrice.js');
const { Owner } = await import('../src/modules/taxi/admin/models/Owner.js');
const { OwnerSubscription } = await import('../src/modules/taxi/admin/models/OwnerSubscription.js');
const { OwnerWalletTransaction } = await import('../src/modules/taxi/admin/models/OwnerWalletTransaction.js');
const { Ride } = await import('../src/modules/taxi/user/models/Ride.js');
const { RideBid } = await import('../src/modules/taxi/user/models/RideBid.js');
const { RideAdvance } = await import('../src/modules/taxi/user/models/RideAdvance.js');

await mongoose.connect(uri, { dbName: 'bids_advance_test' });
await mongoose.connection.dropDatabase();
await installStandaloneTransactionShim();
await Promise.all([Driver.init(), Ride.init(), RideBid.init(), RideAdvance.init()]);

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
const failsWith = async (promise, status, code, label) => {
  try { await promise; } catch (error) {
    assert.equal(error.statusCode ?? error.status, status, `${label}: ${error.message}`);
    if (code) assert.equal(error.code, code, `${label}: code`);
    return error;
  }
  assert.fail(`${label}: expected ${status}`);
};
const oid = () => new mongoose.Types.ObjectId();
const round = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- the range maths (pure)
{
  const r = policy.resolveDriverCounterRange({ fare: 1000, maxPercentage: 20, stepAmount: 10 });
  assert.equal(r.available, true);
  assert.equal(r.minFare, 1010);
  assert.equal(r.maxFare, 1200);
  assert.equal(r.options.length, 20);
  assert.deepEqual(policy.resolveDriverCounterRange({ fare: 1000, maxPercentage: 20, stepAmount: 50 }).options, [1050, 1100, 1150, 1200]);
  assert.equal(policy.resolveDriverCounterRange({ fare: 1000, maxPercentage: 15, stepAmount: 100 }).options.length, 1, '15% of 1000 = 150: one step of 100');
  assert.equal(policy.resolveDriverCounterRange({ fare: 40, maxPercentage: 20, stepAmount: 10 }).available, false, 'a fare too small for even one step');
  assert.equal(policy.resolveDriverCounterRange({ fare: 1000, maxPercentage: 0, stepAmount: 10 }).available, false, '0% = no counter');
  const off = await policy.resolveBiddingPolicy({ vehicle: { dispatch_type: 'normal' }, serviceType: 'ride', bidSettings: { bidding_enabled: '1', bidding_services: 'city', bidding_all_vehicles: '1', driver_counter_enabled: '0' }, transportSettings: {} });
  assert.equal(off.allowed, true);
  assert.equal(off.driverCounter.allowed, false, 'the admin can switch counter-offers off');
  const on = await policy.resolveBiddingPolicy({ vehicle: { dispatch_type: 'normal' }, serviceType: 'ride', bidSettings: { bidding_enabled: '1', bidding_services: 'city', bidding_all_vehicles: '1', bidding_high_percentage: '25', bidding_amount_increase_or_decrease: '20' }, transportSettings: {} });
  assert.deepEqual(on.driverCounter, { allowed: true, maxPercentage: 25, stepAmount: 20 }, 'limits come from the admin settings');
  const noService = await policy.resolveBiddingPolicy({ vehicle: { dispatch_type: 'normal' }, serviceType: 'ride', bidSettings: { bidding_enabled: '1', bidding_services: 'outstation', bidding_all_vehicles: '1' }, transportSettings: {} });
  assert.equal(noService.driverCounter.allowed, false, 'follows the services the admin enabled');
  assert.equal(advance.computeAdvanceAmount({ type: 'percentage', value: 20, fare: 3000 }), 600);
  assert.equal(advance.computeAdvanceAmount({ type: 'fixed', value: 500, fare: 3000 }), 500);
  assert.equal(advance.computeAdvanceAmount({ type: 'fixed', value: 5000, fare: 3000 }), 3000, 'never more than the fare');
  assert.equal(advance.computeAdvanceAmount({ type: 'percentage', value: 150, fare: 3000 }), 3000);
  assert.equal(advance.computeAdvanceAmount({ type: 'percentage', value: 0, fare: 3000 }), 0, '0 = no advance');
  assert.equal(advance.computeAdvanceAmount({ type: 'percentage', value: 33.3, fare: 1001 }), 333);
}

// ---------------------------------------------------------------- people and vehicles
const sedan = (await Vehicle.collection.insertOne({ name: 'Sedan', icon_types: 'car', category: 'car', capacity: 4, transport_type: 'taxi', is_taxi: 'taxi', active: true, status: 1, is_accept_share_ride: 0, dispatch_type: 'normal' })).insertedId;
const PICKUP = [75.8577, 22.7196]; // Indore
const DROP = [77.4126, 23.2599]; // Bhopal
const rider = await User.create({ name: 'Rider', phone: '9000000041', city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
const rider2 = await User.create({ name: 'Rider Two', phone: '9000000042', city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
await Admin.collection.insertOne({ name: 'Super', email: 'super@example.com', password: 'x', createdAt: new Date() });
const tRider = tokenFor(rider._id, 'user');
let phoneN = 50;
const mkDriver = (extra = {}) => Driver.create({
  name: `Driver ${phoneN}`, phone: `91000000${phoneN++}`, password: 'x-test-pass', approve: true, status: 'approved', isOnline: true, isOnRide: false,
  vehicleType: 'car', vehicleTypeId: sedan, vehicleTypeIds: [sedan], vehicleNumber: `MH12BA${phoneN}`, vehicleColor: 'white',
  location: { type: 'Point', coordinates: PICKUP }, ...extra,
});
const withPass = (driverId) => DriverSubscription.collection.insertOne({
  driverId, planId: oid(), planName: 'Day', amount: 50, vehicleClasses: ['car'], startsAt: new Date(Date.now() - 3600e3),
  expiresAt: new Date(Date.now() + 24 * 3600e3), status: 'active', paymentMethod: 'wallet', paidAt: new Date(), tripsCovered: 0, commissionWaived: 0,
});
const cityRide = (fare = 1000, extra = {}) => rides.createRideRecord({
  userId: rider._id, pickupCoords: PICKUP, dropCoords: [PICKUP[0] + 0.05, PICKUP[1]], pickupAddress: 'A', dropAddress: 'B', fare,
  vehicleTypeId: String(sedan), paymentMethod: 'cash', serviceType: 'ride', estimatedDistanceMeters: 5000, ...extra,
});

// ================================================================ 1. DRIVER COUNTER-OFFERS
const d1 = await mkDriver();
const d2 = await mkDriver();
const d3 = await mkDriver({ isOnline: false });
await withPass(d1._id); await withPass(d2._id); await withPass(d3._id);
const noPass = await mkDriver();

const r1 = await cityRide(1000);
assert.equal(r1.driverCounter.enabled, true, 'counter-offers are on by default');
assert.deepEqual([r1.driverCounter.maxPercentage, r1.driverCounter.stepAmount], [20, 10]);
const offer = rides.serializeDriverCounterOffer(r1);
assert.deepEqual([offer.enabled, offer.minFare, offer.maxFare, offer.options.length], [true, 1010, 1200, 20], 'what the offer card shows');
assert.equal((await Ride.findById(r1._id).lean()).fare, 1000);

const rid = String(r1._id);
await failsWith(rides.submitRideBid({ rideId: rid, driverId: d1._id, bidFare: 1000 }), 400, 'COUNTER_TOO_LOW', 'not above the fare');
await failsWith(rides.submitRideBid({ rideId: rid, driverId: d1._id, bidFare: 900 }), 400, 'COUNTER_TOO_LOW', 'below the fare');
await failsWith(rides.submitRideBid({ rideId: rid, driverId: d1._id, bidFare: 1300 }), 400, 'COUNTER_TOO_HIGH', 'above the admin limit');
await failsWith(rides.submitRideBid({ rideId: rid, driverId: d1._id, bidFare: 1015 }), 400, 'COUNTER_STEP', 'not a whole step');
await failsWith(rides.submitRideBid({ rideId: rid, driverId: d1._id, bidFare: 'abc' }), 400, 'COUNTER_TOO_LOW', 'not a number');
await failsWith(rides.submitRideBid({ rideId: rid, driverId: d3._id, bidFare: 1050 }), 409, null, 'an offline driver');
await failsWith(rides.submitRideBid({ rideId: rid, driverId: noPass._id, bidFare: 1050 }), 403, null, 'a solo driver without a pass could not honour it');
const bid1 = await rides.submitRideBid({ rideId: rid, driverId: d1._id, bidFare: 1050 });
assert.deepEqual([bid1.bid.bidFare, bid1.bid.incrementAmount, bid1.bid.kind, bid1.bid.status], [1050, 50, 'counter', 'pending']);
const bid2 = await rides.submitRideBid({ rideId: rid, driverId: d2._id, bidFare: 1100 });
const revised = await rides.submitRideBid({ rideId: rid, driverId: d1._id, bidFare: 1120 });
assert.equal(await RideBid.countDocuments({ rideId: rid }), 2, 'a driver has one offer per ride; a new price replaces it');
assert.equal(revised.bid.bidFare, 1120);

// the rider sees the offers, cheapest first
const listed = await rides.listRideBidsForUser({ rideId: rid, userId: rider._id });
assert.deepEqual(listed.bids.map((b) => b.bidFare), [1100, 1120]);
assert.equal(listed.ride.driverCounter.enabled, true);
const viaHttp = await call('GET', `/rides/${rid}/bids`, tRider);
assert.equal(viaHttp.status, 200);
assert.equal(viaHttp.body.data.bids.length, 2);
assert.equal(viaHttp.body.data.bids[0].kind, 'counter');
assert.equal((await call('GET', `/rides/${rid}/bids`, tokenFor(rider2._id, 'user'))).status, 404, 'only the rider sees the offers');

// the same call over HTTP for a driver (a killed app, Flutter)
const viaDriverHttp = await call('POST', `/drivers/ride-offers/${rid}/bid`, tokenFor(d2._id, 'driver'), { bidFare: 1080 });
assert.equal(viaDriverHttp.status, 200, JSON.stringify(viaDriverHttp.body));
assert.equal(viaDriverHttp.body.data.bid.bidFare, 1080);
const badHttp = await call('POST', `/drivers/ride-offers/${rid}/bid`, tokenFor(d2._id, 'driver'), { bidFare: 5 });
assert.equal(badHttp.status, 400);
assert.equal(badHttp.body.code, 'COUNTER_TOO_LOW');
assert.equal((await call('POST', `/drivers/ride-offers/${rid}/bid`, undefined, { bidFare: 1100 })).status, 401);

// the rider adds Rs 100 to the fare: offers at or below the new fare are no longer offers
const raised = await rides.increaseRideBidCeiling({ rideId: rid, userId: rider._id, incrementSteps: 10 });
assert.equal(raised.fare, 1100);
const afterRaise = await RideBid.find({ rideId: rid }).sort({ bidFare: 1 }).lean();
assert.deepEqual(afterRaise.map((b) => [b.bidFare, b.status]), [[1080, 'expired'], [1120, 'pending']]);
const range2 = rides.serializeDriverCounterOffer(await Ride.findById(rid));
assert.equal(range2.minFare, 1110, 'the range moves up with the fare');
assert.equal(range2.maxFare, 1320);

// the rider accepts the remaining offer: that driver gets the ride at the offered price
const accepted = await rides.acceptRideBidAssignment({ rideId: rid, bidId: String(afterRaise[1]._id), userId: rider._id });
assert.equal(String(accepted.driverId), String(d1._id));
assert.equal(accepted.fare, 1120, 'the fare is now the offer');
assert.equal(accepted.status, 'accepted');
assert.equal((await RideBid.findById(afterRaise[1]._id).lean()).status, 'accepted');
assert.equal((await Driver.findById(d1._id).lean()).isOnRide, true);
assert.equal(accepted.baseFare, 1000, 'the quoted fare is kept for the record');
// settlement uses the final fare
await Ride.updateOne({ _id: rid }, { $set: { status: 'completed', liveStatus: 'completed', completedAt: new Date(), 'pricingSnapshot.admin_commission_type_from_driver': 1, 'pricingSnapshot.admin_commission_from_driver': 10, 'pricingSnapshot.admin_commission_type_for_owner': 1, 'pricingSnapshot.admin_commission_for_owner': 10 } });
await Driver.updateOne({ _id: d1._id }, { $set: { isOnRide: false } });
await wallet.settleCompletedRideWallet({ rideId: rid });
const settled1 = await Ride.findById(rid).lean();
assert.equal(settled1.fare, 1120);
assert.equal(settled1.driverEarnings, 1120, 'on a pass the driver keeps the whole counter-offer fare');

// a stale offer cannot be accepted
const r2 = await cityRide(1000);
const stale = await rides.submitRideBid({ rideId: String(r2._id), driverId: d2._id, bidFare: 1030 });
await Ride.updateOne({ _id: r2._id }, { $set: { fare: 1100 } }); // the fare went up some other way
await failsWith(rides.acceptRideBidAssignment({ rideId: String(r2._id), bidId: stale.bid.id, userId: rider._id }), 409, 'COUNTER_STALE', 'an offer not above the fare');
assert.equal((await RideBid.findById(stale.bid.id).lean()).status, 'expired');

// another driver takes the ride at the quoted fare: the offers are over
const r3 = await cityRide(1000);
await rides.submitRideBid({ rideId: String(r3._id), driverId: d2._id, bidFare: 1060 });
await rides.acceptRideAssignment({ rideId: String(r3._id), driverId: d1._id });
assert.equal((await RideBid.findOne({ rideId: r3._id }).lean()).status, 'expired', 'the offers close when someone takes the ride');
await failsWith(rides.submitRideBid({ rideId: String(r3._id), driverId: d2._id, bidFare: 1070 }), 409, null, 'bidding on a taken ride');
await Driver.updateOne({ _id: d1._id }, { $set: { isOnRide: false } });

// a rental is never negotiated (its price is the package's); a fare too small has no range
const tiny = await cityRide(30);
assert.equal(rides.serializeDriverCounterOffer(tiny).enabled, false, 'a Rs 30 fare cannot take a Rs 10 step within 20%');
await failsWith(rides.submitRideBid({ rideId: String(tiny._id), driverId: d1._id, bidFare: 40 }), 409, 'COUNTER_NOT_AVAILABLE', 'no room to counter');

// ================================================================ 2. OUTSTATION ADVANCE
const pkg = await SetPrice.create({
  pricing_scope: 'package', package_kind: 'intercity', transport_type: 'taxi', package_destination: 'Bhopal', package_availability: 'available', active: 1, status: 'active',
  package_vehicle_prices: [{ vehicle_type: sedan, base_price: 3000, free_distance: 200, distance_price: 12, advance_type: 'percentage', advance_value: 20, active: 1 }],
});
const packageId = String(pkg._id);
const outstation = (fare, extra = {}, intercity = {}) => rides.createRideRecord({
  userId: rider._id, pickupCoords: PICKUP, dropCoords: DROP, pickupAddress: 'Indore', dropAddress: 'Bhopal', fare,
  vehicleTypeId: String(sedan), paymentMethod: 'cash', serviceType: 'intercity', estimatedDistanceMeters: 190000,
  intercity: { fromCity: 'Indore', toCity: 'Bhopal', tripType: 'One Way', packageId, ...intercity }, ...extra,
});

const q = await advance.quoteAdvance({ packageId, vehicleTypeId: String(sedan), fare: 3000 });
assert.deepEqual([q.required, q.amount, q.remaining, q.type, q.value], [true, 600, 2400, 'percentage', 20]);
assert.equal((await advance.quoteAdvance({ packageId: 'not-an-id', vehicleTypeId: String(sedan), toCity: 'bhopal', fare: 3000 })).amount, 600, 'without a package id it is found by the destination');
assert.equal((await advance.quoteAdvance({ vehicleTypeId: String(sedan), toCity: 'Nowhere', fare: 3000 })).required, false, 'no rule found: no advance');
await SetPrice.updateOne({ _id: pkg._id }, { $set: { 'package_vehicle_prices.0.advance_type': 'fixed', 'package_vehicle_prices.0.advance_value': 500 } });
assert.equal((await advance.quoteAdvance({ packageId, vehicleTypeId: String(sedan), fare: 3000 })).amount, 500);
await SetPrice.updateOne({ _id: pkg._id }, { $set: { 'package_vehicle_prices.0.advance_type': 'percentage', 'package_vehicle_prices.0.advance_value': 20 } });

// the quote over HTTP (the rider app)
const quoteHttp = await call('POST', '/rides/outstation/advance/quote', tRider, {
  pickup: PICKUP, drop: DROP, vehicleTypeId: String(sedan), fare: 3000, intercity: { packageId, toCity: 'Bhopal', tripType: 'One Way' },
});
assert.equal(quoteHttp.status, 200, JSON.stringify(quoteHttp.body));
assert.deepEqual([quoteHttp.body.data.required, quoteHttp.body.data.amount, quoteHttp.body.data.remaining], [true, 600, 2400]);
assert.equal((await call('POST', '/rides/outstation/advance/quote', undefined, {})).status, 401);
assert.equal((await call('POST', '/rides/outstation/advance/verify', tRider, {})).status, 400, 'verify needs the payment fields');
assert.equal((await call('POST', '/rides/outstation/advance/order', tRider, { pickup: PICKUP, drop: DROP, vehicleTypeId: String(sedan), fare: 3000, intercity: { packageId, toCity: 'Nowhere' }, service_location_id: String(oid()) })).status >= 400, true);

// the catalog shows each vehicle's advance
const catalog = await call('GET', '/users/intercity-packages');
assert.equal(catalog.status, 200);
const catRow = catalog.body.results.find((x) => x.id === packageId).vehicles[0];
assert.deepEqual([catRow.advanceType, catRow.advanceValue], ['percentage', 20]);

// a booking cannot be made without the advance, whichever way it tries
const missing = await failsWith(outstation(3000), 402, 'ADVANCE_REQUIRED', 'no advance paid');
assert.equal(missing.details.amount, 600);
await failsWith(outstation(3000, {}, { packageId: '' }), 402, 'ADVANCE_REQUIRED', 'leaving the package id out does not skip it');
await failsWith(outstation(3000, { advanceId: String(oid()) }), 402, 'ADVANCE_REQUIRED', 'an advance that does not exist');
assert.equal(await Ride.countDocuments({ serviceType: 'intercity' }), 0, 'nothing was booked');

// the payment: created -> paid (Razorpay confirmed it), once
const rec = await advance.createAdvanceRecord({ userId: rider._id, quote: q, vehicleTypeId: sedan });
assert.equal(rec.status, 'created');
await RideAdvance.updateOne({ _id: rec._id }, { $set: { razorpayOrderId: 'order_1' } });
await failsWith(outstation(3000, { advanceId: String(rec._id) }), 402, 'ADVANCE_REQUIRED', 'not paid yet');
await failsWith(advance.markAdvancePaid({ advanceId: rec._id, userId: rider2._id, orderId: 'order_1', paymentId: 'pay_1' }), 404, 'ADVANCE_NOT_FOUND', "someone else's payment");
await failsWith(advance.markAdvancePaid({ advanceId: rec._id, userId: rider._id, orderId: 'order_other', paymentId: 'pay_1' }), 404, 'ADVANCE_NOT_FOUND', 'another order');
const paid = await advance.markAdvancePaid({ advanceId: rec._id, userId: rider._id, orderId: 'order_1', paymentId: 'pay_1' });
assert.equal(paid.status, 'paid');
assert.equal((await advance.markAdvancePaid({ advanceId: rec._id, userId: rider._id, orderId: 'order_1', paymentId: 'pay_1' })).status, 'paid', 'verifying twice is fine');

// the amount is the server's: an advance for a different fare is not accepted
const tooLittle = await failsWith(outstation(4000, { advanceId: String(rec._id) }), 402, 'ADVANCE_MISMATCH', 'the fare changed');
assert.equal(tooLittle.details.amount, 800);
assert.equal((await RideAdvance.findById(rec._id).lean()).status, 'paid', 'a refused booking keeps the payment usable');

// the booking with the paid advance
const trip = await outstation(3000, { advanceId: String(rec._id) });
assert.deepEqual([trip.advance.amount, trip.advance.status, trip.fare], [600, 'applied', 3000]);
assert.equal(trip.intercity.packageId, packageId, 'the package the fare came from is kept');
const used = await RideAdvance.findById(rec._id).lean();
assert.deepEqual([used.status, String(used.rideId)], ['used', String(trip._id)]);
await failsWith(outstation(3000, { advanceId: String(rec._id) }), 402, 'ADVANCE_ALREADY_USED', 'one payment, one booking');
const realtime = rides.serializeRideRealtime(trip);
assert.deepEqual([realtime.advancePaid, realtime.amountDue, realtime.advance.amount], [600, 2400, 600]);
assert.equal(rides.serializeDriverCounterOffer(trip).enabled, true, 'an outstation ride can be countered too');
const driverView = await Ride.findById(trip._id).lean();
assert.equal(advance.amountDueAfterAdvance(driverView), 2400);

// ---- the rider's balance after the ride, and what the driver is credited
const solo = await mkDriver();
await withPass(solo._id);
await Ride.updateOne({ _id: trip._id }, { $set: { driverId: solo._id, status: 'completed', liveStatus: 'completed', completedAt: new Date(), paymentMethod: 'cash', 'pricingSnapshot.admin_commission_type_from_driver': 1, 'pricingSnapshot.admin_commission_from_driver': 10 } });
// the ride ends: settlement first (cash-like), exactly as in the app; the advance, on a pass: commission waived
await wallet.settleCompletedRideWallet({ rideId: String(trip._id) });
assert.equal(round((await Driver.findById(solo._id).lean()).wallet.balance), 600, 'the advance is credited at once; the driver collects the other 2400');
await UserWallet.updateOne({ userId: rider._id }, { $set: { balance: 5000, transactions: [] } }, { upsert: true });
const payBalance = await call('POST', `/rides/${trip._id}/complete-payment/wallet`, tRider, { rating: 5, tipAmount: 0 });
assert.equal(payBalance.status, 201, JSON.stringify(payBalance.body));
assert.equal((await UserWallet.findOne({ userId: rider._id }).lean()).balance, 2600, 'the rider pays only the balance (3000 - 600 advance)');
assert.equal(round((await Driver.findById(solo._id).lean()).wallet.balance), 3000, 'balance + advance = the whole fare, nothing deducted on a pass');
const soloRows = await WalletTransaction.find({ driverId: solo._id }).sort({ createdAt: 1 }).lean();
assert.deepEqual(soloRows.map((x) => [x.type, x.amount]), [['ride_earning', 600], ['adjustment', 2400]]);
assert.equal(soloRows[0].metadata.advancePaid, 600);
assert.notEqual((await call('POST', `/rides/${trip._id}/complete-payment/wallet`, tRider, { rating: 5, tipAmount: 0 })).status, 201, 'the balance cannot be paid twice');

// ---- cash balance, driver on commission (no pass): advance - commission
const tripCash = await (async () => {
  await UserWallet.updateOne({ userId: rider._id }, { $set: { balance: 5000 } });
  const adv = await RideAdvance.create({ userId: rider._id, packageId: pkg._id, vehicleTypeId: sedan, fare: 3000, amount: 600, status: 'paid', razorpayOrderId: 'order_2', razorpayPaymentId: 'pay_2', paidAt: new Date() });
  return outstation(3000, { advanceId: String(adv._id) });
})();
const commissioned = await mkDriver();
await Ride.updateOne({ _id: tripCash._id }, { $set: { driverId: commissioned._id, status: 'completed', liveStatus: 'completed', completedAt: new Date(), paymentMethod: 'cash', 'pricingSnapshot.admin_commission_type_from_driver': 1, 'pricingSnapshot.admin_commission_from_driver': 10 } });
await wallet.settleCompletedRideWallet({ rideId: String(tripCash._id) });
const cashRide = await Ride.findById(tripCash._id).lean();
assert.equal(cashRide.commissionAmount, 300, '10% of 3000');
assert.equal(cashRide.driverEarnings, 2700);
assert.equal(round((await Driver.findById(commissioned._id).lean()).wallet.balance), 300, 'advance 600 - commission 300 = +300; the driver collects the other 2400 in cash');
// commission bigger than the advance: the wallet pays the difference
const tripBig = await (async () => {
  const adv = await RideAdvance.create({ userId: rider._id, packageId: pkg._id, vehicleTypeId: sedan, fare: 3000, amount: 600, status: 'paid', razorpayOrderId: 'order_3', razorpayPaymentId: 'pay_3', paidAt: new Date() });
  return outstation(3000, { advanceId: String(adv._id) });
})();
const bigCommission = await mkDriver();
await Ride.updateOne({ _id: tripBig._id }, { $set: { driverId: bigCommission._id, status: 'completed', liveStatus: 'completed', completedAt: new Date(), paymentMethod: 'cash', 'pricingSnapshot.admin_commission_type_from_driver': 1, 'pricingSnapshot.admin_commission_from_driver': 30 } });
await wallet.settleCompletedRideWallet({ rideId: String(tripBig._id) });
assert.equal(round((await Driver.findById(bigCommission._id).lean()).wallet.balance), -300, '30% = 900 commission, 600 advance held: the driver owes 300');
assert.equal((await WalletTransaction.findOne({ driverId: bigCommission._id }).lean()).type, 'commission_deduction');
// a counter-offer on top of an advance: the balance follows the new fare
await Ride.updateOne({ _id: tripBig._id }, { $set: { fare: 3200 } });
assert.equal(advance.amountDueAfterAdvance(await Ride.findById(tripBig._id).lean()), 2600, 'fare 3200 - advance 600');

// ---- a fleet owner: the advance goes to the owner wallet
const owner = await Owner.create({ name: 'Owner', company_name: 'Fleet', mobile: '9200000077', email: 'o@example.com', password: 'x-test-pass', approve: true, status: 'approved', billing: { mode: 'commission' }, wallet: { balance: 0 } });
const fleet = await mkDriver({ owner_id: owner._id });
const tripFleet = await (async () => {
  const adv = await RideAdvance.create({ userId: rider._id, packageId: pkg._id, vehicleTypeId: sedan, fare: 3000, amount: 600, status: 'paid', razorpayOrderId: 'order_4', razorpayPaymentId: 'pay_4', paidAt: new Date() });
  return outstation(3000, { advanceId: String(adv._id) });
})();
await Ride.updateOne({ _id: tripFleet._id }, { $set: { driverId: fleet._id, status: 'completed', liveStatus: 'completed', completedAt: new Date(), paymentMethod: 'cash', 'pricingSnapshot.admin_commission_type_for_owner': 1, 'pricingSnapshot.admin_commission_for_owner': 10 } });
await wallet.settleCompletedRideWallet({ rideId: String(tripFleet._id) });
assert.equal(round((await Owner.findById(owner._id).lean()).wallet.balance), 300, 'owner: advance 600 - 10% commission 300');
const fleetRow = await OwnerWalletTransaction.findOne({ ownerId: owner._id }).lean();
assert.deepEqual([fleetRow.type, fleetRow.kind, fleetRow.amount], ['ride_earning', 'credit', 300]);
assert.equal((await Driver.findById(fleet._id).lean()).wallet?.balance || 0, 0, 'the fleet driver wallet is not touched');

// ================================================================ 3. REFUNDS (always in full)
const refunds = [];
const stubRefund = async ({ paymentId, amount }) => { refunds.push([paymentId, amount]); return { id: `rfnd_${paymentId}` }; };
const mkTrip = async (n) => {
  const adv = await RideAdvance.create({ userId: rider._id, packageId: pkg._id, vehicleTypeId: sedan, fare: 3000, amount: 600, status: 'paid', razorpayOrderId: `order_r${n}`, razorpayPaymentId: `pay_r${n}`, paidAt: new Date() });
  return outstation(3000, { advanceId: String(adv._id) });
};
const cancelled = await mkTrip(1);
await Ride.updateOne({ _id: cancelled._id }, { $set: { status: 'cancelled', liveStatus: 'cancelled' } });
const done = await advance.refundRideAdvance(cancelled._id, { refund: stubRefund });
assert.equal(done.refunded, true);
assert.deepEqual(refunds.at(-1), ['pay_r1', 600], 'the whole advance, to the original payment');
const afterRefund = await RideAdvance.findOne({ rideId: cancelled._id }).lean();
assert.deepEqual([afterRefund.status, afterRefund.refundId], ['refunded', 'rfnd_pay_r1']);
assert.equal((await Ride.findById(cancelled._id).lean()).advance.status, 'refunded');
const callsSoFar = refunds.length;
assert.equal(await advance.refundRideAdvance(cancelled._id, { refund: stubRefund }), null, 'refunding twice does nothing');
assert.equal(refunds.length, callsSoFar);

// the gateway fails: it is kept as refund_failed and the sweep retries it
const gatewayDown = await mkTrip(2);
await Ride.updateOne({ _id: gatewayDown._id }, { $set: { status: 'cancelled', liveStatus: 'cancelled' } });
const failed = await advance.refundRideAdvance(gatewayDown._id, { refund: async () => { throw new Error('gateway down'); } });
assert.equal(failed.refunded, false);
const failedDoc = await RideAdvance.findOne({ rideId: gatewayDown._id }).lean();
assert.deepEqual([failedDoc.status, failedDoc.refundError, failedDoc.refundAttempts], ['refund_failed', 'gateway down', 1]);
assert.equal((await Ride.findById(gatewayDown._id).lean()).advance.status, 'refund_failed');

// a ride that completed is never refunded; a cancelled one is found by the sweep whoever cancelled it
const stays = await mkTrip(3);
await Ride.updateOne({ _id: stays._id }, { $set: { status: 'completed', liveStatus: 'completed' } });
const sweptCancel = await mkTrip(4);
await Ride.updateOne({ _id: sweptCancel._id }, { $set: { status: 'cancelled', liveStatus: 'cancelled' } });
const open = await mkTrip(5); // still searching: not touched
// a payment never used for a booking is returned after a while
const orphan = await RideAdvance.create({ userId: rider._id, packageId: pkg._id, vehicleTypeId: sedan, fare: 3000, amount: 600, status: 'paid', razorpayOrderId: 'order_o', razorpayPaymentId: 'pay_o', paidAt: new Date(Date.now() - 31 * 60e3) });
const fresh = await RideAdvance.create({ userId: rider._id, packageId: pkg._id, vehicleTypeId: sedan, fare: 3000, amount: 600, status: 'paid', razorpayOrderId: 'order_f', razorpayPaymentId: 'pay_f', paidAt: new Date() });
refunds.length = 0;
const swept = await advance.sweepAdvanceRefunds({ refund: stubRefund });
assert.equal(swept.refunded, 3, 'the retried failure, the cancelled ride, the unused payment');
assert.deepEqual(refunds.map((x) => x[0]).sort(), ['pay_o', 'pay_r2', 'pay_r4']);
assert.equal((await RideAdvance.findOne({ rideId: gatewayDown._id }).lean()).status, 'refunded', 'the failed refund went through on retry');
assert.equal((await RideAdvance.findOne({ rideId: stays._id }).lean()).status, 'used', 'a completed ride keeps its advance');
assert.equal((await RideAdvance.findOne({ rideId: open._id }).lean()).status, 'used', 'a running ride keeps it too');
assert.equal((await RideAdvance.findById(fresh._id).lean()).status, 'paid', 'a payment made a moment ago is not refunded yet (the booking may be on its way)');
assert.equal((await RideAdvance.findById(orphan._id).lean()).status, 'refunded');
assert.equal((await advance.sweepAdvanceRefunds({ refund: stubRefund })).refunded, 0, 'the sweep is idempotent');

// "no such payment" from the gateway on a retry: already refunded counts as done
const twice = await mkTrip(6);
await Ride.updateOne({ _id: twice._id }, { $set: { status: 'cancelled', liveStatus: 'cancelled' } });
assert.equal((await advance.refundRideAdvance(twice._id, { refund: async () => ({ id: 'already_refunded' }) })).refunded, true);

// ================================================================ 4. NOTHING ELSE CHANGED
const plain = await cityRide(500);
assert.deepEqual([plain.advance.status, plain.advance.amount], ['none', 0], 'a city ride has no advance');
assert.equal(rides.serializeRideRealtime(plain).advance, null);
assert.equal(rides.serializeRideRealtime(plain).amountDue, 500);
const cityCash = await mkDriver();
await Ride.updateOne({ _id: plain._id }, { $set: { driverId: cityCash._id, status: 'completed', liveStatus: 'completed', completedAt: new Date(), paymentMethod: 'cash', 'pricingSnapshot.admin_commission_type_from_driver': 1, 'pricingSnapshot.admin_commission_from_driver': 10 } });
await wallet.settleCompletedRideWallet({ rideId: String(plain._id) });
assert.equal((await Driver.findById(cityCash._id).lean()).wallet.balance, -50, 'a normal cash ride is settled exactly as before: -commission');
// an outstation row with no advance books as before
await SetPrice.updateOne({ _id: pkg._id }, { $set: { 'package_vehicle_prices.0.advance_value': 0 } });
const noAdvance = await outstation(3000);
assert.deepEqual([noAdvance.advance.status, noAdvance.advance.amount], ['none', 0], 'advance 0 = booked without one');

// ================================================================ 5. THE ADMIN SEES EACH REQUEST CLEARLY AND IN FULL
const tAdmin = tokenFor((await Admin.collection.findOne({ email: 'super@example.com' }))._id, 'admin');
const full = await call('GET', `/admin/rides/${trip._id}/details`, tAdmin);
assert.equal(full.status, 200, JSON.stringify(full.body).slice(0, 300));
const d = full.body.data;
assert.deepEqual([d.kind.key, d.kind.label], ['outstation', 'Outstation (One way)'], 'the kind is said in words');
assert.match(d.requestId, /^REQ_[0-9A-F]{12}$/);
assert.equal(d.user.name, 'Rider');
assert.equal(d.driver.name, solo.name);
assert.equal(d.route.pickup.address, 'Indore');
assert.equal(d.typeDetails.toCity, 'Bhopal');
assert.deepEqual([d.fare.final, d.fare.advancePaid, d.fare.amountDue], [3000, 600, 2400], 'fare, advance and what was left');
assert.equal(d.payment.advance.status, 'used');
assert.equal(d.payment.advance.paymentId, 'pay_1');
assert.equal(d.settlement.settled, true);
assert.deepEqual(d.settlement.driverWallet.map((t) => t.type), ['ride_earning', 'adjustment'], 'the wallet rows that came from this ride');
assert.ok(d.timeline.some((e) => e.label === 'Advance paid online'), 'the history has the advance');
assert.ok(d.timeline.some((e) => e.label === 'Settled to wallet'));
const order = d.timeline.map((e) => e.label);
assert.ok(order.indexOf('Advance paid online') < order.indexOf('Request created'), 'the advance is paid before the request exists');
assert.ok(order.indexOf('Request created') < order.indexOf('Settled to wallet'), 'in time order');
assert.equal(d.snapshots.pricing.driverCommission.value, 10, 'the commission as it was at the time');
assert.equal(JSON.stringify(d).includes('"otp"'), false, 'no OTP in the admin payload');
// a request that was negotiated
const nego = (await call('GET', `/admin/rides/${rid}/details`, tAdmin)).body.data;
assert.equal(nego.kind.key, 'city');
assert.equal(nego.negotiation.driverCounter.enabled, true);
assert.equal(nego.negotiation.offers.length, 2, 'every driver offer is listed');
assert.deepEqual(nego.negotiation.offers.map((o) => o.kind), ['counter', 'counter']);
assert.ok(nego.timeline.some((e) => e.label === 'Counter-offer'));
assert.equal(nego.fare.quoted, 1000, 'the quoted fare is kept next to the final one');
assert.equal(nego.fare.final, 1120);
// a cancelled request with a refunded advance
const gone = (await call('GET', `/admin/rides/${cancelled._id}/details`, tAdmin)).body.data;
assert.equal(gone.status.label, 'Cancelled');
assert.equal(gone.payment.advance.status, 'refunded');
assert.ok(gone.timeline.some((e) => e.label === 'Advance refunded'));
assert.equal((await call('GET', `/admin/rides/${oid()}/details`, tAdmin)).status, 404);
assert.equal((await call('GET', `/admin/rides/${trip._id}/details`)).status, 401);
// the lists say what each request is, and Trip Requests now include outstation
const all = (await call('GET', '/admin/ride-requests?limit=50', tAdmin)).body.data;
const rowsAll = all.results || all.data || [];
assert.ok(rowsAll.some((r) => r.kind === 'outstation'), 'outstation requests are in Trip Requests');
assert.ok(rowsAll.some((r) => r.kind === 'city'));
const onlyOut = (await call('GET', '/admin/ride-requests?kind=outstation&limit=50', tAdmin)).body.data;
assert.ok((onlyOut.results || []).length > 0 && (onlyOut.results || []).every((r) => r.kind === 'outstation'), 'the kind chip filters');
const tripRow = (onlyOut.results || []).find((r) => r.id === String(trip._id));
assert.deepEqual([tripRow.kindLabel, tripRow.advancePaid, tripRow.vehicleName], ['Outstation (One way)', 600, 'Sedan']);
assert.ok(!(await call('GET', '/admin/ride-requests?kind=city&limit=50', tAdmin)).body.data.results.some((r) => r.kind === 'outstation'));

// ================================================================ 6. THE OWNER DASHBOARD SHOWS REAL NUMBERS
const dash = (await call('GET', '/admin/owner-management/dashboard', tAdmin)).body.data;
assert.deepEqual([dash.owners.total, dash.owners.approved, dash.owners.pending], [1, 1, 0]);
assert.deepEqual([dash.billing.onCommission, dash.billing.onPlan, dash.billing.stopped], [1, 0, 0], 'how the owner pays the platform');
assert.deepEqual([dash.drivers.total, dash.drivers.approved, dash.drivers.pending], [1, 1, 0], 'only fleet drivers (the others work on their own)');
assert.equal(dash.today.rides.completed, 1);
assert.deepEqual([dash.today.earnings, dash.today.cash, dash.today.online, dash.today.wallet], [3000, 3000, 0, 0]);
assert.deepEqual([dash.today.commission, dash.today.driverEarnings], [300, 2700], 'what the platform kept and what the fleet earned');
assert.equal(dash.overall.earnings, 3000);
assert.equal(dash.monthly.length, 6, 'six months, every month present');
assert.deepEqual([dash.monthly.at(-1).earnings, dash.monthly.at(-1).rides, dash.monthly[0].earnings], [3000, 1, 0]);
assert.deepEqual([dash.topOwners[0].name, dash.topOwners[0].drivers, dash.topOwners[0].rides, dash.topOwners[0].earnings, dash.topOwners[0].mode, dash.topOwners[0].serviceActive], ['Fleet', 1, 1, 3000, 'commission', true]);
assert.equal(dash.today_earnings, 3000, 'the older field names still work');
assert.equal((await call('GET', '/admin/owner-management/dashboard')).status, 401);

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('bids and advance: all checks passed');
process.exit(0);
