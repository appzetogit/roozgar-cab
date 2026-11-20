/**
 * Fills the admin settings that were never set, without touching anything an admin already set (dry run unless --apply):
 *   1. Driver commission: every city tariff row, outstation row and rental row whose commission from the driver is 0 or missing
 *      gets 10% (percentage), like the 10% owner commission and the vehicle default. The platform runs in commissionOnly mode,
 *      so with 0 it earned nothing from a solo driver's ride (a driver with a daily pass is still waived, as before).
 *   2. Owner documents: when the owner "needed documents" list is empty, the usual four (Aadhaar, PAN, business registration, bank proof).
 *   3. Notification channels: when there are none, the usual rider and driver topics.
 * Not touched on purpose: tolls (needs the real plaza locations and rates), the rider platform fee, time price, referral amounts, price hikes,
 * surge, gateway keys, owners' billing mode, zones. Edit those in the admin panel.
 *   node scripts/setupAdminDefaults.mjs [--apply]
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { SetPrice } from '../src/modules/taxi/admin/models/SetPrice.js';
import { OwnerNeededDocument } from '../src/modules/taxi/admin/models/OwnerNeededDocument.js';
import { NotificationChannel } from '../src/modules/taxi/admin/models/NotificationChannel.js';

const APPLY = process.argv.includes('--apply');
const COMMISSION = 10;
const unset = { $in: [0, null] }; // matches 0, null and a missing field

await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${mongoose.connection.name}\n`);

// ---- 1. driver commission
const cityFilter = { pricing_scope: { $ne: 'package' }, admin_commission_from_driver: unset };
const cityRows = await SetPrice.countDocuments(cityFilter);
const packages = await SetPrice.find({ pricing_scope: 'package' }).select('package_vehicle_prices package_kind').lean();
const packageRows = packages.flatMap((doc) => doc.package_vehicle_prices || []).filter((row) => !(Number(row.admin_commission_from_driver) > 0)).length;
console.log(`1. Driver commission -> ${COMMISSION}%: ${cityRows} city tariff rows, ${packageRows} outstation/rental rows`);
if (APPLY) {
  await SetPrice.updateMany(cityFilter, { $set: { admin_commission_type_from_driver: 1, admin_commission_from_driver: COMMISSION } });
  await SetPrice.updateMany(
    { pricing_scope: 'package' },
    { $set: { 'package_vehicle_prices.$[row].admin_commission_type_from_driver': 1, 'package_vehicle_prices.$[row].admin_commission_from_driver': COMMISSION } },
    { arrayFilters: [{ 'row.admin_commission_from_driver': unset }] },
  );
}

// ---- 2. owner documents
const OWNER_DOCS = [
  { name: 'Aadhaar Card', image_type: 'front_back', has_identify_number: true, is_required: true },
  { name: 'PAN Card', image_type: 'front', has_identify_number: true, is_required: true },
  { name: 'Business Registration / GST Certificate', image_type: 'image', has_identify_number: true, is_required: false },
  { name: 'Bank Passbook / Cancelled Cheque', image_type: 'front', has_identify_number: false, is_required: false },
];
const ownerDocs = await OwnerNeededDocument.countDocuments();
console.log(`2. Owner needed documents: ${ownerDocs} now${ownerDocs ? ', left as they are' : ` -> adding ${OWNER_DOCS.length}`}`);
if (APPLY && !ownerDocs) await OwnerNeededDocument.insertMany(OWNER_DOCS.map((doc) => ({ ...doc, has_expiry_date: false, is_editable: false, active: true })));

// ---- 3. notification channels
const CHANNELS = [
  { name: 'Ride updates', topic_name: 'ride_updates', description: 'Driver assigned, trip started, trip completed', for_user: true },
  { name: 'Offers and promotions', topic_name: 'offers_promotions', description: 'Promo codes and offers', for_user: true },
  { name: 'Payments and wallet', topic_name: 'payments_wallet', description: 'Payments, refunds and wallet activity', for_user: true },
  { name: 'Ride requests', topic_name: 'driver_ride_requests', description: 'New ride requests near the driver', for_user: false },
  { name: 'Earnings and wallet', topic_name: 'driver_earnings', description: 'Earnings, commission and wallet activity', for_user: false },
  { name: 'Announcements', topic_name: 'driver_announcements', description: 'Messages from Roozgar Cab to drivers', for_user: false },
];
const channels = await NotificationChannel.countDocuments();
console.log(`3. Notification channels: ${channels} now${channels ? ', left as they are' : ` -> adding ${CHANNELS.length}`}`);
if (APPLY && !channels) await NotificationChannel.insertMany(CHANNELS.map((channel) => ({ ...channel, push_notification: true, mail: false })));

console.log(APPLY ? '\nDone.' : '\nDry run only, nothing written.');
await mongoose.disconnect();
process.exit(0);
