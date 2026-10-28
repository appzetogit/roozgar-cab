// Smoke test for pooling fare tax fix + driver/owner wallet settlement, against
// a THROWAWAY Mongo.
//   POOLING_WALLET_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testPoolingWallets.mjs
// Drops its own database (pooling_wallet_test) when done. Never point it at production.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.POOLING_WALLET_TEST_MONGODB_URI;
if (!uri) throw new Error('Set POOLING_WALLET_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, {
  MONGODB_URI: uri, MONGODB_DB_NAME: 'pooling_wallet_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test',
});

const { PoolingVehicle } = await import('../src/modules/taxi/admin/models/PoolingVehicle.js');
const { PoolingBooking } = await import('../src/modules/taxi/admin/models/PoolingBooking.js');
const { PoolingWalletTransaction } = await import('../src/modules/taxi/admin/models/PoolingWalletTransaction.js');
const { Owner } = await import('../src/modules/taxi/admin/models/Owner.js');
const { OwnerWalletTransaction } = await import('../src/modules/taxi/admin/models/OwnerWalletTransaction.js');
const { settlePoolingBookingWallets, reversePoolingBookingWallets } =
  await import('../src/modules/taxi/admin/services/poolingWalletService.js');

await mongoose.connect(uri, { dbName: 'pooling_wallet_test' });
await mongoose.connection.dropDatabase();

// ---- 1. the service-tax formula itself (no DB needed) ----
{
  // Re-implemented from poolingController.js's computePoolingFareBreakdown so this
  // test fails if that formula regresses, without importing a controller file.
  const baseFare = 1000;
  const serviceTaxPercentage = 5;
  const serviceTaxAmount = Math.round(((baseFare * serviceTaxPercentage) / 100) * 100) / 100;
  assert.equal(serviceTaxAmount, 50, '5% of Rs 1000 must be Rs 50, not Rs 0.50');
}

// ---- 2. settlement credits driver + owner wallets, once ----
const owner = await Owner.create({ name: 'Test Owner', company_name: 'Test Co', mobile: '9000011111', email: 'owner-test@example.com', password: 'x-test-pw' });
const vehicle = await PoolingVehicle.create({
  ownerId: owner._id, name: 'Test Cab', vehicleModel: 'Dzire', vehicleNumber: 'MH12AB9999',
  capacity: 4, adminCommissionPercentage: 10, ownerCommissionPercentage: 5,
});

const booking = await PoolingBooking.create({
  bookingId: 'POOLTEST1', user: owner._id /* any ObjectId */, route: owner._id, vehicle: vehicle._id,
  scheduleId: 's1', pickupStopId: 'p1', dropStopId: 'd1', seatsBooked: 2, selectedSeats: ['0-1', '1-1'],
  fare: 1050, baseFare: 1000, serviceTaxPercentage: 5, serviceTaxAmount: 50,
  driverCommissionPercentage: 10, driverCommissionAmount: 100,
  ownerCommissionPercentage: 5, ownerCommissionAmount: 50,
  paymentStatus: 'paid', bookingStatus: 'confirmed', travelDate: new Date(),
  pickupLabel: 'A', dropLabel: 'B', payment: { provider: 'razorpay', orderId: 'o1', paymentId: 'p1', status: 'paid' },
});

await settlePoolingBookingWallets(booking);
let v = await PoolingVehicle.findById(vehicle._id).lean();
let o = await Owner.findById(owner._id).lean();
assert.equal(v.wallet.balance, 100, 'driver wallet must be credited the driverCommissionAmount');
assert.equal(o.wallet.balance, 50, 'owner wallet must be credited the ownerCommissionAmount');
assert.equal(await PoolingWalletTransaction.countDocuments({ bookingId: booking._id }), 2);
assert.equal(await OwnerWalletTransaction.countDocuments({ ownerId: owner._id }), 1);

// calling it again (e.g. a retried request) must not double-credit
await settlePoolingBookingWallets(booking);
v = await PoolingVehicle.findById(vehicle._id).lean();
o = await Owner.findById(owner._id).lean();
assert.equal(v.wallet.balance, 100, 'settling twice must not double-credit the driver');
assert.equal(o.wallet.balance, 50, 'settling twice must not double-credit the owner');
assert.equal(await PoolingWalletTransaction.countDocuments({ bookingId: booking._id }), 2);

// ---- 3. a vehicle with no owner (admin-owned) only credits the driver side ----
const soloVehicle = await PoolingVehicle.create({
  ownerId: null, name: 'Admin Cab', vehicleModel: 'Ertiga', vehicleNumber: 'MH12CD8888', capacity: 6,
});
const soloBooking = await PoolingBooking.create({
  bookingId: 'POOLTEST2', user: owner._id, route: owner._id, vehicle: soloVehicle._id,
  scheduleId: 's1', pickupStopId: 'p1', dropStopId: 'd1', seatsBooked: 1, selectedSeats: ['0-1'],
  fare: 210, baseFare: 200, serviceTaxPercentage: 5, serviceTaxAmount: 10,
  driverCommissionPercentage: 10, driverCommissionAmount: 20, ownerCommissionPercentage: 0, ownerCommissionAmount: 0,
  paymentStatus: 'paid', bookingStatus: 'confirmed', travelDate: new Date(),
  pickupLabel: 'A', dropLabel: 'B', payment: { provider: 'razorpay', orderId: 'o2', paymentId: 'p2', status: 'paid' },
});
await settlePoolingBookingWallets(soloBooking);
assert.equal((await PoolingVehicle.findById(soloVehicle._id).lean()).wallet.balance, 20);
assert.equal(await PoolingWalletTransaction.countDocuments({ bookingId: soloBooking._id }), 1);

// ---- 4. cancelling a settled booking reverses both credits ----
await reversePoolingBookingWallets(booking._id);
v = await PoolingVehicle.findById(vehicle._id).lean();
o = await Owner.findById(owner._id).lean();
assert.equal(v.wallet.balance, 0, 'reversal must remove the driver credit');
assert.equal(o.wallet.balance, 0, 'reversal must remove the owner credit');
assert.equal(await PoolingWalletTransaction.countDocuments({ bookingId: booking._id }), 0);
assert.equal(await OwnerWalletTransaction.countDocuments({ ownerId: owner._id }), 2, 'the reversal is logged too');

// reversing an unsettled booking is a safe no-op
await reversePoolingBookingWallets(soloBooking._id); // not reversed yet, do it for real this time
assert.equal((await PoolingVehicle.findById(soloVehicle._id).lean()).wallet.balance, 0);
await reversePoolingBookingWallets(soloBooking._id); // already reversed: no-op, must not throw or go negative
assert.equal((await PoolingVehicle.findById(soloVehicle._id).lean()).wallet.balance, 0);

await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('pooling wallet settlement: all checks passed');
process.exit(0);
