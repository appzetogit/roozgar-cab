/**
 * Makes Parcel Delivery bookable on a live database: the rider app offers nothing (and the server refuses to book)
 * until a delivery-capable vehicle type has a delivery price in the city. Dry run unless --apply. Only adds what is
 * missing; never changes anything an admin edited.
 *
 *   node scripts/setupParcelDelivery.mjs            show what it would do
 *   node scripts/setupParcelDelivery.mjs --apply    do it
 *
 * 1. Three delivery vehicle types (transport_type 'delivery', so they never appear in the cab list):
 *      Delivery Bike (2wheeler tile), Delivery Auto (Auto tile), Delivery Mini Truck (Trucks tile).
 *    Images are taken from vehicle images already stored under /uploads (nothing is fetched from outside).
 * 2. For every taxi price row of the city's Bike / Auto / Mini (same zone or service location), one delivery row
 *    (SetPrice scope 'ride', transport_type 'delivery'): base fare, km covered by it and per-km rate COPIED from that
 *    taxi row (Mini Truck: x1.6, base rounded to Rs 5, per km to Rs 0.5), waiting charge and commissions copied.
 *    The parcel fare is base + (km - covered km) x per km, exactly as the rider app quotes it.
 * 3. Goods types and the vehicles' own "default" delivery price are NOT touched: a city with no delivery row is
 *    deliberately not bookable (the server answers "Delivery is not priced for this vehicle in this area yet").
 *
 * The prices are a starting point scaled from the taxi tariff; the admin edits them under Pricing > Set Prices
 * (transport type Delivery).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Vehicle } from '../src/modules/taxi/admin/models/Vehicle.js';
import { SetPrice } from '../src/modules/taxi/admin/models/SetPrice.js';
import { ServiceLocation } from '../src/modules/taxi/admin/models/ServiceLocation.js';
import { GoodsType } from '../src/modules/taxi/admin/models/GoodsType.js';

const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// taxi: the taxi vehicle whose price row and picture are the starting point.
const DEFS = [
  { name: 'Delivery Bike', taxi: /^(roozgar )?bike$/i, icon_types: 'bike', category: 'bike', delivery_category: '2wheeler', capacity: 1, size: 'Up to 20 kg', factor: 1 },
  { name: 'Delivery Auto', taxi: /^(roozgar )?auto$/i, icon_types: 'auto', category: 'auto', delivery_category: '', capacity: 1, size: 'Up to 80 kg', factor: 1 },
  { name: 'Delivery Mini Truck', taxi: /^(roozgar )?mini$/i, icon_types: 'truck', category: '', delivery_category: 'trucks', capacity: 2, size: 'Up to 500 kg', factor: 1.6, imageFrom: /truck|lcv|mcv|hcv/i },
];
const CITIES = [/^indore$/i, /^hyderabad$/i, /^bidar 585401$/i, /^kalaburagi$/i];

const uploadsDir = env.uploads.dir ? path.resolve(env.uploads.dir) : path.join(__dirname, '../uploads');
const publicBase = String(env.publicBackendUrl || '').replace(/\/+$/, '');
const serverImageUrl = (value) => {
  const text = String(value || '');
  const at = text.indexOf('/uploads/');
  if (at === -1) return null;
  const urlPath = text.slice(at);
  if (urlPath.includes('..') || !fs.existsSync(path.join(uploadsDir, urlPath.slice('/uploads/'.length)))) return null;
  return publicBase ? `${publicBase}${urlPath}` : urlPath;
};
const roundTo = (n, step) => Math.round(n / step) * step;
const ZONELESS = 'none';

await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${mongoose.connection.name}`);

const all = await Vehicle.find({}).select('name transport_type image icon map_icon status active admin_commission_type_from_driver admin_commission_from_driver admin_commission_type_for_owner admin_commission_for_owner').lean();
const live = (v) => v.active !== false && Number(v.status) !== 0;
const pictureOf = (v) => serverImageUrl(v?.image) || serverImageUrl(v?.map_icon) || serverImageUrl(v?.icon) || '';

// ---- 1. vehicle types
const resolved = [];
for (const def of DEFS) {
  const taxi = all.find((v) => def.taxi.test(String(v.name || '').trim()) && ['taxi', 'both'].includes(v.transport_type) && live(v));
  const picture = pictureOf(taxi) || (def.imageFrom ? pictureOf(all.find((v) => def.imageFrom.test(String(v.name || '')) && pictureOf(v))) : '');
  let vehicle = all.find((v) => String(v.name || '').trim().toLowerCase() === def.name.toLowerCase());
  if (vehicle) {
    console.log(`vehicle "${def.name}": exists (${vehicle.transport_type}${live(vehicle) ? '' : ', switched off'}), left as is`);
  } else {
    console.log(`vehicle "${def.name}": will create (${def.size}, ${def.delivery_category || def.icon_types} tile), picture ${picture || 'none found'}, commission copied from ${taxi ? taxi.name : 'nothing (0)'}`);
    if (APPLY) {
      vehicle = (await Vehicle.create({
        name: def.name, transport_type: 'delivery', is_taxi: 'delivery', dispatch_type: 'normal', rental_enabled: false,
        icon_types: def.icon_types, category: def.category, delivery_category: def.delivery_category, capacity: def.capacity, size: def.size,
        image: picture, icon: picture, map_icon: picture, status: 1, active: true,
        admin_commission_type_from_driver: Number(taxi?.admin_commission_type_from_driver ?? 1), admin_commission_from_driver: Number(taxi?.admin_commission_from_driver ?? 0),
        admin_commission_type_for_owner: Number(taxi?.admin_commission_type_for_owner ?? 1), admin_commission_for_owner: Number(taxi?.admin_commission_for_owner ?? 0),
      })).toObject();
    } else {
      vehicle = { _id: new mongoose.Types.ObjectId(), name: def.name, placeholder: true };
    }
  }
  if (!taxi) console.log(`  (no taxi "${def.taxi.source}" vehicle found: no delivery prices can be derived for ${def.name})`);
  resolved.push({ def, vehicle, taxi });
}

// ---- 2. delivery price rows per city
let added = 0;
const locations = await ServiceLocation.find({}).select('name service_location_name').lean();
for (const match of CITIES) {
  const location = locations.find((l) => match.test(String(l.name || l.service_location_name || '').trim()));
  if (!location) { console.log(`\ncity ${match}: no such service location, skipped`); continue; }
  const cityName = location.name || location.service_location_name;
  console.log(`\n${cityName}`);
  for (const { def, vehicle, taxi } of resolved) {
    if (!taxi) continue;
    const taxiRows = await SetPrice.find({
      service_location_id: location._id, pricing_scope: 'ride', transport_type: 'taxi', vehicle_type: taxi._id, active: 1, status: 'active',
    }).sort({ updatedAt: -1 }).lean();
    // one per zone (newest wins)
    const byZone = new Map();
    for (const row of taxiRows) if (!byZone.has(String(row.zone_id || ZONELESS))) byZone.set(String(row.zone_id || ZONELESS), row);
    if (!byZone.size) { console.log(`  ${def.name}: ${taxi.name} has no taxi price here, nothing to copy`); continue; }
    for (const row of byZone.values()) {
      const base = roundTo(Number(row.base_price || 0) * def.factor, 5);
      const perKm = roundTo(Number(row.price_per_distance || 0) * def.factor, 0.5);
      if (!(base > 0 || perKm > 0)) { console.log(`  ${def.name}: the ${taxi.name} taxi row prices nothing, skipped`); continue; }
      const filter = { pricing_scope: 'ride', transport_type: 'delivery', vehicle_type: vehicle._id, zone_id: row.zone_id || null, service_location_id: row.service_location_id || location._id };
      const exists = vehicle.placeholder ? false : await SetPrice.exists(filter);
      const where = row.zone_id ? `zone ${String(row.zone_id).slice(-6)}` : 'whole city';
      if (exists) { console.log(`  ${def.name} (${where}): exists, left as is`); continue; }
      console.log(`  ${def.name} (${where}): will add  base Rs ${base} for ${Number(row.base_distance || 0)} km, then Rs ${perKm}/km`);
      added += 1;
      if (APPLY) {
        await SetPrice.create({
          ...filter, base_price: base, base_distance: Number(row.base_distance || 0), price_per_distance: perKm, time_price: 0,
          waiting_charge: Number(row.waiting_charge ?? 1), free_waiting_before: Number(row.free_waiting_before ?? 0), free_waiting_after: Number(row.free_waiting_after ?? 0),
          service_tax: Number(row.service_tax || 0), payment_type: ['cash', 'online'],
          admin_commision_type: 2, admin_commision: 0,
          admin_commission_type_from_driver: Number(row.admin_commission_type_from_driver ?? 1), admin_commission_from_driver: Number(row.admin_commission_from_driver ?? 0),
          admin_commission_type_for_owner: Number(row.admin_commission_type_for_owner ?? 1), admin_commission_for_owner: Number(row.admin_commission_for_owner ?? 0),
          user_cancellation_fee_type: row.user_cancellation_fee_type, user_cancellation_fee: row.user_cancellation_fee,
          driver_cancellation_fee_type: row.driver_cancellation_fee_type, driver_cancellation_fee: row.driver_cancellation_fee,
          cancellation_fee_goes_to: row.cancellation_fee_goes_to,
          status: 'active', active: 1,
        });
      }
    }
  }
}

// ---- 3. goods types, for information only
const goods = await GoodsType.find({ active: 1 }).select('goods_type_name goods_types_for').lean();
const limited = goods.filter((g) => !['', 'both', 'all'].includes(String(g.goods_types_for || 'both').trim().toLowerCase()));
console.log(`\ngoods types: ${goods.length} active, ${limited.length} restricted to named vehicles${limited.length ? ` (${limited.map((g) => `${g.goods_type_name}: ${g.goods_types_for}`).join('; ')})` : ''}. Not changed.`);
console.log(`${APPLY ? 'Done' : 'Dry run only, nothing written'}: ${added} delivery price rows to add.`);
await mongoose.disconnect();
process.exit(0);
