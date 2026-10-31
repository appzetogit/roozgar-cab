/**
 * One-off setup for Share Ride on a live database. Dry run unless --apply.
 *
 *   node scripts/setupShareRide.mjs                          show what it would do
 *   node scripts/setupShareRide.mjs --apply                  do it
 *   node scripts/setupShareRide.mjs --apply --pause-legacy   also pause the old demo pooling data
 *
 * 1. The "Car Pooling" home module (service_type 'pooling'): gives it an icon and
 *    a cover image taken from vehicle images already stored on this server
 *    (under /uploads; nothing is fetched from outside) and a description, but
 *    only where those fields are still empty, so an image the admin chose
 *    stays. Creates the module if there is none.
 * 2. --pause-legacy: the old admin-managed fixed-route pooling is no longer how
 *    riders book. Pauses the demo routes and vehicles created by
 *    scripts/seedCarPooling.mjs (RZPOOL- prefix) so nobody pays for a demo driver
 *    through the old screens. Nothing is deleted and existing bookings are
 *    untouched; set status back to 'active' to undo.
 *
 * Share Ride itself needs no data: riders create requests, drivers and owners
 * run the trips.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Vehicle } from '../src/modules/taxi/admin/models/Vehicle.js';
import { TaxiAppModule } from '../src/modules/taxi/admin/models/TaxiAppModule.js';
import { PoolingRoute } from '../src/modules/taxi/admin/models/PoolingRoute.js';
import { PoolingVehicle } from '../src/modules/taxi/admin/models/PoolingVehicle.js';

const APPLY = process.argv.includes('--apply');
const PAUSE_LEGACY = process.argv.includes('--pause-legacy');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = env.uploads.dir ? path.resolve(env.uploads.dir) : path.join(__dirname, '../uploads');
const publicBase = String(env.publicBackendUrl || '').replace(/\/+$/, '');

// A stored image counts only if its file is really on this server.
const serverImageUrl = (value) => {
  const text = String(value || '');
  const at = text.indexOf('/uploads/');
  if (at === -1) return null;
  const urlPath = text.slice(at);
  if (urlPath.includes('..') || !fs.existsSync(path.join(uploadsDir, urlPath.slice('/uploads/'.length)))) return null;
  return publicBase ? `${publicBase}${urlPath}` : urlPath;
};

await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${mongoose.connection.name}${PAUSE_LEGACY ? ' (+ pause legacy)' : ''}`);

const cars = await Vehicle.find({ icon_types: { $in: ['car', 'suv', 'premium'] } }).select('name icon_types image').lean();
const iconUrl = cars.map((v) => serverImageUrl(v.image)).find(Boolean) || null;
const coverUrl = cars.filter((v) => /suv|premium|xl/i.test(`${v.name} ${v.icon_types}`)).map((v) => serverImageUrl(v.image)).find(Boolean) || iconUrl;
console.log('image from server for icon/cover:', iconUrl || 'NONE FOUND', '/', coverUrl || 'NONE FOUND');

const DESCRIPTION = 'Going the same way? Share a cab with other riders and pay only for your seat.';
const modules = await TaxiAppModule.find({ service_type: 'pooling' });
if (!modules.length) {
  console.log('Car Pooling module: none exists, will create');
  if (APPLY) {
    const last = await TaxiAppModule.findOne().sort({ order_by: -1 }).select('order_by').lean();
    await TaxiAppModule.create({
      name: 'Car Pooling', transport_type: 'taxi', service_type: 'pooling', active: 1, order_by: (last?.order_by || 0) + 1,
      short_description: 'Share a ride, split the fare', description: DESCRIPTION,
      mobile_menu_icon: iconUrl || '', mobile_menu_cover_image: coverUrl || null,
    });
  }
}
for (const item of modules) {
  const set = {};
  if (!item.mobile_menu_icon && iconUrl) set.mobile_menu_icon = iconUrl;
  if (!item.mobile_menu_cover_image && coverUrl) set.mobile_menu_cover_image = coverUrl;
  if (!item.description) set.description = DESCRIPTION;
  if (!item.short_description) set.short_description = 'Share a ride, split the fare';
  console.log(`module "${item.name}" (${item._id}):`, Object.keys(set).length ? `will set ${Object.keys(set).join(', ')}` : 'already complete');
  if (APPLY && Object.keys(set).length) await TaxiAppModule.updateOne({ _id: item._id }, { $set: set });
}

if (PAUSE_LEGACY) {
  const routes = await PoolingRoute.countDocuments({ routeCode: /^RZPOOL-/, status: { $ne: 'paused' } });
  const vehicles = await PoolingVehicle.countDocuments({ vehicleNumber: /^RZPOOL-/, status: { $ne: 'inactive' } });
  console.log(`legacy demo data: ${routes} routes and ${vehicles} vehicles to pause`);
  if (APPLY) {
    await PoolingRoute.updateMany({ routeCode: /^RZPOOL-/ }, { $set: { status: 'paused' } });
    await PoolingVehicle.updateMany({ vehicleNumber: /^RZPOOL-/ }, { $set: { status: 'inactive', poolingEnabled: false } });
  }
}

console.log(APPLY ? 'Done.' : 'Dry run only, nothing written.');
await mongoose.disconnect();
process.exit(0);
