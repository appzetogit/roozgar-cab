/**
 * READ-ONLY audit of what the admin has set up, per city and per booking type, and what is missing for each kind of booking
 * to be priced and settled. Writes nothing.   node scripts/auditAdminData.mjs
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';

await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
const db = mongoose.connection.db;
const C = (name) => db.collection(name);
const idStr = (v) => String(v || '');
const vehicles = await C('taxivehicles').find({}, { projection: { name: 1, icon_types: 1, category: 1, status: 1, active: 1, capacity: 1, transport_type: 1, is_taxi: 1, dispatch_type: 1, delivery_category: 1 } }).toArray();
const vName = new Map(vehicles.map((v) => [idStr(v._id), v.name]));
const locations = await C('taxiservicelocations').find({}).toArray();
const zones = await C('taxizones').find({}).toArray();
const lName = (id) => locations.find((l) => idStr(l._id) === idStr(id))?.name || idStr(id).slice(-6);
const prices = await C('taxisetprices').find({ pricing_scope: { $ne: 'package' } }).toArray();

console.log('VEHICLE TYPES', vehicles.length, vehicles.map((v) => `${v.name.replace('Roozgar ', '')}[${v.category || v.icon_types}${v.status === 0 ? ',OFF' : ''}]`).join(', '));
console.log('\nCITIES / ZONES', locations.map((l) => `${l.name}(${zones.filter((z) => idStr(z.service_location_id) === idStr(l._id)).length} zones)`).join(', '));

const need = ['base_price', 'base_distance', 'price_per_distance', 'time_price', 'waiting_charge', 'service_tax', 'admin_commision', 'admin_commission_from_driver', 'admin_commission_for_owner', 'user_cancellation_fee', 'driver_cancellation_fee'];
console.log('\nCITY PRICE ROWS (ride scope) per city: vehicles priced / fields at 0');
for (const loc of locations) {
  const rows = prices.filter((p) => idStr(p.service_location_id) === idStr(loc._id) && p.status !== 'inactive');
  if (!rows.length) { console.log(`  ${loc.name}: NO PRICE ROWS`); continue; }
  const zero = {};
  for (const r of rows) for (const f of need) if (!Number(r[f])) zero[f] = (zero[f] || 0) + 1;
  const veh = new Set(rows.map((r) => idStr(r.vehicle_type)));
  console.log(`  ${loc.name}: ${rows.length} rows, ${veh.size} vehicles, zeroed: ${Object.entries(zero).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}
const sample = prices.find((p) => p.vehicle_type);
console.log('\nSAMPLE ROW (Indore Sedan)', JSON.stringify(prices.find((p) => /sedan/i.test(vName.get(idStr(p.vehicle_type)) || '') && /indore/i.test(lName(p.service_location_id))) || sample, (k, v) => (k === '_id' || /At$/.test(k) ? undefined : v)).slice(0, 1800));

console.log('\nOUTSTATION: rows with enable_outstation_ride', prices.filter((p) => p.enable_outstation_ride).length, '; package rows (intercity):', await C('taxisetprices').countDocuments({ pricing_scope: 'package', package_kind: { $ne: 'hourly_rental' } }), '; rental packages:', await C('taxisetprices').countDocuments({ pricing_scope: 'package', package_kind: 'hourly_rental' }));
console.log('AIRPORT: airports', await C('taxiairports').countDocuments({}), JSON.stringify(await C('taxiairports').find({}, { projection: { name: 1, service_location_id: 1, active: 1, 'airport_fee': 1, fee: 1 } }).limit(6).toArray()).slice(0, 500));
console.log('PARCEL: goods types', await C('taxigoodstypes').countDocuments({}), '; vehicles with delivery_category', vehicles.filter((v) => v.delivery_category).length, '; delivery-capable vehicles', vehicles.filter((v) => ['delivery', 'both'].includes(String(v.transport_type || v.is_taxi))).map((v) => v.name).join(', '));
console.log('SURGE/HIKE: price hikes', await C('taxipricehikes').countDocuments({}), '; surge settings', await C('taxisurgesettings').countDocuments({}));
console.log('TOLLS: plazas', await C('taxitollplazas').countDocuments({}));
console.log('PROMOS', await C('taxipromocodes').countDocuments({}), '; cancellation reasons', await C('taxicancellationreasons').countDocuments({}));
console.log('SUBSCRIPTION PLANS', JSON.stringify(await C('taxisubscriptionplans').aggregate([{ $group: { _id: '$audience', n: { $sum: 1 } } }]).toArray()));
console.log('SHARE: cars priced for share (city rows of car-class vehicles):', prices.filter((p) => /sedan|suv|mini|xl/i.test(vName.get(idStr(p.vehicle_type)) || '')).length);

const biz = await C('taxiadminbusinesssettings').findOne({ scope: 'default' });
const show = (o, keys) => keys.map((k) => `${k}=${o?.[k] ?? '(unset)'}`).join(' ');
console.log('\nTRANSPORT RIDE SETTINGS', show(biz?.transport_ride, ['maximum_time_for_find_drivers_for_regular_ride', 'maximum_time_for_find_drivers_for_bidding_ride', 'driver_search_radius', 'trip_dispatch_type', 'enable_pooling_ride']));
console.log('GENERAL', show(biz?.general, ['currency_symbol', 'default_currency', 'distance_unit']));
const app = await C('taxiadminappsettings').findOne({}) || {};
console.log('WALLET', JSON.stringify(app.wallet_setting || {}).slice(0, 400));
console.log('TIP', JSON.stringify(app.tip_setting || {}).slice(0, 300));
await mongoose.disconnect();
process.exit(0);
