/**
 * Creates the outstation price rows the rider app needs (it offers nothing without them), with the advance the rider
 * pays online before booking. Dry run unless --apply. Only adds what is missing; never changes what an admin edited.
 *
 *   node scripts/setupOutstation.mjs            show what it would do
 *   node scripts/setupOutstation.mjs --apply    do it
 *
 * For each city below, one outstation package per destination (SetPrice, scope 'package', kind 'intercity') with a row for
 * every car-class vehicle that already has an outstation tariff in that city. The fare is the city's own outstation tariff
 * for the trip length: base price for the first km of the tariff, then the per-km price (rounded to Rs 10). Commissions are
 * copied from the city's ride row. The advance on every row is ADVANCE_PERCENT of the fare, refundable in full on cancel.
 *
 * Everything is a starting point: the admin edits it under Admin > Pricing > Outstation Pricing.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { SetPrice } from '../src/modules/taxi/admin/models/SetPrice.js';
import { Vehicle } from '../src/modules/taxi/admin/models/Vehicle.js';
import { ServiceLocation } from '../src/modules/taxi/admin/models/ServiceLocation.js';

const APPLY = process.argv.includes('--apply');
const ADVANCE_PERCENT = 20;
// Road km from the city, rounded. A rough guide the admin can change.
const CITIES = [
  { match: /^indore$/i, destinations: [['Ujjain', 55], ['Dewas', 38], ['Omkareshwar', 80], ['Ratlam', 140], ['Bhopal', 195]] },
  { match: /^hyderabad$/i, destinations: [['Warangal', 150], ['Bidar', 140], ['Vijayawada', 275]] },
  { match: /^bidar 585401$/i, destinations: [['Hyderabad', 140], ['Kalaburagi', 115]] },
];
const NOT_A_CAR = new Set(['bike', 'scooty', 'auto', 'truck', 'ehcb', 'hcv', 'lcv', 'mcv', 'bus', 'mini_bus']);

await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${mongoose.connection.name}`);

const roundTen = (n) => Math.round(n / 10) * 10;
const vehicles = new Map((await Vehicle.find({ transport_type: { $in: ['taxi', 'both', 'all'] } }).select('name icon_types category status active').lean()).map((v) => [String(v._id), v]));
const isCar = (v) => v && v.active !== false && Number(v.status) !== 0 && !NOT_A_CAR.has(String(v.icon_types || '').toLowerCase()) && String(v.category || '').toLowerCase() !== 'bike';

let createdPackages = 0;
let addedRows = 0;
for (const city of CITIES) {
  const location = (await ServiceLocation.find({}).select('name service_location_name').lean())
    .find((l) => city.match.test(String(l.name || l.service_location_name || '').trim()));
  if (!location) { console.log(`city ${city.match}: no such service location, skipped`); continue; }
  const cityName = location.name || location.service_location_name;

  // the city's own outstation tariff per vehicle (one row per vehicle: the first zone row found)
  const tariffs = await SetPrice.find({
    service_location_id: location._id, pricing_scope: { $ne: 'package' }, enable_outstation_ride: { $in: [1, true] }, active: 1, status: 'active',
  }).select('vehicle_type outstation_base_price outstation_base_distance outstation_price_per_distance admin_commission_type_from_driver admin_commission_from_driver admin_commission_type_for_owner admin_commission_for_owner service_tax').lean();
  const byVehicle = new Map();
  for (const t of tariffs) if (t.vehicle_type && isCar(vehicles.get(String(t.vehicle_type))) && !byVehicle.has(String(t.vehicle_type))) byVehicle.set(String(t.vehicle_type), t);
  console.log(`\n${cityName}: ${byVehicle.size} car vehicle types with an outstation tariff`);
  if (!byVehicle.size) continue;

  const rowFor = (vehicleId, tariff, km) => {
    const fare = roundTen(Number(tariff.outstation_base_price || 0) + Math.max(0, km - Number(tariff.outstation_base_distance || 0)) * Number(tariff.outstation_price_per_distance || 0));
    return {
      vehicle_type: vehicleId, base_price: fare, free_distance: km, distance_price: Number(tariff.outstation_price_per_distance || 0), free_time: 0, time_price: 0,
      admin_commision_type: 2, admin_commision: 0,
      admin_commission_type_from_driver: Number(tariff.admin_commission_type_from_driver ?? 1), admin_commission_from_driver: Number(tariff.admin_commission_from_driver ?? 0),
      admin_commission_type_for_owner: Number(tariff.admin_commission_type_for_owner ?? 1), admin_commission_for_owner: Number(tariff.admin_commission_for_owner ?? 0),
      service_tax: Number(tariff.service_tax ?? 0), cancellation_fee: 0,
      advance_type: 'percentage', advance_value: ADVANCE_PERCENT, active: 1,
    };
  };

  for (const [destination, km] of city.destinations) {
    const filter = { pricing_scope: 'package', package_kind: 'intercity', service_location_id: location._id, package_destination: destination };
    const existing = await SetPrice.findOne(filter);
    const want = [...byVehicle.entries()].map(([id, tariff]) => rowFor(new mongoose.Types.ObjectId(id), tariff, km));
    if (!existing) {
      createdPackages += 1;
      addedRows += want.length;
      const sample = want.slice(0, 3).map((r) => `${vehicles.get(String(r.vehicle_type)).name.replace(/^Roozgar /, '')} Rs ${r.base_price}`).join(', ');
      console.log(`  ${cityName} -> ${destination} (${km} km): will create, ${want.length} vehicles, advance ${ADVANCE_PERCENT}%  e.g. ${sample}`);
      if (APPLY) {
        await SetPrice.create({
          ...filter, transport_type: 'taxi', package_availability: 'available', payment_type: ['cash', 'online', 'wallet'], status: 'active', active: 1,
          package_vehicle_prices: want,
        });
      }
    } else {
      const have = new Set((existing.package_vehicle_prices || []).map((r) => String(r.vehicle_type)));
      const missing = want.filter((r) => !have.has(String(r.vehicle_type)));
      console.log(`  ${cityName} -> ${destination}: exists${missing.length ? `, will add ${missing.length} vehicle row(s)` : ', complete'}`);
      if (missing.length) {
        addedRows += missing.length;
        if (APPLY) { existing.package_vehicle_prices.push(...missing); await existing.save(); }
      }
    }
  }
}

console.log(`\n${APPLY ? 'Done' : 'Dry run only, nothing written'}: ${createdPackages} outstation packages, ${addedRows} vehicle rows to add.`);
await mongoose.disconnect();
process.exit(0);
