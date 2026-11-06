// Admin Payments ledger and the subscriptions (pass-day) report, against a THROWAWAY Mongo.
//   PAYMENTS_LEDGER_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testPaymentsLedger.mjs
// Drops its own database (payments_ledger_test) when done. Never point it at production.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.PAYMENTS_LEDGER_TEST_MONGODB_URI;
if (!uri) throw new Error('Set PAYMENTS_LEDGER_TEST_MONGODB_URI to a throwaway Mongo');
Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB_NAME: 'payments_ledger_test', JWT_SECRET: 'test-secret', NODE_ENV: 'test' });

const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) =>
  String(url).startsWith('http://127.0.0.1') ? realFetch(url, ...rest) : Promise.reject(new Error('offline in test'));

const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/modules/taxi/services/tokenService.js');
const { Ride } = await import('../src/modules/taxi/user/models/Ride.js');
const { RideAdvance } = await import('../src/modules/taxi/user/models/RideAdvance.js');
const { User } = await import('../src/modules/taxi/user/models/User.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { DriverSubscription } = await import('../src/modules/taxi/driver/models/DriverSubscription.js');
const { WalletTransaction } = await import('../src/modules/taxi/driver/models/WalletTransaction.js');
const { OwnerSubscription } = await import('../src/modules/taxi/admin/models/OwnerSubscription.js');
const { Owner } = await import('../src/modules/taxi/admin/models/Owner.js');
const { Admin } = await import('../src/modules/taxi/admin/models/Admin.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');

await mongoose.connect(uri, { dbName: 'payments_ledger_test' });
await mongoose.connection.dropDatabase();

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;

let failed = null;
try {
  const admin = (await Admin.collection.insertOne({ name: 'Super', email: 'super@example.com', password: 'x', createdAt: new Date() })).insertedId;
  const token = signAccessToken({ sub: String(admin), role: 'admin' });
  const get = async (path) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null);
    return { status: res.status, data: body?.data ?? body, res };
  };

  const sedan = (await Vehicle.collection.insertOne({ name: 'Sedan', category: 'car', transport_type: 'taxi', active: true, status: 1 })).insertedId;
  const bike = (await Vehicle.collection.insertOne({ name: 'Bike', category: 'bike', transport_type: 'taxi', active: true, status: 1 })).insertedId;
  const rider = await User.create({ name: 'Rita Rider', phone: '9000000041', city: 'Indore', state: 'MP', street: 'x', password: 'x-test-pass' });
  const driverA = await Driver.create({ name: 'Dev Car', phone: '9100000051', password: 'x-test-pass', approve: true, status: 'approved', vehicleType: 'car', vehicleTypeId: sedan, vehicleTypeIds: [sedan], vehicleNumber: 'MP09CA1111' });
  const driverB = await Driver.create({ name: 'Bhanu Bike', phone: '9100000052', password: 'x-test-pass', approve: true, status: 'approved', vehicleType: 'bike', vehicleTypeId: bike, vehicleTypeIds: [bike], vehicleNumber: 'MP09BK2222' });
  const owner = await Owner.create({ name: 'Omkar', company_name: 'Omkar Fleet', mobile: '9200000077', email: 'o@example.com', password: 'x-test-pass', approve: true, status: 'approved', billing: { mode: 'commission' }, wallet: { balance: 0 } });

  const ist = (s) => new Date(`${s}+05:30`);
  const DAY = '2026-03-10';
  const noon = ist('2026-03-10T12:00:00');
  const ride = (extra) => ({ userId: rider._id, driverId: driverA._id, status: 'completed', fare: 100, paymentMethod: 'cash', vehicleTypeId: sedan, pickupAddress: 'A', dropAddress: 'B', completedAt: noon, createdAt: noon, updatedAt: noon, ...extra });
  const advanceId = new mongoose.Types.ObjectId();
  const advRideId = new mongoose.Types.ObjectId();
  await Ride.collection.insertMany([
    ride({ fare: 100 }), // cash
    ride({ fare: 200, paymentMethod: 'online', collectedVia: 'online', driverPaymentCollection: { status: 'paid', provider: 'razorpay', providerPaymentId: 'pay_ride_online', paidAt: noon } }),
    ride({ fare: 300, paymentMethod: 'wallet' }),
    ride({ fare: 400, paymentMethod: 'online', subscriptionUsage: { covered: true, planName: 'Rider Gold' } }),
    ride({ fare: 500, paymentMethod: 'online', driverPaymentCollection: { status: 'pending' } }), // completed, not paid yet
    ride({ fare: 50, collectedVia: 'upi' }), // paid to the driver's UPI
    ride({ _id: advRideId, fare: 3000, vehicleTypeId: bike, advance: { advanceId, amount: 600, status: 'applied' } }), // balance 2400 cash
    ride({ fare: 7, completedAt: ist('2026-03-09T23:59:59'), updatedAt: ist('2026-03-09T23:59:59') }), // day before
    ride({ fare: 9, completedAt: ist('2026-03-10T00:00:30') }), // first minute of the day, IST
    ride({ fare: 11, completedAt: ist('2026-03-10T23:59:30') }), // last minute of the day, IST
    ride({ fare: 13, completedAt: ist('2026-03-11T00:00:30') }), // day after
    ride({ fare: 999, status: 'cancelled' }),
  ]);
  await RideAdvance.collection.insertMany([
    { _id: advanceId, userId: rider._id, fare: 3000, amount: 600, status: 'used', paidAt: noon, rideId: advRideId, razorpayPaymentId: 'pay_adv_1', vehicleTypeId: bike },
    { userId: rider._id, fare: 2000, amount: 400, status: 'refunded', paidAt: noon, rideId: new mongoose.Types.ObjectId(), razorpayPaymentId: 'pay_adv_2', vehicleTypeId: sedan },
    { userId: rider._id, fare: 2000, amount: 300, status: 'created', paidAt: null, razorpayOrderId: 'order_x' }, // never paid
  ]);

  const passBase = { amount: 49, vehicleClasses: ['car'], status: 'active', paymentMethod: 'wallet', tripsCovered: 0, commissionWaived: 0 };
  const cycle = ist('2026-03-10T06:00:00');
  const week = 7 * 864e5;
  await DriverSubscription.collection.insertMany([
    { ...passBase, driverId: driverA._id, planName: 'Car Day Pass', startsAt: cycle, expiresAt: new Date(cycle.getTime() + 864e5), paidAt: ist('2026-03-10T09:00:00') }, // wallet 49, in 6 PM closing
    { ...passBase, driverId: driverB._id, planName: 'Bike & Auto Weekly', amount: 149, vehicleClasses: ['bike'], paymentMethod: 'razorpay', paymentReference: 'pay_week', startsAt: ist('2026-03-08T06:00:00'), expiresAt: new Date(ist('2026-03-08T06:00:00').getTime() + week), paidAt: ist('2026-03-08T10:00:00') }, // bought earlier, covers the 10th
    { ...passBase, driverId: driverB._id, planName: 'Bike & Auto Day Pass', amount: 29, vehicleClasses: ['bike'], paymentMethod: 'bonus', startsAt: cycle, expiresAt: new Date(cycle.getTime() + 864e5), paidAt: ist('2026-03-10T07:00:00') }, // free
    { ...passBase, driverId: driverA._id, planName: 'Car Monthly', amount: 0, paymentMethod: 'admin', startsAt: cycle, expiresAt: new Date(cycle.getTime() + 30 * 864e5), paidAt: ist('2026-03-10T20:00:00') }, // admin-given, after 6 PM
    { ...passBase, driverId: driverA._id, planName: 'Car Day Pass', status: 'refunded', startsAt: cycle, expiresAt: new Date(cycle.getTime() + 864e5), paidAt: ist('2026-03-10T08:00:00') }, // refunded: covers nobody
    { ...passBase, driverId: driverA._id, planName: 'Car Day Pass', startsAt: cycle, expiresAt: new Date(cycle.getTime() + 864e5), paidAt: null }, // gateway not confirmed
  ]);
  await OwnerSubscription.collection.insertMany([
    { ownerId: owner._id, planName: 'Owner Monthly', amount: 1999, paymentMethod: 'razorpay', paymentReference: 'pay_owner', status: 'active', startsAt: cycle, expiresAt: new Date(cycle.getTime() + 30 * 864e5), paidAt: ist('2026-03-10T11:00:00') },
    { ownerId: owner._id, planName: 'Owner Trial', amount: 0, paymentMethod: 'admin', status: 'active', startsAt: cycle, expiresAt: new Date(cycle.getTime() + 7 * 864e5), paidAt: ist('2026-03-10T11:30:00') },
    { ownerId: owner._id, planName: 'Owner Unpaid', amount: 500, paymentMethod: 'razorpay', status: 'active', startsAt: cycle, expiresAt: new Date(cycle.getTime() + 864e5), paidAt: null },
  ]);
  await WalletTransaction.collection.insertOne({ driverId: driverA._id, type: 'top_up', amount: 1000, createdAt: noon, description: 'Driver wallet top-up', metadata: { provider: 'razorpay', providerPaymentId: 'pay_topup' } });

  // -------------------------------------------------------------- the ledger
  const q = (extra = '') => `/admin/payments?from=${DAY}&to=${DAY}&limit=200${extra}`;
  const all = (await get(q())).data;
  const by = (kind, rows = all.results) => rows.filter((r) => r.kind === kind);

  // Rides: 100 cash, 200 online, 300 wallet, 400 subscription, 500 pending, 50 UPI, 2400 balance, 9 and 11 (IST edges). Not 7, 13, cancelled.
  assert.deepEqual(by('ride').map((r) => r.amount).sort((a, b) => a - b), [9, 11, 50, 100, 200, 300, 400, 500, 2400]);
  const rideBy = (amount) => by('ride').find((r) => r.amount === amount);
  assert.equal(rideBy(100).method, 'cash');
  assert.equal(rideBy(200).method, 'online');
  assert.equal(rideBy(200).reference, 'pay_ride_online');
  assert.equal(rideBy(300).method, 'wallet');
  assert.equal(rideBy(400).method, 'subscription');
  assert.equal(rideBy(500).status, 'pending');
  assert.match(rideBy(50).detail, /UPI/);
  assert.equal(rideBy(2400).method, 'cash');
  assert.match(rideBy(2400).detail, /advance/, 'the ride row is the balance after the advance, not the full 3000');
  assert.ok(!by('ride').some((r) => r.amount === 3000), 'the advance is never counted twice');

  // Outstation advances: the used one (600) and the refunded one (400); the never-paid one is not a payment.
  assert.deepEqual(by('outstation_advance').map((r) => [r.amount, r.status]).sort((a, b) => a[0] - b[0]), [[400, 'refunded'], [600, 'paid']]);
  assert.ok(by('outstation_advance').find((r) => r.amount === 600).description.includes(String(advRideId)), 'carries the ride request id');
  assert.equal((await get(q(`&q=${advRideId}`))).data.results.filter((r) => r.kind === 'outstation_advance').length, 1, 'search by ride request id');

  // Driver passes: wallet 49, razorpay 149 is paid on the 8th (outside), bonus 29 (7 AM), admin 0 (8 PM); unconfirmed has no payment.
  const subs = by('subscription');
  assert.deepEqual(subs.map((r) => r.amount).sort((a, b) => a - b), [0, 29, 49, 49]);
  assert.equal(subs.find((r) => r.amount === 29).method, 'bonus');
  assert.equal(subs.find((r) => r.amount === 0).method, 'admin');
  assert.deepEqual(subs.filter((r) => r.status === 'refunded').length, 1, 'a refunded pass is listed as refunded');

  // Owner plans: paid 1999 + admin 0; the unpaid one is not a payment.
  assert.deepEqual(by('owner_subscription').map((r) => r.amount).sort((a, b) => a - b), [0, 1999]);
  const ownerRow = by('owner_subscription').find((r) => r.amount === 1999);
  assert.equal(ownerRow.method, 'online');
  assert.equal(ownerRow.payer.name, 'Omkar Fleet');
  assert.equal(ownerRow.kind_label, 'Owner plan');
  assert.match(ownerRow.invoice_number, /^ZC-O-/);

  assert.equal(by('driver_top_up').length, 1);
  assert.equal(by('driver_top_up')[0].amount, 1000);

  // Totals: online = 200 ride + 600 advance + 1999 owner plan + 1000 top-up (refunded advance and refunded pass excluded).
  assert.equal(all.totals.received_online, 200 + 600 + 1999 + 1000);
  assert.equal(all.totals.cash_with_drivers, 9 + 11 + 50 + 100 + 2400);
  assert.equal(all.totals.paid_from_wallet, 300 + 49, 'wallet ride + the paid, active wallet pass');
  assert.equal(all.totals.covered_by_subscription, 400);
  assert.equal(all.totals.pending_online, 500);
  assert.equal(all.totals.refunded_advances, 400);
  assert.equal(all.totals.given_free, 3, 'bonus pass, admin pass, admin owner plan');
  assert.equal(all.total, all.results.length);

  // Kind filter, method filter, vehicle filter.
  assert.deepEqual([...new Set((await get(q('&kind=owner_subscription'))).data.results.map((r) => r.kind))], ['owner_subscription']);
  assert.equal((await get(q('&kind=outstation_advance'))).data.total, 2);
  assert.equal((await get(q('&kind=ride&method=cash'))).data.total, 5);
  assert.equal((await get(q('&method=bonus'))).data.total, 1);
  const bikeRows = (await get(q(`&vehicle_type_id=${bike}`))).data.results;
  assert.ok(bikeRows.length >= 3 && bikeRows.every((r) => r.vehicle_type_ids.includes(String(bike))), 'rides, advance and passes of drivers on the bike type');
  // Search and pagination.
  assert.equal((await get(q('&q=pay_topup'))).data.total, 1);
  assert.equal((await get(q('&q=Omkar'))).data.total, 2);
  const page1 = (await get(`/admin/payments?from=${DAY}&to=${DAY}&limit=5&page=1`)).data;
  const page2 = (await get(`/admin/payments?from=${DAY}&to=${DAY}&limit=5&page=2`)).data;
  assert.equal(page1.results.length, 5);
  assert.equal(page1.total, all.total);
  assert.equal(page1.totals.received_online, all.totals.received_online, 'totals cover the whole filter, not the page');
  assert.ok(page2.results.every((r) => !page1.results.some((p) => p.id === r.id)));
  // Date edges (IST): the 11th has only the 13 ride; the 9th only the 7 ride.
  assert.deepEqual((await get('/admin/payments?from=2026-03-11&to=2026-03-11&kind=ride')).data.results.map((r) => r.amount), [13]);
  assert.deepEqual((await get('/admin/payments?from=2026-03-09&to=2026-03-09&kind=ride')).data.results.map((r) => r.amount), [7]);
  assert.equal((await get('/admin/payments?from=2030-01-01&to=2030-01-02')).data.total, 0);

  // Receipts: every non-ride kind makes a PDF.
  for (const row of [ownerRow, by('outstation_advance')[0], subs[0], by('driver_top_up')[0]]) {
    const res = await fetch(`${base}/admin/payments/${row.kind}/${row.record_id}/invoice`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200, `receipt for ${row.kind}`);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  }
  assert.equal((await fetch(`${base}/admin/payments/owner_subscription/${new mongoose.Types.ObjectId()}/invoice`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);

  // -------------------------------------------------------------- the subscriptions report
  const rep = (await get(`/admin/payments/subscribers?date=${DAY}`)).data;
  assert.equal(rep.day.date, DAY);
  assert.equal(rep.day.starts_at, ist('2026-03-10T06:00:00').toISOString());
  // Covering the 10th: car day (49), bike weekly bought on the 8th (149), bike bonus (29), car monthly admin (0). Not the refunded or unconfirmed ones.
  assert.equal(rep.totals.subscribers, 4);
  assert.deepEqual(rep.subscribers.map((r) => r.plan_name).sort(), ['Bike & Auto Day Pass', 'Bike & Auto Weekly', 'Car Day Pass', 'Car Monthly']);
  assert.equal(rep.subscribers.find((r) => r.plan_name === 'Bike & Auto Weekly').sold_today, false);
  assert.equal(rep.totals.collection, 49, 'only passes sold this day, once; bonus and admin are not money');
  assert.equal(rep.totals.free, 1);
  assert.equal(rep.closing.subscribers, 2, 'sold by 6 PM: car day and the bonus pass');
  assert.equal(rep.closing.collection, 49);
  assert.deepEqual(rep.by_class.map((c) => [c.vehicle_class, c.subscribers]), [['auto', 0], ['bike', 2], ['car', 2]]);
  assert.equal(rep.owner_plans.count, 2);
  assert.equal(rep.owner_plans.collection, 1999, 'the admin-given plan is not collection');
  assert.ok(rep.owner_plans.rows.every((r) => r.owner_name === 'Omkar Fleet'));
  // The weekly pass still covers later days (not collection again); an unrelated far day is empty.
  const later = (await get('/admin/payments/subscribers?date=2026-03-12')).data;
  assert.ok(later.subscribers.some((r) => r.plan_name === 'Bike & Auto Weekly'));
  assert.equal(later.totals.collection, 0);
  assert.equal((await get('/admin/payments/subscribers?date=2026-04-20')).data.subscribers.some((r) => r.plan_name === 'Bike & Auto Weekly'), false);
  assert.equal((await get(`/admin/payments/subscribers?date=${DAY}&vehicle_class=car`)).data.subscribers.length, 2);

  console.log('payments ledger: all checks passed');
} catch (error) {
  failed = error;
  console.error(error);
} finally {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
  server.close();
}
process.exit(failed ? 1 : 0);
