// Smoke test for Share Ride, against a THROWAWAY Mongo.
//   SHARE_RIDE_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testShareRide.mjs
// Drops its own database (share_ride_test) when done. Never point it at production.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.SHARE_RIDE_TEST_MONGODB_URI;
if (!uri) throw new Error('Set SHARE_RIDE_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB_NAME: 'share_ride_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test' });

const geo = await import('../src/modules/taxi/shareRide/services/shareRideGeo.js');
const { fareFromTariff, quoteShareFare, SHARE_DISCOUNT_PERCENT } = await import('../src/modules/taxi/shareRide/services/shareRideFare.js');
const svc = await import('../src/modules/taxi/shareRide/services/shareRideService.js');
const { shareRideRouter } = await import('../src/modules/taxi/shareRide/routes/shareRideRoutes.js');
const { ShareRide } = await import('../src/modules/taxi/shareRide/models/ShareRide.js');
const { ShareTrip } = await import('../src/modules/taxi/shareRide/models/ShareTrip.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { DriverSubscription } = await import('../src/modules/taxi/driver/models/DriverSubscription.js');
const { WalletTransaction } = await import('../src/modules/taxi/driver/models/WalletTransaction.js');
const { User } = await import('../src/modules/taxi/user/models/User.js');
const { Owner } = await import('../src/modules/taxi/admin/models/Owner.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { Ride } = await import('../src/modules/taxi/user/models/Ride.js');

// ---------------------------------------------------------------- geometry
const RAJWADA = [75.8553, 22.7183];
const VIJAY_NAGAR = [75.8937, 22.7533]; // on the way to Dewas
const DEWAS = [76.0534, 22.9676];
const AIRPORT = [75.8011, 22.7217]; // ~5.6 km behind Rajwada
const BHOPAL = [77.4126, 23.2599];
{
  const route = { origin: RAJWADA, destination: DEWAS };
  assert.ok(geo.corridorFit({ ...route, pickup: RAJWADA, drop: DEWAS }).fits, 'full route fits');
  assert.ok(geo.corridorFit({ ...route, pickup: VIJAY_NAGAR, drop: DEWAS }).fits, 'a rider joining on the way fits');
  assert.ok(!geo.corridorFit({ ...route, pickup: DEWAS, drop: RAJWADA }).fits, 'opposite direction does not fit');
  assert.ok(!geo.corridorFit({ ...route, pickup: AIRPORT, drop: DEWAS }).fits, 'pickup far behind the origin does not fit');
  assert.ok(!geo.corridorFit({ ...route, pickup: RAJWADA, drop: BHOPAL }).fits, 'a drop far past the destination does not fit');
  const km = geo.haversineKm(RAJWADA, DEWAS);
  assert.ok(km > 33 && km < 35, `Indore-Dewas is about 34 km, got ${km}`);
  const [sw, ne] = geo.routeBox({ origin: RAJWADA, destination: DEWAS });
  assert.ok(sw[0] < RAJWADA[0] && ne[0] > DEWAS[0] && sw[1] < RAJWADA[1] && ne[1] > DEWAS[1], 'box is wider than the route');
}

// -------------------------------------------------------------------- fare
{
  // base 50 for 2 km, then Rs 12/km: 20 km = 50 + 18 x 12 = 266 alone; 30% off = 186 a seat.
  const row = { base_price: 50, base_distance: 2, price_per_distance: 12, rider_platform_fee: 5, rider_platform_fee_type: 'percentage' };
  assert.equal(SHARE_DISCOUNT_PERCENT, 30);
  assert.deepEqual(fareFromTariff(row, 20, 2), { perSeat: 186, subtotal: 372, platformFee: 19, total: 391 });
  assert.deepEqual(fareFromTariff({ ...row, rider_platform_fee: 10, rider_platform_fee_type: 'fixed' }, 20, 2),
    { perSeat: 186, subtotal: 372, platformFee: 10, total: 382 }, 'a fixed fee is charged once per ride, not per seat');
  assert.deepEqual(fareFromTariff({ ...row, rider_platform_fee: 0 }, 1, 1), { perSeat: 35, subtotal: 35, platformFee: 0, total: 35 });
}

// -------------------------------------------------------------- settlement
{
  const config = { type: 1, value: 10 };
  const covered = svc.computeSettlement({ fare: 391, platformFee: 19, commissionConfig: config, covered: true });
  assert.deepEqual(covered, { platformFee: 19, commission: 0, commissionWaived: 37.2, takenFromDriver: 19, driverEarnings: 372 },
    'with a pass: commission waived, only the platform fee is taken');
  const uncovered = svc.computeSettlement({ fare: 391, platformFee: 19, commissionConfig: config, covered: false });
  assert.deepEqual(uncovered, { platformFee: 19, commission: 37.2, commissionWaived: 0, takenFromDriver: 56.2, driverEarnings: 334.8 },
    'without a pass: 10% commission on the fare after the platform fee');
  const zeroFee = svc.computeSettlement({ fare: 100, platformFee: 0, commissionConfig: { type: 1, value: 0 }, covered: true });
  assert.equal(zeroFee.takenFromDriver, 0);
  assert.equal(zeroFee.driverEarnings, 100);
  assert.equal(svc.computeSettlement({ fare: 50, platformFee: 80, commissionConfig: config, covered: false }).driverEarnings, 0, 'never negative');
}

// ----------------------------------------------------- admin is read-only
{
  const adminRoutes = shareRideRouter.stack.filter((layer) => layer.route?.path.startsWith('/admin/share-rides'));
  assert.equal(adminRoutes.length, 3);
  for (const layer of adminRoutes) assert.deepEqual(Object.keys(layer.route.methods), ['get'], `${layer.route.path} must be read-only`);
}

// ----------------------------------------------------------- integration
await mongoose.connect(uri, { dbName: 'share_ride_test' });
await mongoose.connection.dropDatabase();
await Promise.all([Driver.init(), ShareRide.init(), ShareTrip.init()]);

const failsWith = async (promise, status, label) => {
  try { await promise; } catch (error) { assert.equal(error.statusCode ?? error.status, status, `${label}: ${error.message}`); return error; }
  assert.fail(`${label}: expected ${status}`);
};
const oid = () => new mongoose.Types.ObjectId();

const carType = (await Vehicle.collection.insertOne({ name: 'Sedan', icon_types: 'car', capacity: 4, transport_type: 'taxi', active: true, status: 1 })).insertedId;
const cheapCar = (await Vehicle.collection.insertOne({ name: 'Mini', icon_types: 'car', capacity: 4, transport_type: 'taxi', active: true, status: 1 })).insertedId;
const bikeType = (await Vehicle.collection.insertOne({ name: 'Bike', icon_types: 'bike', capacity: 1, transport_type: 'taxi', active: true, status: 1 })).insertedId;
const deps = {
  loadRoute: async () => ({ distanceMeters: 20000 }),
  loadTariffs: async () => ({
    tariffs: [
      { type_id: String(carType), vehicle_type_name: 'Sedan', base_price: 60, base_distance: 2, price_per_distance: 14, rider_platform_fee: 5, rider_platform_fee_type: 'percentage' },
      { type_id: String(cheapCar), vehicle_type_name: 'Mini', base_price: 50, base_distance: 2, price_per_distance: 12, rider_platform_fee: 5, rider_platform_fee_type: 'percentage' },
      { type_id: String(bikeType), vehicle_type_name: 'Bike', base_price: 10, base_distance: 2, price_per_distance: 5, rider_platform_fee: 0, rider_platform_fee_type: 'fixed' },
    ],
  }),
};

// the quote uses the cheapest CAR tariff (never the cheaper bike)
const body = (pickup, drop, seats = 1) => ({ pickup: { lat: pickup[1], lng: pickup[0], address: 'p' }, drop: { lat: drop[1], lng: drop[0], address: 'd' }, seats });
const quoted = await quoteShareFare({ pickup: RAJWADA, drop: DEWAS, seats: 2 }, deps);
assert.equal(quoted.available, true);
assert.equal(quoted.total, 391);
assert.equal(quoted.tariffName, 'Mini');
assert.equal((await quoteShareFare({ pickup: RAJWADA, drop: [RAJWADA[0] + 0.001, RAJWADA[1]], seats: 1 }, deps)).available, false, 'too short');
assert.equal((await quoteShareFare({ pickup: RAJWADA, drop: DEWAS, seats: 1 }, { ...deps, loadTariffs: async () => ({ tariffs: [] }) })).available, false, 'no tariff here');

const mkUser = (n) => User.create({ name: `Rider ${n}`, phone: `90000000${10 + n}`, city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
const mkDriver = (n, extra = {}) => Driver.create({
  name: `Driver ${n}`, phone: `91000000${10 + n}`, password: 'x-test-pass', approve: true, status: 'approved', isOnline: true,
  vehicleType: 'car', vehicleTypeId: carType, vehicleTypeIds: [carType], vehicleMake: 'Maruti', vehicleModel: 'Dzire',
  vehicleNumber: `MH12AB10${n}${n}`, vehicleColor: 'white', location: { type: 'Point', coordinates: RAJWADA }, ...extra,
});
const addPass = (driverId, { startsAt = new Date(Date.now() - 3600e3) } = {}) => DriverSubscription.collection.insertOne({
  driverId, planId: oid(), planName: 'Day pass', amount: 50, vehicleClasses: ['car'], startsAt,
  expiresAt: new Date(Date.now() + 24 * 3600e3), status: 'active', paymentMethod: 'wallet', paidAt: new Date(), tripsCovered: 0, commissionWaived: 0,
});

const [u1, u2, u3, u4] = await Promise.all([1, 2, 3, 4].map(mkUser));
const d1 = await mkDriver(1);
const d2 = await mkDriver(2);
await addPass(d1._id);
await addPass(d2._id);

// ---- 1. a rider asks for a share ride
const rideA = await svc.createShareRide({ user: u1, body: body(RAJWADA, DEWAS, 2), deps });
assert.equal(rideA.status, 'searching');
assert.equal(rideA.fare, 391, 'fare is the server fare');
assert.match(rideA.otp, /^\d{4}$/);
await failsWith(svc.createShareRide({ user: u1, body: body(RAJWADA, DEWAS, 1), deps }), 409, 'one active share ride per rider');
await failsWith(svc.createShareRide({ user: u2, body: { pickup: { lat: 'x', lng: 1 }, drop: { lat: 1, lng: 1 } }, deps }), 400, 'bad location');
await failsWith(svc.createShareRide({ user: u2, body: body(RAJWADA, DEWAS, 9), deps }), 400, 'more than 4 seats');
// a request nobody took stops being offered, and the rider can ask again
await ShareRide.updateOne({ _id: rideA.id }, { expiresAt: new Date(Date.now() - 1000) });
assert.deepEqual(await svc.listRiderRides(u1._id, { status: 'active' }), [], 'stale request is expired when read');
assert.equal((await ShareRide.findById(rideA.id)).status, 'expired');
const rideA2 = await svc.createShareRide({ user: u1, body: body(RAJWADA, DEWAS, 2), deps });
const rideAId = rideA2.id;

// ---- 2. who can see it
const idle = await svc.listRequestsForDriver(d1._id);
assert.equal(idle.eligible, true);
assert.equal(idle.source, 'idle');
assert.equal(idle.requests.length, 1, 'an idle driver near the pickup sees it');
assert.ok(!('otp' in idle.requests[0]), 'the rider OTP is never shown to the driver');
const far = await mkDriver(3, { location: { type: 'Point', coordinates: BHOPAL } });
await addPass(far._id);
assert.equal((await svc.listRequestsForDriver(far._id)).requests.length, 0, 'a driver far away sees nothing');
const noPass = await mkDriver(4);
const blocked = await svc.listRequestsForDriver(noPass._id);
assert.equal(blocked.eligible, false);
assert.match(blocked.reason, /pass/i);
const bike = await mkDriver(5, { vehicleType: 'bike' });
assert.equal((await svc.listRequestsForDriver(bike._id)).eligible, false, 'bike drivers cannot take share rides');
await failsWith(svc.acceptShareRequest({ driverId: noPass._id, rideId: rideAId }), 403, 'no pass');

// ---- 3. two drivers race for one request: exactly one wins, no seat is leaked
const race = await Promise.allSettled([
  svc.acceptShareRequest({ driverId: d1._id, rideId: rideAId }),
  svc.acceptShareRequest({ driverId: d2._id, rideId: rideAId }),
]);
assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1, 'only one driver gets the request');
const winner = race.find((r) => r.status === 'fulfilled').value;
const winnerId = winner.trip.driverId;
const loserId = String(winnerId) === String(d1._id) ? d2._id : d1._id;
const acceptedA = await ShareRide.findById(rideAId);
assert.equal(acceptedA.status, 'accepted');
assert.equal(String(acceptedA.driverId), String(winnerId));
assert.equal(acceptedA.driverSnapshot.name.startsWith('Driver'), true);
const winnerTrip = await ShareTrip.findOne({ driverId: winnerId, status: 'open' });
assert.equal(winnerTrip.seatsTotal, 3, 'capacity 4 minus the driver');
assert.equal(winnerTrip.seatsTaken, 2);
const loserTrips = await ShareTrip.find({ driverId: loserId });
assert.ok(loserTrips.every((t) => t.seatsTaken === 0), 'the loser holds no seat');
await ShareTrip.deleteMany({ driverId: loserId }); // the loser's empty trip is irrelevant below

const winnerDriver = String(winnerId) === String(d1._id) ? d1 : d2;
const driverId = winnerDriver._id;

// ---- 4. a second rider on the way joins the same trip; off-route and overfull are refused
const rideB = await svc.createShareRide({ user: u2, body: body(VIJAY_NAGAR, DEWAS, 2), deps });
const forB = await svc.listRequestsForDriver(driverId);
assert.equal(forB.source, 'trip');
assert.equal(forB.seatsFree, 1);
assert.equal(forB.requests.length, 0, 'two seats do not fit one free seat');
await failsWith(svc.acceptShareRequest({ driverId, rideId: rideB.id }), 409, 'not enough free seats');
await svc.cancelByRider({ userId: u2._id, rideId: rideB.id });
const rideC = await svc.createShareRide({ user: u2, body: body(VIJAY_NAGAR, DEWAS, 1), deps });
const forC = await svc.listRequestsForDriver(driverId);
assert.equal(forC.requests.length, 1, 'a one-seat rider on the way fits');
assert.ok(forC.requests[0].fit.fits);
await svc.acceptShareRequest({ driverId, rideId: rideC.id });
assert.equal((await ShareTrip.findById(winnerTrip._id)).seatsTaken, 3);
const rideD = await svc.createShareRide({ user: u3, body: body(AIRPORT, DEWAS, 1), deps });
assert.equal((await svc.listRequestsForDriver(driverId)).requests.length, 0, 'an off-route rider is not listed');
await failsWith(svc.acceptShareRequest({ driverId, rideId: rideD.id }), 409, 'off-route accept');
await svc.cancelByRider({ userId: u3._id, rideId: rideD.id });
const rideE = await svc.createShareRide({ user: u3, body: body(DEWAS, RAJWADA, 1), deps });
await failsWith(svc.acceptShareRequest({ driverId, rideId: rideE.id }), 409, 'opposite direction');
await svc.cancelByRider({ userId: u3._id, rideId: rideE.id });

// ---- 5. cancel gives the seat back; release hands the rider back with a fresh OTP and hides it from that driver
await svc.cancelByRider({ userId: u2._id, rideId: rideC.id });
assert.equal((await ShareTrip.findById(winnerTrip._id)).seatsTaken, 2, 'rider cancel frees the seat');
const rideF = await svc.createShareRide({ user: u4, body: body(VIJAY_NAGAR, DEWAS, 1), deps });
await svc.acceptShareRequest({ driverId, rideId: rideF.id });
const otpBefore = (await ShareRide.findById(rideF.id)).otp;
await svc.releaseRider({ driverId, rideId: rideF.id });
const released = await ShareRide.findById(rideF.id);
assert.equal(released.status, 'searching');
assert.equal(released.tripId, null);
assert.notEqual(released.otp, otpBefore, 'a new OTP after a handback');
assert.equal((await ShareTrip.findById(winnerTrip._id)).seatsTaken, 2);
assert.equal((await svc.listRequestsForDriver(driverId)).requests.length, 0, 'the driver who handed it back no longer sees it');
await svc.cancelByRider({ userId: u4._id, rideId: rideF.id });

// ---- 6. pickup needs the rider OTP; five wrong tries lock it
const wrongOtp = acceptedA.otp === '1111' ? '2222' : '1111';
for (let i = 1; i <= 4; i += 1) await failsWith(svc.verifyPickup({ driverId, rideId: rideAId, otp: wrongOtp }), 400, `wrong otp #${i}`);
await failsWith(svc.verifyPickup({ driverId, rideId: rideAId, otp: wrongOtp }), 429, 'fifth wrong OTP locks it');
await failsWith(svc.verifyPickup({ driverId, rideId: rideAId, otp: acceptedA.otp }), 429, 'even the right OTP is refused once locked');
await ShareRide.updateOne({ _id: rideAId }, { otpAttempts: 0 }); // the support route would reset this; here we just continue
await failsWith(svc.completeShareRide({ driverId, rideId: rideAId }), 409, 'cannot complete before pickup');
const picked = await svc.verifyPickup({ driverId, rideId: rideAId, otp: acceptedA.otp });
assert.equal(picked.status, 'ongoing');
assert.equal((await ShareTrip.findById(winnerTrip._id)).status, 'running');
await failsWith(svc.completeTrip({ driverId, tripId: winnerTrip._id }), 409, 'a rider is still on board');

// ---- 7. completing settles once: fare 391, platform fee 19 is the platform's, pass waives the commission
const before = (await Driver.findById(driverId)).wallet.balance;
const done = await svc.completeShareRide({ driverId, rideId: rideAId, collectedVia: 'upi' });
assert.equal(done.ride.status, 'completed');
assert.equal(done.ride.collectedVia, 'upi');
assert.equal(done.settlement.platformFee, 19);
assert.equal(done.settlement.commission, 0, 'the pass waives the commission');
assert.ok(done.settlement.commissionWaived > 0, 'and records what was waived');
assert.equal(done.settlement.driverEarnings, 372, 'driver keeps fare minus the platform fee');
const settled = await ShareRide.findById(rideAId);
assert.equal(settled.settlement.walletStatus, 'settled');
assert.equal((await Driver.findById(driverId)).wallet.balance, before - 19, 'only the platform fee comes off the wallet');
const txns = await WalletTransaction.find({ driverId, type: 'commission_deduction' }).lean();
assert.equal(txns.length, 1);
assert.equal(txns[0].amount, -19);
assert.equal(String(txns[0].metadata.shareRideId), rideAId);
const pass = await DriverSubscription.findOne({ driverId }).lean();
assert.equal(pass.tripsCovered, 1);
assert.ok(pass.commissionWaived > 0);
assert.equal((await ShareTrip.findById(winnerTrip._id)).seatsTaken, 0, 'the seats are free again');
assert.deepEqual(
  (({ ridersCompleted, gross, platformFee, driverEarnings }) => ({ ridersCompleted, gross, platformFee, driverEarnings }))((await ShareTrip.findById(winnerTrip._id)).stats),
  { ridersCompleted: 1, gross: 391, platformFee: 19, driverEarnings: 372 },
);
// completing again changes nothing
await failsWith(svc.completeShareRide({ driverId, rideId: rideAId }), 409, 'second complete');
assert.equal((await Driver.findById(driverId)).wallet.balance, before - 19, 'no double debit');
assert.equal(await WalletTransaction.countDocuments({ driverId, type: 'commission_deduction' }), 1);

// ---- 8. close the trip; earnings
await svc.completeTrip({ driverId, tripId: winnerTrip._id });
assert.equal(await svc.getDriverTrip(driverId), null);
const earn = await svc.getDriverShareEarnings(driverId);
assert.equal(earn.rides, 1);
assert.equal(earn.gross, 391);
assert.equal(earn.driverEarnings, 372);
assert.equal(earn.platformFee, 19);
assert.equal(earn.recent.length, 1);

// ---- 9. without a covering pass (it starts tomorrow) the commission applies
const d6 = await mkDriver(6);
await addPass(d6._id, { startsAt: new Date(Date.now() + 24 * 3600e3 - 1000) });
const rideG = await svc.createShareRide({ user: u1, body: body(RAJWADA, DEWAS, 1), deps });
await svc.acceptShareRequest({ driverId: d6._id, rideId: rideG.id });
await svc.verifyPickup({ driverId: d6._id, rideId: rideG.id, otp: (await ShareRide.findById(rideG.id)).otp });
const doneG = await svc.completeShareRide({ driverId: d6._id, rideId: rideG.id });
assert.ok(doneG.settlement.commission > 0, 'no covering pass: a trip commission is charged');
assert.equal(doneG.settlement.commissionWaived, 0);
assert.equal(Math.round((doneG.settlement.driverEarnings + doneG.settlement.platformFee + doneG.settlement.commission) * 100) / 100, doneG.ride.fare, 'fare = earnings + fee + commission');
await svc.completeTrip({ driverId: d6._id, tripId: (await ShareTrip.findOne({ driverId: d6._id }))._id });

// ---- 10. a driver on a normal ride adds a rider along its route
const d7 = await mkDriver(7);
await addPass(d7._id);
await Ride.collection.insertOne({
  driverId: d7._id, status: 'accepted', pickupLocation: { type: 'Point', coordinates: RAJWADA }, dropLocation: { type: 'Point', coordinates: DEWAS },
  pickupAddress: 'Rajwada', dropAddress: 'Dewas',
});
const rideH = await svc.createShareRide({ user: u2, body: body(VIJAY_NAGAR, DEWAS, 1), deps });
const onRide = await svc.listRequestsForDriver(d7._id);
assert.equal(onRide.source, 'ride');
assert.equal(onRide.requests.length, 1, 'a driver on a normal ride sees requests along that ride');
const addH = await svc.acceptShareRequest({ driverId: d7._id, rideId: rideH.id });
const tripH = await ShareTrip.findById(addH.trip.id);
assert.equal(String(tripH.baseRideId) !== 'null' && tripH.baseRideId !== null, true, 'the trip rides along with the normal ride');
assert.equal(tripH.seatsTotal, 2, 'capacity 4 minus the driver minus the rider already on board');
assert.equal((await Driver.findById(d7._id)).isOnRide, false, 'dispatch and isOnRide are left alone');
await svc.cancelByRider({ userId: u2._id, rideId: rideH.id });
await svc.cancelTrip({ driverId: d7._id, tripId: tripH._id });

// ---- 11. owner: fleet driver, create a trip for them, switch them off, see earnings
const owner = await Owner.create({ name: 'Owner', company_name: 'Fleet Co', mobile: '9200000001', email: 'o@example.com', password: 'x-test-pass' });
const fleet = await mkDriver(8, { owner_id: owner._id });
await addPass(fleet._id);
const outsider = await mkDriver(9);
await failsWith(svc.ownerCreateTrip({ ownerId: owner._id, driverId: outsider._id, origin: { lat: 22.7, lng: 75.8 }, destination: { lat: 22.9, lng: 76 } }), 404, 'not my driver');
const ownerTrip = await svc.ownerCreateTrip({
  ownerId: owner._id, driverId: fleet._id,
  origin: { lat: RAJWADA[1], lng: RAJWADA[0], address: 'Indore' }, destination: { lat: DEWAS[1], lng: DEWAS[0], address: 'Dewas' }, seatsTotal: 2,
});
assert.equal(ownerTrip.createdBy, 'owner');
assert.equal(ownerTrip.seatsTotal, 2);
await failsWith(svc.ownerCreateTrip({ ownerId: owner._id, driverId: fleet._id, origin: { lat: 22.7, lng: 75.8 }, destination: { lat: 22.9, lng: 76 } }), 409, 'one active trip per driver');
const rideI = await svc.createShareRide({ user: u4, body: body(RAJWADA, DEWAS, 1), deps });
const forFleet = await svc.listRequestsForDriver(fleet._id);
assert.equal(forFleet.source, 'trip');
assert.equal(forFleet.requests.length, 1, 'the fleet driver sees requests on the owner-created trip');
await svc.acceptShareRequest({ driverId: fleet._id, rideId: rideI.id });
await svc.verifyPickup({ driverId: fleet._id, rideId: rideI.id, otp: (await ShareRide.findById(rideI.id)).otp });
await svc.completeShareRide({ driverId: fleet._id, rideId: rideI.id });
const over = await svc.ownerOverview(owner._id);
assert.equal(over.totals.rides, 1);
assert.equal(over.totals.ownerEarnings, over.totals.driverEarnings);
assert.equal(over.drivers.length, 1);
assert.equal(over.drivers[0].rides, 1);
assert.equal(over.drivers[0].shareEnabled, true);
assert.equal((await svc.ownerRides(owner._id)).results.length, 1);
assert.equal((await svc.ownerTrips(owner._id, { status: 'active' })).length, 1);
await svc.completeTrip({ driverId: fleet._id, tripId: ownerTrip.id });
await svc.ownerSetDriverEnabled({ ownerId: owner._id, driverId: fleet._id, enabled: false });
const off = await svc.listRequestsForDriver(fleet._id);
assert.equal(off.eligible, false);
assert.match(off.reason, /owner/i);
await failsWith(svc.ownerSetDriverEnabled({ ownerId: owner._id, driverId: outsider._id, enabled: false }), 404, 'cannot switch another fleet');
await svc.ownerSetDriverEnabled({ ownerId: owner._id, driverId: fleet._id, enabled: true });
assert.equal((await svc.listRequestsForDriver(fleet._id)).eligible, true);

// ---- 12. admin sees everything and can change nothing
const admin = await svc.adminOverview();
assert.equal(admin.totals.rides, 3, 'three completed rides in all');
assert.equal(admin.walletPending, 0, 'nothing stuck');
assert.ok(admin.totals.platformFee > 0);
const adminRides = await svc.adminRides({ status: 'completed' });
assert.equal(adminRides.results.length, 3);
assert.equal(adminRides.paginator.total, 3);
assert.equal((await svc.adminRides({ search: 'Rider 1' })).results.every((r) => r.passenger.name === 'Rider 1'), true);
assert.ok((await svc.adminTrips({})).results.length >= 3);

await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('share ride: all checks passed');
process.exit(0);
