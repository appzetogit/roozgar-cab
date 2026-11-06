/**
 * Fills the gaps in CITY ride pricing (rider app shows nothing for a zone with no tariff). Dry run unless --apply.
 * Only adds what is missing; never overwrites a value an admin set. Safe to run twice.
 *
 *   node scripts/setupCityPricing.mjs                      show what it would do
 *   node scripts/setupCityPricing.mjs --apply              do it
 *   node scripts/setupCityPricing.mjs --source Indore      city whose rows are copied (default Indore)
 *   node scripts/setupCityPricing.mjs --airport-fee 100    also set this support airport fee on airports whose fee is 0
 *
 * 1. Every active zone with NO ride tariff (no row for the zone, none for its service location) gets a row for every vehicle
 *    the source city has a row for, cloned from the source row. THE NUMBERS ARE INDORE'S, a starting point and not a decision:
 *    the admin edits them under Pricing > Set Price.
 * 2. Ride rows whose user / driver cancellation fee is 0 get Rs 20 / Rs 30 fixed (Indore's values). Non-zero fees are untouched.
 * 3. Airports: the flags the airport flow reads (active, pickup/drop availability, a location) are completed when missing, and
 *    airports with a zero airport fee are listed. The fee amount is the business's to decide, so it is only written with --airport-fee.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { SetPrice } from '../src/modules/taxi/admin/models/SetPrice.js';
import { Vehicle } from '../src/modules/taxi/admin/models/Vehicle.js';
import { ServiceLocation } from '../src/modules/taxi/admin/models/ServiceLocation.js';
import { Airport } from '../src/modules/taxi/admin/models/Airport.js';
import { Zone } from '../src/modules/taxi/driver/models/Zone.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const APPLY = process.argv.includes('--apply');
const SOURCE = new RegExp(`^${String(arg('source', 'Indore')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
const AIRPORT_FEE = Number(arg('airport-fee', 0)) || 0;
const USER_CANCEL_FEE = 20;
const DRIVER_CANCEL_FEE = 30;

await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${mongoose.connection.name}`);

const idText = (v) => (v ? String(v._id || v) : '');
const rideRows = await SetPrice.find({ pricing_scope: { $in: ['ride', null] }, transport_type: { $in: ['taxi', 'both'] }, active: 1, status: 'active' }).lean();
const locations = await ServiceLocation.find({}).select('name service_location_name').lean();
const zones = await Zone.find({ active: { $ne: false }, status: { $ne: 'inactive' } }).select('name service_location_id').lean();
const vehicles = new Map((await Vehicle.find({ active: { $ne: false }, status: { $nin: [0, '0'] } }).select('name').lean()).map((v) => [idText(v._id), v]));

// ---- 1. zones with no tariff
const sourceLocations = locations.filter((l) => SOURCE.test(l.name || l.service_location_name || '')).map((l) => idText(l._id));
const sourceZones = zones.filter((z) => sourceLocations.includes(idText(z.service_location_id))).map((z) => idText(z._id));
const sourceRows = rideRows.filter((r) => (sourceLocations.includes(idText(r.service_location_id)) || sourceZones.includes(idText(r.zone_id))) && vehicles.has(idText(r.vehicle_type)));
const sourceByVehicle = new Map();
for (const r of sourceRows.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))) {
  if (!sourceByVehicle.has(idText(r.vehicle_type))) sourceByVehicle.set(idText(r.vehicle_type), r);
}
console.log(`\nsource "${SOURCE.source.slice(1)}": ${sourceByVehicle.size} vehicle tariff(s) to copy`);

const covered = (zone) => rideRows.some((r) => idText(r.zone_id) === idText(zone._id)
  || (idText(zone.service_location_id) && idText(r.service_location_id) === idText(zone.service_location_id)));
const strip = ({ _id, createdAt, updatedAt, __v, ...rest }) => rest;
let created = 0;
if (sourceByVehicle.size === 0) console.log('  no source tariffs found: nothing to copy (use --source <city name>)');
for (const zone of zones.filter((z) => !covered(z))) {
  const where = locations.find((l) => idText(l._id) === idText(zone.service_location_id));
  console.log(`\nzone "${zone.name}" (${where?.name || where?.service_location_name || 'no service location'}) has no ride tariff`);
  for (const [vehicleId, source] of sourceByVehicle) {
    console.log(`  + ${vehicles.get(vehicleId).name}: base ${source.base_price}/${source.base_distance} km, ${source.price_per_distance}/km, ${source.time_price}/min, tax ${source.service_tax}%`);
    created += 1;
    if (APPLY) {
      const exists = await SetPrice.exists({ zone_id: zone._id, vehicle_type: vehicleId, pricing_scope: { $in: ['ride', null] }, transport_type: { $in: ['taxi', 'both'] } });
      if (!exists) await SetPrice.create({ ...strip(source), zone_id: zone._id, service_location_id: zone.service_location_id || null });
    }
  }
}
console.log(`\nride tariffs to add: ${created}`);

// ---- 2. cancellation fees that are 0
const feeless = await SetPrice.find({ pricing_scope: { $in: ['ride', null] }, transport_type: { $in: ['taxi', 'both'] }, active: 1, status: 'active', $or: [{ user_cancellation_fee: { $not: { $gt: 0 } } }, { driver_cancellation_fee: { $not: { $gt: 0 } } }] }).select('user_cancellation_fee driver_cancellation_fee').lean();
let feeRows = 0;
for (const r of feeless) {
  const set = {};
  if (!(Number(r.user_cancellation_fee) > 0)) Object.assign(set, { user_cancellation_fee: USER_CANCEL_FEE, user_cancellation_fee_type: 'fixed' });
  if (!(Number(r.driver_cancellation_fee) > 0)) Object.assign(set, { driver_cancellation_fee: DRIVER_CANCEL_FEE, driver_cancellation_fee_type: 'fixed' });
  feeRows += 1;
  if (APPLY) await SetPrice.updateOne({ _id: r._id }, { $set: set });
}
console.log(`cancellation fees to fill (user Rs ${USER_CANCEL_FEE} / driver Rs ${DRIVER_CANCEL_FEE} where 0): ${feeRows} row(s)`);

// ---- 3. airports
const airports = await Airport.find({}).lean();
let airportFixes = 0;
for (const a of airports) {
  const set = {};
  if (a.pickup_availability === undefined || a.pickup_availability === null) set.pickup_availability = true;
  if (a.drop_availability === undefined || a.drop_availability === null) set.drop_availability = true;
  if (!a.status) set.status = 'active';
  if (a.active === undefined || a.active === null) set.active = true;
  const hasPlace = a.boundary?.coordinates?.[0]?.length >= 4 || a.location?.coordinates?.length === 2 || (Number.isFinite(a.latitude) && Number.isFinite(a.longitude));
  const feeless = !(Number(a.support_airport_fee) > 0) && !(Number(a.airport_surge) > 0);
  if (AIRPORT_FEE > 0 && !(Number(a.support_airport_fee) > 0)) set.support_airport_fee = AIRPORT_FEE;
  console.log(`airport "${a.name}": ${hasPlace ? 'has a location' : 'NO LOCATION OR BOUNDARY (admin must draw it)'}; fee ${Number(a.support_airport_fee) || 0} + surge ${Number(a.airport_surge) || 0}${feeless && !set.support_airport_fee ? ' (no fee: decide one, or pass --airport-fee)' : ''}${Object.keys(set).length ? `; sets ${Object.keys(set).join(', ')}` : ''}`);
  if (Object.keys(set).length) {
    airportFixes += 1;
    if (APPLY) await Airport.updateOne({ _id: a._id }, { $set: set });
  }
}
console.log(`airports to update: ${airportFixes}`);

console.log(APPLY ? '\nDone.' : '\nDry run only. Run with --apply to write.');
await mongoose.disconnect();
