/**
 * Makes the new admin settings explicit on a database (dry run unless --apply). Only fills what is missing, never overwrites an
 * admin's value:
 *   bid_ride.driver_counter_enabled = '1'   drivers may counter a ride offer with a higher price (the limit and the step are the
 *                                           existing bidding_high_percentage / bidding_amount_increase_or_decrease)
 * The outstation advance is NOT set here: it lives on each outstation price row and the admin chooses it (Admin > Pricing >
 * Outstation Pricing); until a row has one, bookings need no advance.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { AdminBusinessSetting } from '../src/modules/taxi/admin/models/AdminBusinessSetting.js';

const APPLY = process.argv.includes('--apply');
await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${mongoose.connection.name}`);

const doc = await AdminBusinessSetting.findOne({ scope: 'default' }).select('bid_ride').lean();
const current = doc?.bid_ride || {};
const wanted = { driver_counter_enabled: '1' };
const missing = Object.entries(wanted).filter(([key]) => current[key] === undefined);
for (const [key, value] of Object.entries(wanted)) {
  console.log(`  bid_ride.${key}: ${current[key] === undefined ? `will set "${value}"` : `already "${current[key]}"`}`);
}
console.log(`  (limit ${current.bidding_high_percentage ?? '20 (default)'}%, step Rs ${current.bidding_amount_increase_or_decrease ?? '10 (default)'})`);

if (APPLY && missing.length) {
  await AdminBusinessSetting.updateOne(
    { scope: 'default' },
    { $set: Object.fromEntries(missing.map(([key, value]) => [`bid_ride.${key}`, value])) },
    { upsert: true },
  );
}
console.log(APPLY ? '\nDone.' : '\nDry run only, nothing written.');
await mongoose.disconnect();
process.exit(0);
