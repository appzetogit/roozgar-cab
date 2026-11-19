/**
 * Fills the price of each extra day on outstation package rows where it is still 0, so multi-day round trips can be
 * booked (dry run unless --apply). A multi-day trip costs: round trip price (base x 1.8) + this for every day after the
 * first. Starting value per vehicle: 1.5 x that vehicle's cheapest outstation base price, rounded to Rs 50. It is a
 * placeholder: set the real number per row in Admin > Pricing > Outstation Pricing. Never overwrites a value an admin set.
 *   node scripts/setupOutstationDays.mjs [--apply]
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { SetPrice } from '../src/modules/taxi/admin/models/SetPrice.js';
import { Vehicle } from '../src/modules/taxi/admin/models/Vehicle.js';

const APPLY = process.argv.includes('--apply');
const idText = (value) => String(value?._id || value || '');

await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${mongoose.connection.name}`);

const packages = await SetPrice.find({ pricing_scope: 'package', package_kind: { $ne: 'hourly_rental' } });
const cheapest = new Map();
for (const doc of packages) {
  for (const row of doc.package_vehicle_prices || []) {
    const base = Number(row.base_price) || 0;
    if (base <= 0) continue;
    const key = idText(row.vehicle_type);
    cheapest.set(key, Math.min(cheapest.get(key) ?? Infinity, base));
  }
}
const names = new Map((await Vehicle.find({ _id: { $in: [...cheapest.keys()] } }).select('name').lean()).map((v) => [idText(v._id), v.name]));
const extraFor = (vehicleId) => Math.round(((cheapest.get(vehicleId) || 0) * 1.5) / 50) * 50;

const changed = new Map();
for (const doc of packages) {
  let touched = false;
  for (const row of doc.package_vehicle_prices || []) {
    if (Number(row.extra_day_price) > 0) continue;
    const key = idText(row.vehicle_type);
    const value = extraFor(key);
    if (!value) continue;
    row.extra_day_price = value;
    touched = true;
    changed.set(key, (changed.get(key) || 0) + 1);
  }
  if (touched && APPLY) {
    doc.markModified('package_vehicle_prices');
    await doc.save();
  }
}
for (const [key, count] of changed) console.log(`  ${names.get(key) || key}: ${count} row(s) -> Rs ${extraFor(key)} per extra day (cheapest base Rs ${cheapest.get(key)})`);
const total = [...changed.values()].reduce((sum, n) => sum + n, 0);
console.log(APPLY ? `\nDone: ${total} rows.` : `\nDry run only, nothing written (${total} rows would change).`);
await mongoose.disconnect();
process.exit(0);
