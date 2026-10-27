/**
 * Seed starter Car Pooling data for every zone that has a known city.
 *
 *   node scripts/seedCarPooling.mjs            dry run: prints the plan, writes nothing
 *   node scripts/seedCarPooling.mjs --apply    writes it
 *   node scripts/seedCarPooling.mjs --remove   deletes everything this script created
 *
 * What it creates:
 *  - the "Car Pooling" home module (service_type pooling), if none exists
 *  - per zone city: 2 admin-owned pooling vehicles (sedan 4 seats, SUV 6 seats)
 *  - routes between each zone city and nearby cities, both directions, with
 *    pickup/drop stops and three daily departures
 * Vehicle images are reused from vehicle types already stored on this server
 * (under /uploads); nothing is fetched from outside.
 *
 * Safe to re-run: records are matched on vehicleNumber / routeCode and an
 * existing one is left exactly as the admin edited it. Everything it creates
 * carries the RZPOOL prefix, which is how --remove finds it. Bookings are never
 * created or touched.
 *
 * shortcut: fares, distances and stop coordinates are approximate starter
 * values, and a zone whose name matches no city below is skipped (reported at
 * the end); tune both in the admin panel or add the city to CITIES.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Zone } from '../src/modules/taxi/driver/models/Zone.js';
import { Vehicle } from '../src/modules/taxi/admin/models/Vehicle.js';
import { TaxiAppModule } from '../src/modules/taxi/admin/models/TaxiAppModule.js';
import { PoolingRoute } from '../src/modules/taxi/admin/models/PoolingRoute.js';
import { PoolingVehicle } from '../src/modules/taxi/admin/models/PoolingVehicle.js';
import { PoolingBooking } from '../src/modules/taxi/admin/models/PoolingBooking.js';

const PREFIX = 'RZPOOL';
const APPLY = process.argv.includes('--apply');
const REMOVE = process.argv.includes('--remove');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// code is used in vehicle numbers and route codes. A zone is matched to the
// first city whose `zone` pattern hits its name.
const CITIES = {
  IND: {
    name: 'Indore', zone: /indore/i, lat: 22.7196, lng: 75.8577,
    stops: [
      { name: 'Rajwada', address: 'Rajwada, Indore', lat: 22.7183, lng: 75.8553 },
      { name: 'Vijay Nagar', address: 'Vijay Nagar Square, Indore', lat: 22.7533, lng: 75.8937 },
      { name: 'Indore Airport', address: 'Devi Ahilya Bai Holkar Airport, Indore', lat: 22.7217, lng: 75.8011 },
    ],
  },
  HYD: {
    name: 'Hyderabad', zone: /hyderabad|bahadurpura/i, lat: 17.385, lng: 78.4867,
    stops: [
      { name: 'Secunderabad Station', address: 'Secunderabad Railway Station, Hyderabad', lat: 17.4337, lng: 78.5016 },
      { name: 'MGBS', address: 'Mahatma Gandhi Bus Station, Hyderabad', lat: 17.3786, lng: 78.4867 },
      { name: 'HITEC City', address: 'HITEC City, Hyderabad', lat: 17.4435, lng: 78.3772 },
    ],
  },
  BID: {
    name: 'Bidar', zone: /bidar/i, lat: 17.914, lng: 77.519,
    stops: [
      { name: 'Bidar Bus Stand', address: 'Central Bus Stand, Bidar', lat: 17.9139, lng: 77.5209 },
      { name: 'Bidar Fort', address: 'Bidar Fort, Bidar', lat: 17.9208, lng: 77.5297 },
    ],
  },
  KLB: {
    name: 'Kalaburagi', zone: /kalaburagi|gulbarga/i, lat: 17.3297, lng: 76.8343,
    stops: [
      { name: 'Kalaburagi Bus Stand', address: 'Central Bus Stand, Kalaburagi', lat: 17.3322, lng: 76.8376 },
      { name: 'Kalaburagi Railway Station', address: 'Railway Station, Kalaburagi', lat: 17.3262, lng: 76.8296 },
    ],
  },
};

// Other end of each route. `from` lists zone cities that run it; fare is per seat.
const PAIRS = [
  { a: 'IND', b: { name: 'Ujjain', lat: 23.1765, lng: 75.7885, stop: 'Ujjain Bus Stand' }, km: 55, fare: 150 },
  { a: 'IND', b: { name: 'Dewas', lat: 22.9676, lng: 76.0534, stop: 'Dewas Bus Stand' }, km: 40, fare: 110 },
  { a: 'IND', b: { name: 'Bhopal', lat: 23.2599, lng: 77.4126, stop: 'Bhopal ISBT' }, km: 190, fare: 450 },
  { a: 'HYD', b: { name: 'Warangal', lat: 17.9689, lng: 79.5941, stop: 'Warangal Bus Stand' }, km: 150, fare: 350 },
  { a: 'HYD', b: { name: 'Vijayawada', lat: 16.5062, lng: 80.648, stop: 'Vijayawada Bus Stand' }, km: 275, fare: 600 },
  { a: 'HYD', b: 'BID', km: 140, fare: 320 },
  { a: 'HYD', b: 'KLB', km: 270, fare: 580 },
  { a: 'BID', b: 'KLB', km: 125, fare: 290 },
  { a: 'KLB', b: { name: 'Solapur', lat: 17.6599, lng: 75.9064, stop: 'Solapur Bus Stand' }, km: 160, fare: 360 },
];

const DEPARTURES = ['06:00', '12:00', '17:30'];
const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const VEHICLES = [
  { key: 'S', name: 'Maruti Dzire', model: 'Dzire VXi', type: 'sedan', capacity: 4, grid: [3, 2], color: 'White', match: /sedan|dzire/i },
  { key: 'X', name: 'Maruti Ertiga', model: 'Ertiga ZXi', type: 'suv', capacity: 6, grid: [4, 2], color: 'Silver', match: /suv|ertiga/i },
];

// Same seat grid the admin vehicle form generates: driver, a gap beside them, then seats.
const blueprintFor = ([rows, cols]) => {
  const layout = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      layout.push({ r, c, type: r === 0 && c === 0 ? 'driver' : r === 0 && c === 1 ? 'empty' : 'seat' });
    }
  }
  return { rows, cols, layout };
};

const addMinutes = (hhmm, minutes) => {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

const uploadsDir = env.uploads.dir ? path.resolve(env.uploads.dir) : path.join(__dirname, '../uploads');
const publicBase = String(env.publicBackendUrl || '').replace(/\/+$/, '');

// A stored vehicle image counts only if its file is really on this server.
const serverImageUrl = (value) => {
  const text = String(value || '');
  const at = text.indexOf('/uploads/');
  if (at === -1) return null;
  const urlPath = text.slice(at);
  if (urlPath.includes('..') || !fs.existsSync(path.join(uploadsDir, urlPath.slice('/uploads/'.length)))) return null;
  return publicBase ? `${publicBase}${urlPath}` : urlPath;
};

const pickImage = (catalog, pattern) => {
  const hit = catalog.find((v) => pattern.test(`${v.name} ${v.icon_types || ''}`) && serverImageUrl(v.image)) ||
    catalog.find((v) => serverImageUrl(v.image));
  return hit ? serverImageUrl(hit.image) : null;
};

const stopOf = (id, s, stopType, sequence, etaMinutes) => ({
  id, name: s.name, address: s.address || s.name, landmark: s.name, stopType, sequence, etaMinutes,
  latitude: s.lat, longitude: s.lng,
});

await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
console.log(`${REMOVE ? 'REMOVE' : APPLY ? 'APPLY' : 'DRY RUN'} on ${mongoose.connection.name}`);

if (REMOVE) {
  const vehicles = await PoolingVehicle.find({ vehicleNumber: new RegExp(`^${PREFIX}-`) }).select('_id').lean();
  const ids = vehicles.map((v) => v._id);
  const booked = ids.length ? await PoolingBooking.countDocuments({ vehicle: { $in: ids } }) : 0;
  if (booked) {
    console.log(`Refusing to remove: ${booked} booking(s) exist on these vehicles. Cancel/archive them first.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const routes = await PoolingRoute.deleteMany({ routeCode: new RegExp(`^${PREFIX}-`) });
  const removed = await PoolingVehicle.deleteMany({ _id: { $in: ids } });
  console.log(`Removed ${routes.deletedCount} routes, ${removed.deletedCount} vehicles. The Car Pooling module is left in place.`);
  await mongoose.disconnect();
  process.exit(0);
}

const zones = await Zone.find({ active: { $ne: false } }).select('name').lean();
const catalog = await Vehicle.find().select('name icon_types image').lean();
const cityByZone = new Map();
const skipped = [];
for (const zone of zones) {
  const code = Object.keys(CITIES).find((key) => CITIES[key].zone.test(zone.name || ''));
  if (code) cityByZone.set(zone.name, code); else skipped.push(zone.name);
}
const activeCities = [...new Set(cityByZone.values())];
console.log('Zones -> city:', [...cityByZone].map(([z, c]) => `${z} -> ${CITIES[c].name}`).join('; ') || 'none');
console.log('Zones skipped (no city known):', skipped.join(', ') || 'none');

const images = Object.fromEntries(VEHICLES.map((v) => [v.key, pickImage(catalog, v.match)]));
console.log('Images from server:', VEHICLES.map((v) => `${v.type}=${images[v.key] || 'none found'}`).join('; '));

// Module
const moduleExists = await TaxiAppModule.exists({ service_type: 'pooling' });
console.log(moduleExists ? 'Car Pooling module: already exists' : 'Car Pooling module: will be created');
if (APPLY && !moduleExists) {
  const last = await TaxiAppModule.findOne().sort({ order_by: -1 }).select('order_by').lean();
  await TaxiAppModule.create({
    name: 'Car Pooling', transport_type: 'taxi', service_type: 'pooling', active: 1,
    order_by: (last?.order_by || 0) + 1, short_description: 'Share a ride, split the fare',
    description: 'Book a seat on a shared cab between cities.',
  });
}

// Vehicles
const vehiclesByCity = {};
let n = 0;
for (const code of activeCities) {
  vehiclesByCity[code] = [];
  for (const v of VEHICLES) {
    const vehicleNumber = `${PREFIX}-${code}-${v.key}1`;
    const doc = {
      name: v.name, vehicleModel: v.model, vehicleNumber, color: v.color, capacity: v.capacity,
      vehicleType: v.type, blueprint: blueprintFor(v.grid), images: images[v.key] ? [images[v.key]] : [],
      driverName: `${CITIES[code].name} Pool Driver ${v.key === 'S' ? 1 : 2}`,
      driverPhone: `90000${String(n + 1).padStart(5, '0')}`,
      approve: true, status: 'active', poolingEnabled: true, ownerId: null,
      adminCommissionPercentage: 10, ownerCommissionPercentage: 0, serviceTaxPercentage: 0,
    };
    n += 1;
    console.log(`  vehicle ${vehicleNumber} ${v.name} (${v.capacity} seats)`);
    vehiclesByCity[code].push(APPLY
      ? (await PoolingVehicle.findOneAndUpdate({ vehicleNumber }, { $setOnInsert: doc }, { upsert: true, new: true }))._id
      : vehicleNumber);
  }
}

// Routes, both directions
const routeDocs = [];
for (const pair of PAIRS) {
  const from = CITIES[pair.a];
  const toIsCity = typeof pair.b === 'string';
  const to = toIsCity ? CITIES[pair.b] : { ...pair.b, stops: [{ name: pair.b.stop, address: `${pair.b.stop}, ${pair.b.name}`, lat: pair.b.lat, lng: pair.b.lng }] };
  const outsideTag = (c) => String(c.name).slice(0, 3).toUpperCase();
  // tag names the end in the route code; fleet is the zone city whose cabs run it
  const ends = [
    { tag: pair.a, city: from, fleet: pair.a },
    toIsCity ? { tag: pair.b, city: to, fleet: pair.b } : { tag: outsideTag(to), city: to, fleet: pair.a },
  ];
  if (!vehiclesByCity[pair.a] || (toIsCity && !vehiclesByCity[pair.b])) continue; // no zone for an end of this pair
  const travelMinutes = Math.round((pair.km / 50) * 60);
  for (const [origin, dest] of [[ends[0], ends[1]], [ends[1], ends[0]]]) {
    const code = `${PREFIX}-${origin.tag}-${dest.tag}`;
    const fleet = vehiclesByCity[origin.fleet];
    routeDocs.push({
      routeName: `${origin.city.name} to ${dest.city.name}`, routeCode: code,
      originLabel: origin.city.name, destinationLabel: dest.city.name,
      description: `Shared cab from ${origin.city.name} to ${dest.city.name}, about ${pair.km} km.`,
      assignedVehicleTypeIds: fleet,
      pickupPoints: origin.city.stops.map((s, i) => stopOf(`pu-${code}-${i + 1}`, s, 'pickup', i + 1, i * 10)),
      dropPoints: dest.city.stops.map((s, i) => stopOf(`dr-${code}-${i + 1}`, s, 'drop', i + 1, travelMinutes + i * 5)),
      stops: [],
      schedules: DEPARTURES.map((dep, i) => ({
        id: `sch-${code}-${i + 1}`, label: `${dep} departure`, departureTime: dep,
        arrivalTime: addMinutes(dep, travelMinutes), activeDays: ALL_DAYS, status: 'active',
      })),
      farePerSeat: pair.fare, maxSeatsPerBooking: 3, maxAdvanceBookingHours: 72, boardingBufferMinutes: 15,
      poolingRules: { allowInstantBooking: true, allowLuggage: true, womenOnly: false, autoAssignNearestPickup: true, maxDetourKm: 5 },
      status: 'active', active: true,
    });
  }
}
for (const doc of routeDocs) {
  console.log(`  route ${doc.routeCode}: ${doc.routeName}, Rs ${doc.farePerSeat}/seat`);
  if (APPLY) await PoolingRoute.findOneAndUpdate({ routeCode: doc.routeCode }, { $setOnInsert: doc }, { upsert: true });
}

console.log(`\n${APPLY ? 'Done' : 'Dry run only, nothing written'}: ${activeCities.length} cities, ${n} vehicles, ${routeDocs.length} routes.`);
await mongoose.disconnect();
