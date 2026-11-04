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
    { vehicle_type: sedan, base_price: 3000, free_distance: 200, distance_price: 12, advance_type: 'percentage', advance_value: 20, active: 1, admin_commission_type_from_driver: 1, admin_commission_from_driver: 10, admin_commission_type_for_owner: 1, admin_commission_for_owner: 5 },
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

// ================================================================ 3. OUTSTATION CANCELLED: the whole advance goes back
await UserWallet.updateOne({ userId: rider._id }, { $set: { balance: 1000, transactions: [] } }, { upsert: true });
const refunds = [];
const stubRefund = async ({ paymentId, amount }) => { refunds.push([paymentId, amount]); return { id: `rfnd_${paymentId}` }; };
const adv3 = await paidAdvance(sedan, 3150, 630, 3);
const trip3 = await outstation(sedan, 3000, 'One Way', { advanceId: String(adv3._id) });
await cancelRideByUser({ rideId: String(trip3._id), userId: rider._id });
assert.equal((await Ride.findById(trip3._id).lean()).status, 'cancelled');
const adv4 = await paidAdvance(sedan, 3150, 630, 4);
const trip4 = await outstation(sedan, 3000, 'One Way', { advanceId: String(adv4._id) });
const taker = await mkDriver();
await rides.acceptRideAssignment({ rideId: String(trip4._id), driverId: taker._id });
await cancelRideByUser({ rideId: String(trip4._id), userId: rider._id });
assert.equal((await Ride.findById(trip4._id).lean()).status, 'cancelled', 'cancelled after a driver accepted');
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
  package_vehicle_prices: [{ vehicle_type: sedan, base_price: 600, free_distance: 20, free_time: 120, distance_price: 25, time_price: 2, active: 1, admin_commission_type_from_driver: 1, admin_commission_from_driver: 10, admin_commission_type_for_owner: 1, admin_commission_for_owner: 5 }],
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

assert.equal((await UserWallet.findOne({ userId: rider._id }).lean()).balance, 940, "a cancelled rental pays the city tariff's rider cancellation fee (10% of Rs 600) - the package row's own cancellation_fee is not read (see report)");

// ================================================================ 6. SHARE RIDE: 30% off per seat, 10% rider platform fee, settlement
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

// the quote: (60 + 18 km x 14) = 312 solo; 30% off = 218.4 -> 218 a seat; 2 seats = 436; 5% platform fee = 21.8 -> 22
const quote = await share.quoteForRider(shareBody(2), shareDeps);
assert.deepEqual([quote.perSeat, quote.subtotal, quote.platformFee, quote.total, quote.discountPercent], [218, 436, 22, 458, 30]);

// a solo driver needs a pass to take share rides, so the commission is waived and only the rider platform fee is the platform's
const sharer = await share.createShareRide({ user: sharers[0], body: shareBody(2), deps: shareDeps });
assert.equal(sharer.fare, 458, 'the rider is charged the quote');
assert.deepEqual([sharer.fareBreakdown.perSeat, sharer.fareBreakdown.platformFee], [218, 22]);
const shareDriver = await mkDriver();
await withPass(shareDriver._id);
const accepted = await share.acceptShareRequest({ driverId: shareDriver._id, rideId: sharer.id });
assert.ok(accepted.trip?.id, 'a trip is created for the driver');
const sharedDone = await finishShare(shareDriver._id, sharer.id);
const st = (await ShareRide.findById(sharer.id).lean()).settlement;
assert.deepEqual([st.platformFee, st.commission, st.commissionWaived, st.driverEarnings], [22, 0, 43.6, 436], 'the fee 22 is the platform money; the pass waives the 43.6 commission');
assert.equal(await walletOf(shareDriver._id), 1000 - 22, 'the driver collected 458 in cash: the platform is owed the 22 fee');
const shareTrip = await ShareTrip.findById(accepted.trip.id).lean();
assert.deepEqual([shareTrip.stats.gross, shareTrip.stats.platformFee, shareTrip.stats.commission, shareTrip.stats.driverEarnings], [458, 22, 0, 436]);

// a driver on a pass: the commission is waived, the platform fee is not
const passDriver = await mkDriver();
await withPass(passDriver._id);
// (a second solo driver on a pass, one seat)
const sharer2 = await share.createShareRide({ user: sharers[1], body: shareBody(1), deps: shareDeps });
assert.equal(sharer2.fare, 218 + 11, '1 seat: 218 + 5% fee (10.9 -> 11)');
await share.acceptShareRequest({ driverId: passDriver._id, rideId: sharer2.id });
await finishShare(passDriver._id, sharer2.id);
const st2 = (await ShareRide.findById(sharer2.id).lean()).settlement;
assert.deepEqual([st2.platformFee, st2.commission, st2.commissionWaived, st2.driverEarnings], [11, 0, 21.8, 218]);
assert.equal(await walletOf(passDriver._id), 1000 - 11, 'only the platform fee comes off the wallet');

// a fleet driver: the platform is paid by the OWNER (5% owner commission + the fee), the driver wallet is not touched
const fleetShare = await mkDriver({ owner_id: owner._id });
const ownerBefore = round((await Owner.findById(owner._id).lean()).wallet.balance);
const sharer3 = await share.createShareRide({ user: sharers[2], body: shareBody(2), deps: shareDeps });
await share.acceptShareRequest({ driverId: fleetShare._id, rideId: sharer3.id });
await finishShare(fleetShare._id, sharer3.id);
const st3 = (await ShareRide.findById(sharer3.id).lean()).settlement;
assert.deepEqual([st3.platformFee, st3.commission, st3.driverEarnings], [22, 21.8, 414.2], 'owner commission 5% of 436 = 21.8');
assert.equal(await walletOf(fleetShare._id), 1000, "a fleet driver's own wallet is never charged");
assert.equal(round((await Owner.findById(owner._id).lean()).wallet.balance), round(ownerBefore - 43.8), 'the owner owes the platform commission + fee, as on a normal cash fleet ride');
const ownerRow = await OwnerWalletTransaction.findOne({ ownerId: owner._id }).sort({ createdAt: -1 }).lean();
assert.deepEqual([ownerRow.kind, ownerRow.amount, ownerRow.type], ['debit', 43.8, 'commission_deduction']);

// the admin monitor adds up the same numbers
const overview = (await call('GET', '/admin/share-rides/overview', tAdmin)).body.data;
assert.equal(overview.totals.rides, 3);
assert.equal(overview.totals.gross, 458 + 229 + 458);
assert.equal(overview.totals.platformFee, 22 + 11 + 22);
assert.equal(round(overview.totals.commission), 21.8);
assert.equal(round(overview.totals.driverEarnings), round(436 + 218 + 414.2));

console.log('outstation, rental and share ride: all checks passed');

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
process.exit(0);
