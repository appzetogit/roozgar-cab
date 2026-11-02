/**
 * One-off setup for owner billing on a live database. Dry run unless --apply.
 *
 *   node scripts/setupOwnerBilling.mjs            show what it would do
 *   node scripts/setupOwnerBilling.mjs --apply    do it
 *
 * Only adds what is missing and never overwrites what an admin has set:
 *  1. two owner plans (weekly, monthly) the admin can edit under Owner Subscription;
 *  2. the owner commission (10% of the fare) wherever it is still 0 on a price row,
 *     a package price row, or a vehicle type. It applies to an owner who runs on
 *     commission; an owner on a plan pays no commission. Solo-driver commission is
 *     not touched.
 * Owners themselves are not changed: until they buy a plan or choose commission
 * their fleet has no service, which is the intended rule.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { SubscriptionPlan } from '../src/modules/taxi/admin/models/SubscriptionPlan.js';
import { SetPrice } from '../src/modules/taxi/admin/models/SetPrice.js';
import { Vehicle } from '../src/modules/taxi/admin/models/Vehicle.js';

const APPLY = process.argv.includes('--apply');
const OWNER_COMMISSION_PERCENT = 10;
const PLANS = [
  { name: 'Fleet Weekly Plan', amount: 599, duration: 7, description: 'Your whole fleet works for 7 days. No pass for your drivers and no commission.', how_it_works: 'Pay once for the plan. All drivers linked to you get rides until it ends. When it ends, renew it or switch to commission.' },
  { name: 'Fleet Monthly Plan', amount: 1999, duration: 30, description: 'Your whole fleet works for 30 days. No pass for your drivers and no commission.', how_it_works: 'Pay once for the plan. All drivers linked to you get rides until it ends. When it ends, renew it or switch to commission.' },
];

await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${mongoose.connection.name}`);

for (const plan of PLANS) {
  const exists = await SubscriptionPlan.findOne({ audience: 'owner', name: plan.name }).lean();
  console.log(`  owner plan "${plan.name}" (Rs ${plan.amount}, ${plan.duration} days): ${exists ? 'exists' : 'will create'}`);
  if (!exists && APPLY) {
    await SubscriptionPlan.create({ ...plan, audience: 'owner', benefit_type: 'standard', ride_limit: 0, active: true });
  }
}

const zero = { $or: [{ admin_commission_for_owner: { $in: [0, null] } }, { admin_commission_for_owner: { $exists: false } }] };
const prices = await SetPrice.countDocuments({ pricing_scope: { $ne: 'package' }, ...zero });
const vehicles = await Vehicle.countDocuments(zero);
const packages = await SetPrice.find({ pricing_scope: 'package' }).select('package_vehicle_prices').lean();
const packageRows = packages.reduce((n, doc) => n + (doc.package_vehicle_prices || []).filter((row) => !Number(row.admin_commission_for_owner)).length, 0);
console.log(`  owner commission ${OWNER_COMMISSION_PERCENT}%: ${prices} price rows, ${packageRows} package rows, ${vehicles} vehicle types currently at 0`);

if (APPLY) {
  const set = { admin_commission_type_for_owner: 1, admin_commission_for_owner: OWNER_COMMISSION_PERCENT };
  await SetPrice.updateMany({ pricing_scope: { $ne: 'package' }, ...zero }, { $set: set });
  await Vehicle.updateMany(zero, { $set: set });
  for (const doc of packages) {
    const rows = doc.package_vehicle_prices || [];
    if (!rows.some((row) => !Number(row.admin_commission_for_owner))) continue;
    await SetPrice.updateOne(
      { _id: doc._id },
      { $set: Object.fromEntries(rows.flatMap((row, i) => (Number(row.admin_commission_for_owner)
        ? []
        : [[`package_vehicle_prices.${i}.admin_commission_type_for_owner`, 1], [`package_vehicle_prices.${i}.admin_commission_for_owner`, OWNER_COMMISSION_PERCENT]]))) },
    );
  }
}

console.log(APPLY ? '\nDone.' : '\nDry run only, nothing written.');
await mongoose.disconnect();
process.exit(0);
