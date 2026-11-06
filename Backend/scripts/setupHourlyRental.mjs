/**
 * One-off setup for Hourly Rental on a live database. Dry run unless --apply.
 *
 *   node scripts/setupHourlyRental.mjs            show what it would do
 *   node scripts/setupHourlyRental.mjs --apply    do it
 *
 * Creates, only where missing (never overwrites what an admin has edited):
 *  1. five rental package names ("1 Hour / 10 KM" ... "12 Hours / 120 KM");
 *  2. for each, one nationwide package price (SetPrice, package_kind
 *     'hourly_rental') with a row for every car-class taxi vehicle, priced
 *     Rs 25 per included km plus a time charge, extra Rs 25/km and Rs 2/min
 *     (the same starting prices the Kranti Cabs project uses). Drivers are on
 *     subscription, so the commission on every row is a fixed 0.
 *  3. the "Hourly Rental" home tile (app module, service_type 'hourly_rental')
 *     with an icon and cover taken from vehicle images already stored on this
 *     server under /uploads (nothing is fetched from outside), only where those
 *     fields are empty.
 *
 * Prices are a starting point: the admin edits them under Hourly Rental >
 * Rental Package Pricing. Re-running only adds what is missing, so a new
 * vehicle type is added to the existing packages and nothing else changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Vehicle } from '../src/modules/taxi/admin/models/Vehicle.js';
import { SetPrice } from '../src/modules/taxi/admin/models/SetPrice.js';
import { RentalPackageType } from '../src/modules/taxi/admin/models/RentalPackageType.js';
import { TaxiAppModule } from '../src/modules/taxi/admin/models/TaxiAppModule.js';

const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KM_RATE = 25; // Rs per included km
const EXTRA_KM_RATE = 25; // Rs per km beyond the package
const EXTRA_MINUTE_RATE = 2; // Rs per minute beyond the package
const PACKAGES = [
  { name: '1 Hour / 10 KM', hours: 1, km: 10, timeCharge: 50 },
  { name: '2 Hours / 20 KM', hours: 2, km: 20, timeCharge: 100 },
  { name: '4 Hours / 40 KM (Half Day)', hours: 4, km: 40, timeCharge: 200 },
  { name: '8 Hours / 80 KM (Full Day)', hours: 8, km: 80, timeCharge: 300 },
  { name: '12 Hours / 120 KM', hours: 12, km: 120, timeCharge: 400 },
];
// A cab with a driver: not two-wheelers, autos or goods vehicles.
const NOT_A_CAB = new Set(['bike', 'scooty', 'auto', 'truck', 'ehcb', 'hcv', 'lcv', 'mcv', 'bus', 'mini_bus']);

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

await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${mongoose.connection.name}`);

const vehicles = (await Vehicle.find({ transport_type: { $in: ['taxi', 'both', 'all'] }, active: { $ne: false } })
  .select('name icon_types capacity image status transport_type rental_enabled').lean())
  .filter((v) => Number(v.status) !== 0)
  .filter((v) => !NOT_A_CAB.has(String(v.icon_types || '').toLowerCase()))
  .filter((v) => !(Number(v.capacity) > 0 && Number(v.capacity) < 3));
console.log(`cab vehicle types for rentals: ${vehicles.map((v) => v.name).join(', ') || 'NONE FOUND'}`);

const rowFor = (vehicleId, pkg) => ({
  vehicle_type: vehicleId,
  base_price: pkg.km * KM_RATE + pkg.timeCharge,
  free_distance: pkg.km,
  free_time: pkg.hours * 60,
  distance_price: EXTRA_KM_RATE,
  time_price: EXTRA_MINUTE_RATE,
  cancellation_fee: 0,
  service_tax: 0,
  admin_commision_type: 2,
  admin_commision: 0,
  admin_commission_type_from_driver: 2,
  admin_commission_from_driver: 0,
  admin_commission_type_for_owner: 2,
  admin_commission_for_owner: 0,
  active: 1,
});

let createdTypes = 0;
let createdPrices = 0;
let addedRows = 0;
for (const pkg of PACKAGES) {
  let type = await RentalPackageType.findOne({ name: pkg.name, transport_type: 'taxi' });
  if (!type) {
    createdTypes += 1;
    console.log(`  package name "${pkg.name}": will create`);
    if (APPLY) {
      type = await RentalPackageType.create({
        transport_type: 'taxi', name: pkg.name, status: 'active', active: true,
        short_description: `${pkg.hours} hr / ${pkg.km} km`,
        description: `A cab with a driver for ${pkg.hours} hour${pkg.hours > 1 ? 's' : ''} and ${pkg.km} km. Extra km and extra time are billed at the end of the trip.`,
      });
    }
  }

  const filter = { pricing_scope: 'package', package_kind: 'hourly_rental', package_type_id: type?._id, service_location_id: null };
  let price = type ? await SetPrice.findOne(filter) : null;
  if (!price) {
    createdPrices += 1;
    addedRows += vehicles.length;
    console.log(`  package price "${pkg.name}": will create with ${vehicles.length} vehicle rows`);
    if (APPLY) {
      price = await SetPrice.create({
        ...filter, transport_type: 'taxi', package_destination: 'Local', package_availability: 'available',
        payment_type: ['cash', 'online'], status: 'active', active: 1,
        package_vehicle_prices: vehicles.map((v) => rowFor(v._id, pkg)),
      });
    }
  } else {
    const have = new Set((price.package_vehicle_prices || []).map((row) => String(row.vehicle_type)));
    const missing = vehicles.filter((v) => !have.has(String(v._id)));
    if (missing.length) {
      addedRows += missing.length;
      console.log(`  package price "${pkg.name}": exists, will add ${missing.length} missing vehicle row(s): ${missing.map((v) => v.name).join(', ')}`);
      if (APPLY) {
        price.package_vehicle_prices.push(...missing.map((v) => rowFor(v._id, pkg)));
        await price.save();
      }
    } else {
      console.log(`  package price "${pkg.name}": exists, complete`);
    }
  }
}

// The home tile
const cars = vehicles.filter((v) => serverImageUrl(v.image));
const iconUrl = cars.length ? serverImageUrl(cars[0].image) : null;
const coverUrl = serverImageUrl((cars.find((v) => /suv|premium|xl/i.test(`${v.name} ${v.icon_types}`)) || cars[0])?.image) || iconUrl;
console.log(`image from server for the tile: ${iconUrl || 'NONE FOUND'}`);
const tile = await TaxiAppModule.findOne({ service_type: 'hourly_rental' });
if (!tile) {
  console.log('  home tile "Hourly Rental": will create');
  if (APPLY) {
    const last = await TaxiAppModule.findOne().sort({ order_by: -1 }).select('order_by').lean();
    await TaxiAppModule.create({
      name: 'Hourly Rental', transport_type: 'taxi', service_type: 'hourly_rental', active: 1, order_by: (last?.order_by || 0) + 1,
      short_description: 'Cab by the hour', description: 'Book a cab with a driver by the hour. Pay for the package, and only for extra km or time.',
      mobile_menu_icon: iconUrl || '', mobile_menu_cover_image: coverUrl || null,
    });
  }
} else {
  const set = {};
  if (!tile.mobile_menu_icon && iconUrl) set.mobile_menu_icon = iconUrl;
  if (!tile.mobile_menu_cover_image && coverUrl) set.mobile_menu_cover_image = coverUrl;
  if (!tile.description) set.description = 'Book a cab with a driver by the hour.';
  console.log(`  home tile "${tile.name}": ${Object.keys(set).length ? `will set ${Object.keys(set).join(', ')}` : 'already complete'}`);
  if (APPLY && Object.keys(set).length) await TaxiAppModule.updateOne({ _id: tile._id }, { $set: set });
}

console.log(`\n${APPLY ? 'Done' : 'Dry run only, nothing written'}: ${createdTypes} package names, ${createdPrices} package prices, ${addedRows} vehicle rows to add.`);
await mongoose.disconnect();
process.exit(0);
