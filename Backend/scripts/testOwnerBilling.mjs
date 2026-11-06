// Owner billing (plan or commission for a fleet owner and their drivers) against a THROWAWAY, STANDALONE Mongo
// (like production: no transactions).
//   OWNER_BILLING_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testOwnerBilling.mjs
// Drops its own database (owner_billing_test) when done. Never point it at production.
//
// Covers: owner plans (admin HTTP), buying a plan from the wallet over HTTP, fleet drivers
// working with no pass of their own, dispatch/accept gates when the plan ends, the expiry
// sweep, switching to commission, ride settlement for fleet and solo drivers (cash and
// online), idempotency, admin grant / mode / payments / earnings.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.OWNER_BILLING_TEST_MONGODB_URI;
if (!uri) throw new Error('Set OWNER_BILLING_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB_NAME: 'owner_billing_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test' });

const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) =>
  String(url).startsWith('http://127.0.0.1') ? realFetch(url, ...rest) : Promise.reject(new Error('offline in test'));

const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/modules/taxi/services/tokenService.js');
const rides = await import('../src/modules/taxi/services/rideService.js');
const { matchDrivers } = await import('../src/modules/taxi/services/matchingService.js');
const wallet = await import('../src/modules/taxi/driver/services/walletService.js');
const billing = await import('../src/modules/taxi/driver/services/ownerBillingService.js');
const { sweepExpiredOwnerSubscriptions } = await import('../src/modules/taxi/driver/services/ownerSubscriptionExpiryService.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { DriverSubscription } = await import('../src/modules/taxi/driver/models/DriverSubscription.js');
const { WalletTransaction } = await import('../src/modules/taxi/driver/models/WalletTransaction.js');
const { User } = await import('../src/modules/taxi/user/models/User.js');
const { Admin } = await import('../src/modules/taxi/admin/models/Admin.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { Owner } = await import('../src/modules/taxi/admin/models/Owner.js');
const { OwnerSubscription } = await import('../src/modules/taxi/admin/models/OwnerSubscription.js');
const { OwnerWalletTransaction } = await import('../src/modules/taxi/admin/models/OwnerWalletTransaction.js');
const { Ride } = await import('../src/modules/taxi/user/models/Ride.js');

await mongoose.connect(uri, { dbName: 'owner_billing_test' });
await mongoose.connection.dropDatabase();
await Promise.all([Driver.init(), Ride.init(), OwnerSubscription.init()]);

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
const failsWith = async (promise, status, label) => {
  try { await promise; } catch (error) {
    assert.equal(error.statusCode ?? error.status, status, `${label}: ${error.message}`);
    return error;
  }
  assert.fail(`${label}: expected ${status}`);
};
const failsWithMessage = async (promise, pattern) => {
  try { await promise; } catch (error) { assert.match(error.message, pattern); return; }
  assert.fail('expected a failure');
};
const round = (n) => Math.round(n * 100) / 100;

const sedan = (await Vehicle.collection.insertOne({ name: 'Sedan', icon_types: 'car', capacity: 4, transport_type: 'taxi', active: true, status: 1 })).insertedId;
const PICKUP = [75.8577, 22.7196];
await Admin.collection.insertOne({ name: 'Super', email: 'super@example.com', password: 'x', createdAt: new Date() });
const tAdmin = tokenFor((await Admin.collection.findOne({ email: 'super@example.com' }))._id, 'admin');
const rider = await User.create({ name: 'Rider', phone: '9000000031', city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });

// A legacy owner: no `billing` field at all, as every owner in production today.
const insertOwner = async (n, extra = {}) => (await Owner.collection.insertOne({
  name: `Owner ${n}`, owner_name: `Owner ${n}`, company_name: `Fleet ${n}`, mobile: `98000000${n}0`, email: `owner${n}@example.com`,
  password: 'x', approve: true, active: true, status: 'approved', wallet: { balance: 0 }, createdAt: new Date(), ...extra,
})).insertedId;
const mkDriver = (n, extra = {}) => Driver.create({
  name: `Driver ${n}`, phone: `91000000${40 + n}`, password: 'x-test-pass', approve: true, status: 'approved', isOnline: true, isOnRide: false,
  vehicleType: 'car', vehicleTypeId: sedan, vehicleTypeIds: [sedan], vehicleNumber: `MH12OB${n}${n}${n}`, vehicleColor: 'white',
  location: { type: 'Point', coordinates: [PICKUP[0], PICKUP[1] + 0.001 * n] }, ...extra,
});
const passFor = (driverId) => DriverSubscription.collection.insertOne({
  driverId, planId: new mongoose.Types.ObjectId(), planName: 'Day', amount: 50, vehicleClasses: ['car'],
  startsAt: new Date(Date.now() - 3600e3), expiresAt: new Date(Date.now() + 24 * 3600e3), status: 'active', paymentMethod: 'wallet', paidAt: new Date(), tripsCovered: 0, commissionWaived: 0,
});
const matched = async () => (await matchDrivers(PICKUP, { maxDistance: 5000, vehicleTypeId: String(sedan), serviceType: 'ride' })).drivers.map((d) => d.name).sort();

// A finished ride ready to settle: owner commission 10%, solo-driver commission 0.
const finishedRide = async (driver, { fare, method }) => {
  const ride = await rides.createRideRecord({
    userId: rider._id, pickupCoords: PICKUP, dropCoords: [PICKUP[0], PICKUP[1] + 0.05], pickupAddress: 'A', dropAddress: 'B', fare,
    vehicleTypeId: String(sedan), paymentMethod: method, serviceType: 'ride',
  });
  await Ride.updateOne({ _id: ride._id }, {
    $set: {
      driverId: driver._id, status: 'completed', completedAt: new Date(), fare, paymentMethod: method,
      'pricingSnapshot.admin_commission_type_for_owner': 1, 'pricingSnapshot.admin_commission_for_owner': 10,
      'pricingSnapshot.admin_commission_type_from_driver': 1, 'pricingSnapshot.admin_commission_from_driver': 0,
    },
  });
  return String(ride._id);
};
const ownerBalance = async (id) => round((await Owner.findById(id).lean()).wallet.balance);

// ---------------------------------------------------------------- 1. admin makes owner plans (HTTP)
const plan = await call('POST', '/admin/owner-subscriptions/plans/create', tAdmin, { name: 'Fleet Monthly', amount: 999, duration: 30, description: 'Whole fleet', active: true });
assert.equal(plan.status, 200, JSON.stringify(plan.body));
const planId = String(plan.body.data._id);
assert.equal((await call('POST', '/admin/owner-subscriptions/plans/create', tAdmin, { name: ' ' })).status, 400);
assert.equal((await call('GET', '/admin/owner-subscriptions/plans/list')).status, 401);
const listed = await call('GET', '/admin/owner-subscriptions/plans/list', tAdmin);
assert.equal(listed.body.data.results.length, 1);
assert.equal((await call('PATCH', `/admin/owner-subscriptions/plans/${planId}`, tAdmin, { amount: 1000 })).body.data.amount, 1000);
assert.equal((await call('GET', '/admin/driver-subscriptions/plans/list', tAdmin)).body.data.results.length, 0, 'owner plans do not leak into the driver plan list');

// ---------------------------------------------------------------- 2. no plan: the fleet is stopped, solo drivers are not
const ownerId = await insertOwner(1);
const fleet = await mkDriver(1, { owner_id: ownerId });
const solo = await mkDriver(2);
const soloNoPass = await mkDriver(3);
await passFor(solo._id);
const tOwner = tokenFor(ownerId, 'owner');

let status = await billing.getOwnerServiceStatus(ownerId);
assert.equal(status.active, false, 'a legacy owner with no plan has no service');
assert.equal(status.mode, 'subscription');
assert.deepEqual(await matched(), ['Driver 2'], 'only the solo driver with a pass is dispatched');
await failsWith(Driver.findById(fleet._id).then((d) => wallet.ensureDriverWalletCanAcceptRide(d)), 403, 'fleet driver, no owner plan');
await failsWith(Driver.findById(soloNoPass._id).then((d) => wallet.ensureDriverWalletCanAcceptRide(d)), 403, 'solo driver without a pass is still refused');
await wallet.ensureDriverWalletCanAcceptRide(await Driver.findById(solo._id));

// ---------------------------------------------------------------- 3. owner buys a plan from the wallet (HTTP)
const view = await call('GET', '/drivers/owner/billing', tOwner);
assert.equal(view.status, 200, JSON.stringify(view.body));
assert.equal(view.body.data.serviceActive, false);
assert.equal(view.body.data.plans.length, 1);
assert.equal((await call('GET', '/drivers/owner/billing')).status, 401);
assert.equal((await call('GET', '/drivers/owner/billing', tokenFor(fleet._id, 'driver'))).status, 403, 'a driver token cannot use owner billing');
assert.equal((await call('POST', '/drivers/owner/billing/subscribe', tOwner, { planId, paymentMethod: 'wallet' })).status, 400, 'no balance');
await Owner.updateOne({ _id: ownerId }, { $set: { 'wallet.balance': 1500 } });
const bought = await call('POST', '/drivers/owner/billing/subscribe', tOwner, { planId, paymentMethod: 'wallet' });
assert.equal(bought.status, 200, JSON.stringify(bought.body));
assert.equal(bought.body.data.billing.serviceActive, true);
assert.equal(await ownerBalance(ownerId), 500, 'wallet debited by the plan price');
const walletRow = await OwnerWalletTransaction.findOne({ ownerId, type: 'subscription_purchase' }).lean();
assert.equal(walletRow.kind, 'debit');
assert.equal(walletRow.amount, 1000);
assert.equal((await call('POST', '/drivers/owner/billing/subscribe', tOwner, { planId, paymentMethod: 'wallet' })).status, 409, 'cannot stack a second plan');
assert.deepEqual(await matched(), ['Driver 1', 'Driver 2'], 'the fleet driver works with no pass of their own');
await wallet.ensureDriverWalletCanAcceptRide(await Driver.findById(fleet._id));
assert.equal(await DriverSubscription.countDocuments({ driverId: fleet._id }), 0, 'fleet driver never bought a pass');

// ---------------------------------------------------------------- 4. rides under the plan: no commission
const cashRide = await finishedRide(fleet, { fare: 400, method: 'cash' });
await wallet.settleCompletedRideWallet({ rideId: cashRide });
let r = await Ride.findById(cashRide).lean();
assert.equal(r.commissionAmount, 0, 'commission waived while the plan is active');
assert.equal(String(r.ownerId), String(ownerId));
assert.equal(await ownerBalance(ownerId), 500, 'cash fleet ride under a plan changes nothing');
const onlineRide = await finishedRide(fleet, { fare: 600, method: 'online' });
await wallet.settleCompletedRideWallet({ rideId: onlineRide });
assert.equal(await ownerBalance(ownerId), 1100, 'online fare credited to the owner');
r = await Ride.findById(onlineRide).lean();
assert.equal(r.driverEarnings, 600);
assert.equal(await wallet.settleCompletedRideWallet({ rideId: onlineRide }), null, 'settling twice does nothing');
assert.equal(await ownerBalance(ownerId), 1100);
assert.equal(await WalletTransaction.countDocuments({ driverId: fleet._id }), 0, 'the fleet driver wallet is not touched');
const sub = await OwnerSubscription.findOne({ ownerId }).lean();
assert.equal(sub.tripsCovered, 2);
assert.equal(round(sub.commissionWaived), 100, '10% of 400 + 10% of 600 not charged');

// ---------------------------------------------------------------- 5. the plan ends: owner and drivers stop
await OwnerSubscription.updateOne({ _id: sub._id }, { $set: { startsAt: new Date(Date.now() - 40 * 864e5), expiresAt: new Date(Date.now() - 60e3) } });
status = await billing.getOwnerServiceStatus(ownerId);
assert.equal(status.active, false);
assert.match(status.reason, /subscription has ended/);
assert.deepEqual(await matched(), ['Driver 2'], 'fleet driver no longer dispatched');
await failsWith(Driver.findById(fleet._id).then((d) => wallet.ensureDriverWalletCanAcceptRide(d)), 403, 'fleet driver after the plan ended');
await sweepExpiredOwnerSubscriptions();
assert.equal((await Driver.findById(fleet._id).lean()).isOnline, false, 'the sweep took the fleet driver offline');
assert.ok((await OwnerSubscription.findById(sub._id).lean()).expiryNotifiedAt, 'claimed once');
const again = await call('GET', '/drivers/owner/billing', tOwner);
assert.equal(again.body.data.serviceActive, false);
assert.equal(again.body.data.subscription, null);

// ---------------------------------------------------------------- 6. owner switches to commission
const switched = await call('PUT', '/drivers/owner/billing/mode', tOwner, { mode: 'commission' });
assert.equal(switched.status, 200, JSON.stringify(switched.body));
assert.equal(switched.body.data.mode, 'commission');
assert.equal(switched.body.data.serviceActive, true);
assert.equal((await call('PUT', '/drivers/owner/billing/mode', tOwner, { mode: 'bogus' })).status, 400);
await Driver.updateOne({ _id: fleet._id }, { isOnline: true });
assert.deepEqual(await matched(), ['Driver 1', 'Driver 2'], 'commission mode keeps the fleet working');
await wallet.ensureDriverWalletCanAcceptRide(await Driver.findById(fleet._id));
const before = await ownerBalance(ownerId);
const cash2 = await finishedRide(fleet, { fare: 500, method: 'cash' });
await wallet.settleCompletedRideWallet({ rideId: cash2 });
r = await Ride.findById(cash2).lean();
assert.equal(r.commissionAmount, 50, '10% owner commission on a cash ride');
assert.equal(r.driverEarnings, 450);
assert.equal(await ownerBalance(ownerId), before - 50, 'cash ride: the owner owes the commission');
const online2 = await finishedRide(fleet, { fare: 500, method: 'online' });
await wallet.settleCompletedRideWallet({ rideId: online2 });
assert.equal(await ownerBalance(ownerId), before - 50 + 450, 'online ride: the owner is credited fare minus commission');
const rows = await OwnerWalletTransaction.find({ ownerId, rideId: { $ne: null } }).sort({ createdAt: 1 }).lean();
assert.deepEqual(rows.map((x) => [x.type, x.kind, x.amount]), [['ride_earning', 'credit', 600], ['commission_deduction', 'debit', 50], ['ride_earning', 'credit', 450]]);
assert.equal(rows.at(-1).balance, await ownerBalance(ownerId), 'running balance recorded');

const ledger = await call('GET', '/drivers/owner/wallet/history', tOwner);
assert.equal(ledger.status, 200);
assert.equal(ledger.body.data.balance, await ownerBalance(ownerId));
assert.equal(ledger.body.data.results[0].type, 'ride_earning', 'newest first');
assert.ok(ledger.body.data.results.some((x) => x.type === 'commission_deduction' && x.amount === 50 && x.rideId));
assert.equal((await call('GET', '/drivers/owner/wallet/history', tokenFor(fleet._id, 'driver'))).status, 403);

// admin sees the commission as platform earning
const commissionTotal = (await Ride.aggregate([{ $match: { ownerId } }, { $group: { _id: null, c: { $sum: '$commissionAmount' } } }]))[0].c;
assert.equal(commissionTotal, 100, '50 + 50 commission across the two commission-mode rides');

// ---------------------------------------------------------------- 7. back to a lapsed plan; commission value 0 also valid
await call('PUT', '/drivers/owner/billing/mode', tOwner, { mode: 'subscription' });
assert.equal((await billing.getOwnerServiceStatus(ownerId)).active, false, 'subscription mode with no live plan has no service');

// ---------------------------------------------------------------- 8. solo drivers: settlement now works on a standalone Mongo
const soloOnline = await finishedRide(solo, { fare: 300, method: 'online' });
const res = await wallet.settleCompletedRideWallet({ rideId: soloOnline });
assert.ok(res, 'settled');
assert.equal((await Driver.findById(solo._id).lean()).wallet.balance, 300, 'online earning credited to the solo driver');
assert.equal((await WalletTransaction.findOne({ driverId: solo._id }).lean()).type, 'ride_earning');
assert.equal((await Ride.findById(soloOnline).lean()).ownerId, null);
const soloCash = await finishedRide(solo, { fare: 200, method: 'cash' });
assert.equal(await wallet.settleCompletedRideWallet({ rideId: soloCash }), null, 'cash + commission waived by the pass: nothing to move');
assert.equal((await DriverSubscription.findOne({ driverId: solo._id }).lean()).tripsCovered, 2);

// ---------------------------------------------------------------- 9. admin: grant, mode, payments, overview
const owner2 = await insertOwner(2);
const grant = await call('POST', '/admin/owner-subscriptions/grant', tAdmin, { ownerId: String(owner2), planId });
assert.equal(grant.status, 200, JSON.stringify(grant.body));
assert.equal((await billing.getOwnerServiceStatus(owner2)).active, true);
assert.equal((await OwnerSubscription.findOne({ ownerId: owner2 }).lean()).amount, 0, 'a gifted plan is not counted as revenue');
assert.equal((await call('POST', '/admin/owner-subscriptions/grant', tAdmin, { ownerId: String(owner2), planId: String(new mongoose.Types.ObjectId()) })).status, 400);
assert.equal((await call('PATCH', `/admin/owner-subscriptions/owners/${owner2}/mode`, tAdmin, { mode: 'commission' })).status, 200);
const pays = await call('GET', '/admin/owner-subscriptions/payments', tAdmin);
assert.equal(pays.body.data.total, 2);
assert.equal(pays.body.data.collected, 1000, 'only the paid plan counts');
const overview = await call('GET', '/admin/owner-subscriptions/owners', tAdmin);
const row1 = overview.body.data.results.find((x) => x.id === String(ownerId));
assert.equal(row1.serviceActive, false);
assert.equal(row1.drivers, 1);
assert.equal(overview.body.data.results.find((x) => x.id === String(owner2)).mode, 'commission');
assert.equal((await call('GET', '/admin/owner-management/manage-owners', tAdmin)).status, 200);

// owner commission: one place to see and set it
const { SetPrice } = await import('../src/modules/taxi/admin/models/SetPrice.js');
await SetPrice.collection.insertOne({ pricing_scope: 'normal', transport_type: 'taxi', vehicle_type: sedan, admin_commission_type_for_owner: 1, admin_commission_for_owner: 0, active: 1, status: 'active' });
await SetPrice.collection.insertOne({ pricing_scope: 'package', package_vehicle_prices: [{ vehicle_type: sedan, admin_commission_for_owner: 0 }, { vehicle_type: sedan, admin_commission_for_owner: 0 }] });
const setCommission = await call('POST', '/admin/owner-subscriptions/commission', tAdmin, { type: 'percentage', value: 12 });
assert.equal(setCommission.status, 200, JSON.stringify(setCommission.body));
assert.equal(setCommission.body.data.updated.prices, 1);
assert.equal((await SetPrice.findOne({ pricing_scope: 'normal' }).lean()).admin_commission_for_owner, 12);
assert.deepEqual((await SetPrice.findOne({ pricing_scope: 'package' }).lean()).package_vehicle_prices.map((x) => x.admin_commission_for_owner), [12, 12], 'every package row');
assert.equal((await Vehicle.findById(sedan).lean()).admin_commission_for_owner, 12);
const summary = await call('GET', '/admin/owner-subscriptions/commission', tAdmin);
assert.deepEqual(summary.body.data.prices, [{ type: 'percentage', value: 12, rows: 1 }]);
assert.equal((await call('POST', '/admin/owner-subscriptions/commission', tAdmin, { type: 'percentage', value: 150 })).status, 400);
assert.equal((await call('POST', '/admin/owner-subscriptions/commission', tAdmin, { type: 'fixed', value: -1 })).status, 400);
assert.equal((await call('POST', '/admin/owner-subscriptions/commission', tAdmin, { type: 'fixed', value: 25 })).body.data.type, 'fixed');
assert.equal((await call('GET', '/admin/owner-subscriptions/commission')).status, 401);

// ---------------------------------------------------------------- 10. a deleted owner has no service
await Owner.updateOne({ _id: owner2 }, { $set: { deletedAt: new Date() } });
assert.equal((await billing.getOwnerServiceStatus(owner2)).active, false);

// ---------------------------------------------------------------- 11. a rider pays for a finished ride (standalone Mongo: no transactions)
const { installStandaloneTransactionShim } = await import('../src/config/database.js');
const { UserWallet } = await import('../src/modules/taxi/user/models/UserWallet.js');
const { default: bareMongoose } = await import('mongoose');
// the raw transaction that failed in production ("Transaction numbers are only allowed on a replica set")
const probe = await bareMongoose.startSession();
probe.startTransaction();
await failsWithMessage(Ride.findOne({}).session(probe), /Transaction numbers are only allowed/);
await probe.endSession();
assert.equal(await installStandaloneTransactionShim(), true, 'a standalone server is detected');
assert.equal(await installStandaloneTransactionShim(), true, 'and installing twice is harmless');
const guarded = await bareMongoose.startSession();
guarded.startTransaction();
await Ride.findOne({}).session(guarded);
await guarded.commitTransaction();
await guarded.endSession();

// back on commission, a fleet ride the rider pays online afterwards: the fare goes to the owner, the tip to the driver
await call('PUT', '/drivers/owner/billing/mode', tOwner, { mode: 'commission' });
await Driver.updateOne({ _id: fleet._id }, { $set: { 'wallet.balance': 0 } });
const payRide = await finishedRide(fleet, { fare: 300, method: 'cash' });
await wallet.settleCompletedRideWallet({ rideId: payRide }); // cash-like settlement: 10% commission off the owner wallet
const ownerBefore = await ownerBalance(ownerId);
await UserWallet.updateOne({ userId: rider._id }, { $set: { balance: 1000, transactions: [] } }, { upsert: true });
const tRider = tokenFor(rider._id, 'user');
const paid = await call('POST', `/rides/${payRide}/complete-payment/wallet`, tRider, { rating: 5, comment: 'ok', tipAmount: 20 });
assert.equal(paid.status, 201, JSON.stringify(paid.body));
assert.equal((await UserWallet.findOne({ userId: rider._id }).lean()).balance, 680, 'the rider paid fare + tip');
assert.equal(await ownerBalance(ownerId), ownerBefore + 300, 'the FARE reaches the owner wallet');
const fareRow = await OwnerWalletTransaction.findOne({ ownerId, rideId: payRide, title: /paid online/ }).lean();
assert.equal(fareRow.amount, 300);
assert.equal(fareRow.kind, 'credit');
assert.equal((await Driver.findById(fleet._id).lean()).wallet.balance, 20, 'the TIP stays with the driver');
assert.equal((await Ride.findById(payRide).lean()).driverPaymentCollection.status, 'paid');
assert.equal((await call('POST', `/rides/${payRide}/complete-payment/wallet`, tRider, { rating: 5, tipAmount: 20 })).status, 409, 'cannot be paid twice');
assert.equal((await UserWallet.findOne({ userId: rider._id }).lean()).balance, 680, 'and a repeat takes nothing more');

// a solo driver is credited as before (fare to the driver wallet)
const soloPayRide = await finishedRide(solo, { fare: 200, method: 'cash' });
await wallet.settleCompletedRideWallet({ rideId: soloPayRide });
const soloBefore = (await Driver.findById(solo._id).lean()).wallet.balance;
assert.equal((await call('POST', `/rides/${soloPayRide}/complete-payment/wallet`, tRider, { rating: 4, tipAmount: 0 })).status, 201);
assert.equal((await Driver.findById(solo._id).lean()).wallet.balance, soloBefore + 200, 'solo driver: the fare is credited to their wallet');
assert.equal((await UserWallet.findOne({ userId: rider._id }).lean()).balance, 480);

// a failure half-way gives the rider's money back (there is no rollback on a standalone server)
const brokenRide = await finishedRide(solo, { fare: 150, method: 'cash' });
await Ride.collection.updateOne({ _id: new mongoose.Types.ObjectId(brokenRide) }, { $set: { driverId: new mongoose.Types.ObjectId() } }); // driver that does not exist
const walletBeforeFail = (await UserWallet.findOne({ userId: rider._id }).lean()).balance;
const failed = await call('POST', `/rides/${brokenRide}/complete-payment/wallet`, tRider, { rating: 5, tipAmount: 0 });
assert.notEqual(failed.status, 201, 'the payment cannot finish');
assert.equal((await UserWallet.findOne({ userId: rider._id }).lean()).balance, walletBeforeFail, 'the rider is not charged for a payment that failed');

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('owner billing: all checks passed');
process.exit(0);
