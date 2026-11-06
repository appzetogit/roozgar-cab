/**
 * Fills the cancellation fee of outstation and hourly-rental package rows where it is still 0 (dry run unless --apply).
 * A rider who cancels AFTER a driver accepted pays this flat amount (to the driver); before that, nothing. Never overwrites a
 * fee an admin set. Starting values, editable in Admin > Pricing (Outstation Pricing / Rental Package Pricing):
 *   outstation Rs 200, hourly rental Rs 100.
 *   node scripts/setupCancellationFees.mjs [--apply]
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { SetPrice } from '../src/modules/taxi/admin/models/SetPrice.js';

const APPLY = process.argv.includes('--apply');
const FEES = { intercity: 200, hourly_rental: 100 };

await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${mongoose.connection.name}`);
let rows = 0;
for (const [kind, fee] of Object.entries(FEES)) {
  const filter = { pricing_scope: 'package', package_kind: kind === 'intercity' ? { $ne: 'hourly_rental' } : 'hourly_rental' };
  const docs = await SetPrice.find(filter);
  let count = 0;
  for (const doc of docs) {
    let changed = false;
    for (const row of doc.package_vehicle_prices || []) {
      if (!Number(row.cancellation_fee)) { row.cancellation_fee = fee; count += 1; changed = true; }
    }
    if (changed && APPLY) { doc.markModified('package_vehicle_prices'); await doc.save(); }
  }
  rows += count;
  console.log(`  ${kind === 'intercity' ? 'outstation' : 'hourly rental'}: ${count} vehicle row(s) at 0 -> Rs ${fee}`);
}
console.log(APPLY ? `\nDone: ${rows} rows.` : `\nDry run only, nothing written (${rows} rows would change).`);
await mongoose.disconnect();
process.exit(0);
