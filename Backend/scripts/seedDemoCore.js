/**
 * Demo data, part 1: service locations, zones, vehicle types, prices, owners,
 * fleet vehicles, users and drivers. Everything is approved/active.
 *
 * Idempotent: records are matched on a natural key (phone, email, plate, name)
 * so re-running updates instead of duplicating. Images are the files uploaded to
 * <UPLOAD_DIR>/roozgarcab/seed and served by nginx at /uploads/roozgarcab/seed.
 *
 * Usage:  node scripts/seedDemoCore.js            (writes)
 *         DRY_RUN=1 node scripts/seedDemoCore.js  (validates only, no DB writes)
 *
 * Demo logins: every seeded owner/driver/user password is DEMO_PASSWORD
 * (default "Demo@12345").
 */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { env } = await import('../src/config/env.js');
const { ServiceLocation } = await import('../src/modules/taxi/admin/models/ServiceLocation.js');
const { Zone } = await import('../src/modules/taxi/driver/models/Zone.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { SetPrice } = await import('../src/modules/taxi/admin/models/SetPrice.js');
const { Owner } = await import('../src/modules/taxi/admin/models/Owner.js');
const { FleetVehicle } = await import('../src/modules/taxi/admin/models/FleetVehicle.js');
const { User } = await import('../src/modules/taxi/user/models/User.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');

const DRY = process.env.DRY_RUN === '1';
const PASSWORD = process.env.DEMO_PASSWORD || 'Demo@12345';
const BASE = String(env.publicBackendUrl || 'https://roozgarcab.com').replace(/\/+$/, '');
const img = (group, name) => `${BASE}/uploads/roozgarcab/seed/${group}/${name}.webp`;

// ---------------------------------------------------------------- places
const CITIES = {
  indore: {
    name: 'Indore', state: 'Madhya Pradesh', address: 'Indore, Madhya Pradesh, India',
    lat: 22.7196, lng: 75.8577, zoneName: 'Indore City Zone', half: 0.09, zip: '452001',
    areas: ['Vijay Nagar', 'Palasia', 'Rajwada', 'Bhawarkua', 'Sapna Sangeeta', 'Geeta Bhawan', 'Annapurna', 'Saket Nagar'],
    plate: 'MP09', rto: 'RTO Indore',
  },
  hyderabad: {
    name: 'Hyderabad', state: 'Telangana', address: 'Bahadurpura, Hyderabad, Telangana, India',
    lat: 17.3487, lng: 78.4569, zoneName: 'Bahadurpura Zone', half: 0.025, zip: '500064',
    areas: ['Bahadurpura', 'Charminar', 'Nehru Zoological Park Road', 'Falaknuma', 'Chandrayangutta', 'Mir Alam Tank', 'Kishanbagh', 'Purani Haveli'],
    plate: 'TS09', rto: 'RTO Hyderabad South',
  },
};

const square = (lat, lng, half) => [[
  [lng - half, lat - half], [lng + half, lat - half], [lng + half, lat + half], [lng - half, lat + half], [lng - half, lat - half],
]];
const jitter = (n, seed) => ((Math.sin(seed * 9301 + 49297) * 233280) % 1) * n;
const near = (c, seed, spread) => ({
  lat: +(c.lat + jitter(spread, seed)).toFixed(6),
  lng: +(c.lng + jitter(spread, seed + 7)).toFixed(6),
});

// ---------------------------------------------------------------- vehicle types
const VEHICLES = [
  { key: 'bike', name: 'Roozgar Bike', category: 'bike', icon_types: 'bike', capacity: 1, image: img('vehicles', '1_bike'), desc: 'Fast and cheap rides for one', base: 25, dist: 2, per: 8, time: 1, wait: 1 },
  { key: 'auto', name: 'Roozgar Auto', category: 'auto', icon_types: 'auto', capacity: 3, image: img('vehicles', 'auto'), desc: 'Metered autos for short city trips', base: 35, dist: 2, per: 12, time: 1, wait: 1.5 },
  { key: 'mini', name: 'Roozgar Mini', category: 'car', icon_types: 'car', capacity: 4, image: img('vehicles', 'hatchback'), desc: 'Compact hatchbacks, everyday low fares', base: 60, dist: 2, per: 13, time: 1.5, wait: 2 },
  { key: 'sedan', name: 'Roozgar Sedan (Dzire)', category: 'car', icon_types: 'car', capacity: 4, image: img('vehicles', 'dzire'), desc: 'Comfortable sedan for city and airport runs', base: 70, dist: 2, per: 15, time: 2, wait: 2 },
  { key: 'suv', name: 'Roozgar SUV (Ertiga)', category: 'car', icon_types: 'suv', capacity: 6, image: img('vehicles', 'ertiga'), desc: 'Spacious MUV for families and groups', base: 100, dist: 2, per: 19, time: 2, wait: 3 },
  { key: 'premium', name: 'Roozgar Premium (Innova Crysta)', category: 'car', icon_types: 'premium', capacity: 6, image: img('vehicles', 'innova-crysta'), desc: 'Premium SUV for outstation travel', base: 120, dist: 2, per: 22, time: 2.5, wait: 3 },
  { key: 'luxury', name: 'Roozgar Luxury (Fortuner)', category: 'car', icon_types: 'Luxary', capacity: 7, image: img('vehicles', 'fortuner'), desc: 'Luxury SUV for executive travel', base: 160, dist: 2, per: 28, time: 3, wait: 4 },
];

// ---------------------------------------------------------------- people
const MALE = ['Rahul Sharma', 'Amit Verma', 'Vikram Singh', 'Sandeep Patel', 'Rajesh Yadav', 'Manoj Tiwari', 'Deepak Joshi', 'Suresh Chauhan', 'Anil Gupta', 'Pankaj Mishra',
  'Mohammed Irfan', 'Syed Aslam', 'Abdul Rahman', 'Imran Khan', 'Mohammed Faisal', 'Shaik Nadeem', 'Mirza Danish', 'Arif Pasha', 'Naveen Reddy', 'Srinivas Rao',
  'Kiran Kumar', 'Ravi Teja', 'Harish Goud', 'Venkatesh Naidu', 'Ajay Thakur', 'Ramesh Malviya', 'Dinesh Solanki', 'Mukesh Rathore', 'Yogesh Pawar', 'Nitin Jain',
  'Sunil Dubey', 'Kamlesh Parmar', 'Ashok Chouhan', 'Gopal Dangi', 'Ritesh Soni', 'Saurabh Bhatia', 'Tarun Agrawal', 'Vivek Saxena', 'Faizan Ali', 'Zaid Qureshi'];
const FEMALE = ['Priya Sharma', 'Neha Verma', 'Anjali Patel', 'Pooja Yadav', 'Sneha Joshi', 'Kavita Chauhan', 'Ritu Gupta', 'Meena Mishra', 'Fatima Begum', 'Sana Khan',
  'Aisha Siddiqui', 'Lakshmi Reddy', 'Divya Rao', 'Swati Jain', 'Nikita Soni', 'Shreya Agrawal', 'Ayesha Pasha', 'Komal Thakur', 'Rekha Dubey', 'Isha Saxena'];

const phoneFor = (prefix, i) => `${prefix}${String(i).padStart(5, '0')}`; // 10 digits
const slug = (s) => s.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');

const CAR_MODELS = {
  bike: [['Honda', 'Activa 6G', 'White'], ['TVS', 'Jupiter', 'Grey'], ['Bajaj', 'Pulsar 150', 'Black'], ['Hero', 'Splendor Plus', 'Black']],
  auto: [['Bajaj', 'RE Compact', 'Yellow'], ['Piaggio', 'Ape City', 'Yellow']],
  mini: [['Maruti Suzuki', 'Swift', 'White'], ['Hyundai', 'Santro', 'Silver'], ['Tata', 'Tiago', 'Blue']],
  sedan: [['Maruti Suzuki', 'Dzire', 'White'], ['Hyundai', 'Aura', 'Silver'], ['Honda', 'Amaze', 'Grey']],
  suv: [['Maruti Suzuki', 'Ertiga', 'White'], ['Kia', 'Carens', 'Black']],
  premium: [['Toyota', 'Innova Crysta', 'White']],
  luxury: [['Toyota', 'Fortuner', 'Black']],
};

const DOC_DEFS = [
  { key: 'driving_licence', label: 'Driving Licence', file: 'driving-licence', number: (i, c) => `${c.plate}20210${String(40000 + i).slice(-5)}`, expiry: '2041-06-30' },
  { key: 'aadhaar_card', label: 'Aadhaar Card', file: 'aadhaar', number: (i) => `XXXX XXXX ${String(1000 + (i * 37) % 9000).slice(-4)}`, expiry: '' },
  { key: 'pan_card', label: 'PAN Card', file: 'pan-card', number: (i) => `ABCPD${String(1000 + (i * 13) % 9000).slice(-4)}K`, expiry: '' },
  { key: 'vehicle_rc', label: 'Vehicle RC', file: 'vehicle-rc', number: (i, c) => `${c.plate}CA${String(1000 + i).slice(-4)}`, expiry: '2036-03-31' },
  { key: 'insurance', label: 'Vehicle Insurance', file: 'insurance', number: (i) => `RC/2026/${884000 + i}`, expiry: '2027-08-31' },
  { key: 'permit', label: 'Taxi Permit', file: 'permit', number: (i) => `AIT/${55000 + i}`, expiry: '2031-04-30' },
];

const buildDocuments = (idx, city, when) =>
  Object.fromEntries(DOC_DEFS.map((d) => [d.key, {
    key: d.key,
    label: d.label,
    image: img('docs', d.file),
    images: [img('docs', d.file)],
    identify_number: d.number(idx, city),
    expiry_date: d.expiry,
    status: 'approved',
    uploadedAt: when,
    reviewedAt: when,
  }]));

const plateFor = (city, i) => `${city.plate} ${['CA', 'CB', 'CD', 'ZA', 'TA'][i % 5]} ${String(1000 + i * 7).slice(-4)}`;

// ---------------------------------------------------------------- run
const stats = {};
const bump = (k) => { stats[k] = (stats[k] || 0) + 1; };

const upsert = async (Model, filter, doc, label) => {
  const probe = new Model({ ...filter, ...doc });
  const err = probe.validateSync();
  if (err) throw new Error(`${label} invalid: ${Object.values(err.errors).map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  bump(label);
  if (DRY) return probe;
  return Model.findOneAndUpdate(filter, { $set: doc }, { new: true, upsert: true, setDefaultsOnInsert: true });
};

const run = async () => {
  if (!DRY) await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
  const hash = await bcrypt.hash(PASSWORD, 10);
  const now = new Date();
  const when = now.toISOString();

  // service locations + zones
  const locs = {}; const zones = {};
  for (const [key, c] of Object.entries(CITIES)) {
    locs[key] = await upsert(ServiceLocation, { name: c.name }, {
      service_location_name: c.name, address: c.address, country: 'India', latitude: c.lat, longitude: c.lng,
      location: { type: 'Point', coordinates: [c.lng, c.lat] }, status: 'active', active: true,
    }, 'serviceLocations');
    zones[key] = await upsert(Zone, { name: c.zoneName }, {
      service_location_id: locs[key]._id, unit: 'km', boundary_mode: 'polygon', status: 'active', active: true,
      peak_zone_ride_count: 10, peak_zone_radius: 3, peak_zone_selection_duration: 30, peak_zone_duration: 60, peak_zone_surge_percentage: 20,
      maximum_distance_for_regular_rides: 60, maximum_distance_for_outstation_rides: 600,
      geometry: { type: 'Polygon', coordinates: square(c.lat, c.lng, c.half) },
    }, 'zones');
  }

  // vehicle types
  const veh = {};
  for (const v of VEHICLES) {
    veh[v.key] = await upsert(Vehicle, { name: v.name }, {
      short_description: v.desc, description: v.desc, transport_type: 'taxi', dispatch_type: 'both', icon_types: v.icon_types,
      category: v.category, capacity: v.capacity, is_taxi: 'taxi', is_accept_share_ride: v.capacity >= 4 ? 1 : 0,
      service_tax: 5, admin_commission_type_from_driver: 1, admin_commission_from_driver: 10,
      admin_commission_type_for_owner: 1, admin_commission_for_owner: 10,
      image: v.image, icon: v.image, map_icon: v.image, status: 1, active: true,
    }, 'vehicleTypes');
  }

  // set prices (zone x vehicle)
  for (const key of Object.keys(CITIES)) {
    for (const v of VEHICLES) {
      await upsert(SetPrice, { zone_id: zones[key]._id, vehicle_type: veh[v.key]._id, pricing_scope: 'ride' }, {
        service_location_id: locs[key]._id, transport_type: 'taxi', payment_type: 'cash,online',
        base_price: v.base, base_distance: v.dist, price_per_distance: v.per, time_price: v.time, waiting_charge: v.wait,
        free_waiting_before: 3, free_waiting_after: 3,
        outstation_base_price: v.base * 3, outstation_base_distance: 10, outstation_price_per_distance: v.per + 4, outstation_time_price: v.time,
        enable_airport_ride: true, enable_outstation_ride: true, support_airport_fee: true, support_outstation: true,
        user_cancellation_fee_type: 'fixed', user_cancellation_fee: 20, driver_cancellation_fee_type: 'fixed', driver_cancellation_fee: 30,
        cancellation_fee_goes_to: 'driver', service_tax: 5, status: 'active', active: true,
      }, 'setPrices');
    }
  }

  // owners (3 per city) + fleet vehicles (2 each)
  const OWNER_NAMES = {
    indore: ['Malwa Travels', 'Holkar Cabs', 'Patalpani Tours'],
    hyderabad: ['Charminar Cabs', 'Nizam Travels', 'Deccan Fleet'],
  };
  const owners = []; // { doc, cityKey, fleet: [] }
  let oi = 0; let fi = 0;
  for (const [key, c] of Object.entries(CITIES)) {
    for (const companyName of OWNER_NAMES[key]) {
      oi += 1;
      const person = MALE[(oi * 3) % MALE.length];
      const [first, ...rest] = person.split(' ');
      const mobile = phoneFor('98100', oi);
      const o = await upsert(Owner, { mobile }, {
        company_name: companyName, owner_name: person, name: first, surname: rest.join(' '),
        email: `${slug(companyName)}@roozgarcab-demo.in`, password: hash, service_location_id: locs[key]._id,
        transport_type: 'taxi', phone: mobile, address: `${c.areas[oi % c.areas.length]}, ${c.name}`, postal_code: c.zip, city: c.name,
        no_of_vehicles: 2, tax_number: `${key === 'indore' ? '23' : '36'}ABCPD${1000 + oi}K1Z5`,
        bank_name: 'State Bank of India', ifsc: 'SBIN0001234', account_no: `3012${String(900000 + oi * 137).slice(-6)}00`,
        active: true, approve: true, status: 'approved', wallet: { balance: 2500 + oi * 500 },
      }, 'owners');
      const fleet = [];
      for (let k = 0; k < 2; k++) {
        fi += 1;
        const vkey = ['sedan', 'mini', 'suv', 'sedan', 'premium', 'sedan'][(fi + k) % 6];
        const [brand, model, color] = CAR_MODELS[vkey][fi % CAR_MODELS[vkey].length];
        const plate = plateFor(c, 300 + fi);
        const fv = await upsert(FleetVehicle, { license_plate_number: plate }, {
          owner_id: o._id, service_location_id: locs[key]._id, transport_type: 'taxi', vehicle_type_id: veh[vkey]._id,
          car_brand: brand, car_model: model, car_color: color,
          documents: { vehicle_rc: { image: img('docs', 'vehicle-rc'), status: 'approved' }, insurance: { image: img('docs', 'insurance'), status: 'approved' } },
          status: 'approved', active: true,
        }, 'fleetVehicles');
        fleet.push({ doc: fv, vkey, brand, model, color, plate });
      }
      owners.push({ doc: o, cityKey: key, fleet });
    }
  }

  // users: 15 per city
  let ui = 0;
  for (const [key, c] of Object.entries(CITIES)) {
    for (let n = 0; n < 15; n++) {
      ui += 1;
      const male = n % 3 !== 2;
      const name = male ? MALE[(ui + 20) % MALE.length] : FEMALE[ui % FEMALE.length];
      const pic = male ? `m${(ui % 40) + 1}` : `w${(ui % 20) + 1}`;
      const phone = phoneFor('97700', ui);
      const area = c.areas[n % c.areas.length];
      const p = near(c, ui, 0.04);
      await upsert(User, { phone }, {
        countryCode: '+91', name, email: `${slug(name)}${ui}@example.com`, password: hash, gender: male ? 'male' : 'female',
        profileImage: img('portraits', pic), isVerified: true, isActive: true, active: true, role: 'USER',
        dateOfBirth: new Date(1982 + (ui % 20), ui % 12, 1 + (ui % 27)),
        referralCode: `RZ${String(ui).padStart(4, '0')}${name.slice(0, 2).toUpperCase()}`,
        addresses: [{
          label: 'Home', street: `${10 + ui}, ${area}`, city: c.name, state: c.state, zipCode: c.zip, isDefault: true,
          location: { type: 'Point', coordinates: [p.lng, p.lat] },
        }],
      }, 'users');
    }
  }

  // drivers: 14 per city (6 fleet drivers attached to owner vehicles, 8 independent)
  let di = 0;
  for (const [key, c] of Object.entries(CITIES)) {
    const cityOwners = owners.filter((o) => o.cityKey === key);
    const fleetSlots = cityOwners.flatMap((o) => o.fleet.map((f) => ({ owner: o.doc, f })));
    for (let n = 0; n < 14; n++) {
      di += 1;
      const male = n % 7 !== 6;
      const name = male ? MALE[di % MALE.length] : FEMALE[(di + 5) % FEMALE.length];
      const pic = male ? `m${((di + 11) % 40) + 1}` : `w${((di + 3) % 20) + 1}`;
      const phone = phoneFor('96600', di);
      const slot = n < fleetSlots.length ? fleetSlots[n] : null;
      const vkey = slot ? slot.f.vkey : ['bike', 'auto', 'mini', 'sedan', 'sedan', 'suv', 'bike', 'auto'][(n - fleetSlots.length) % 8];
      const [brand, model, color] = slot ? [slot.f.brand, slot.f.model, slot.f.color] : CAR_MODELS[vkey][di % CAR_MODELS[vkey].length];
      const plate = slot ? slot.f.plate : plateFor(c, di);
      const vt = VEHICLES.find((x) => x.key === vkey);
      const p = near(c, di + 100, 0.03);
      const online = di % 3 !== 0;
      const rides = 40 + ((di * 53) % 400);
      await upsert(Driver, { phone }, {
        name, email: `${slug(name)}${di}@example.com`, password: hash, gender: male ? 'male' : 'female',
        profile_picture: img('portraits', pic), profileImage: img('portraits', pic),
        owner_id: slot ? slot.owner._id : null, assignedFleetVehicleId: slot ? slot.f.doc._id : null,
        service_location_id: locs[key]._id, country: 'India',
        vehicleType: vt.category, vehicleTypeId: veh[vkey]._id, vehicleTypeIds: [veh[vkey]._id], vehicleIconType: vt.icon_types,
        vehicleMake: brand, vehicleModel: model, vehicleNumber: plate, vehicleColor: color, vehicleImage: vt.image,
        city: c.name, zoneId: zones[key]._id, approve: true, status: 'approved',
        rating: +(4.2 + ((di * 7) % 8) / 10).toFixed(1), ratingCount: rides, totalRatingScore: +(rides * 4.6).toFixed(0),
        isOnline: online, isOnRide: false,
        wallet: { balance: 300 + ((di * 91) % 2500), cashLimit: 500, isBlocked: false },
        bankDetails: { accountHolderName: name, upiId: `${slug(name).replace(/\./g, '')}@oksbi` },
        referralCode: `DRV${String(di).padStart(4, '0')}`,
        location: { type: 'Point', coordinates: [p.lng, p.lat] },
        documents: buildDocuments(di, c, when),
        onboarding: { completed: true, role: slot ? 'fleet_driver' : 'driver' },
      }, 'drivers');
    }
  }

  console.log(DRY ? 'DRY RUN (validated, nothing written):' : 'Seeded:', JSON.stringify(stats));
  if (!DRY) await mongoose.disconnect();
};

run().catch((e) => { console.error('seed failed:', e.message); process.exit(1); });
