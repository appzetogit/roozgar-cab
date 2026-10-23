/**
 * Demo data, part 3 (run after seedDemoCore.js): ~140 rides spread over the
 * last 30 days between the demo users and drivers, so trips, earnings, ratings
 * and the dashboard have numbers. Skips when demo rides already exist, so it is
 * safe to re-run. DRY_RUN=1 validates without writing.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { env } = await import('../src/config/env.js');
const { Ride } = await import('../src/modules/taxi/user/models/Ride.js');
const { User } = await import('../src/modules/taxi/user/models/User.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { SetPrice } = await import('../src/modules/taxi/admin/models/SetPrice.js');

const DRY = process.env.DRY_RUN === '1';
const rnd = (seed) => { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); };
const PLACES = {
  Indore: [['Vijay Nagar Square', 22.7533, 75.8937], ['Rajwada Palace', 22.7196, 75.8577], ['Palasia Square', 22.7244, 75.8839], ['Sarafa Bazaar', 22.7185, 75.8553], ['Bhawarkua Square', 22.6945, 75.8683], ['Treasure Island Mall', 22.7239, 75.8838], ['Indore Railway Station', 22.7196, 75.8686], ['Meghdoot Garden', 22.7518, 75.8924]],
  Hyderabad: [['Bahadurpura Crossroads', 17.3487, 78.4569], ['Charminar', 17.3616, 78.4747], ['Nehru Zoological Park', 17.3507, 78.4515], ['Falaknuma Palace', 17.3314, 78.4673], ['Mir Alam Tank', 17.3426, 78.4503], ['Kishanbagh', 17.3412, 78.4628], ['Salar Jung Museum', 17.3713, 78.4804], ['Purani Haveli', 17.3601, 78.4753]],
};
const REASONS = ['Driver is too far away', 'Changed my plans', 'Booked by mistake', 'Waiting for too long'];
const COMMENTS = ['Smooth ride, polite driver.', 'On time and clean cab.', 'Great experience!', 'Driver knew the route well.', 'Good value for money.', ''];

const hav = (a, b) => {
  const R = 6371; const t = (d) => (d * Math.PI) / 180;
  const dLat = t(b[1] - a[1]); const dLng = t(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(t(a[1])) * Math.cos(t(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const run = async () => {
  if (!DRY) await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
  const users = DRY ? [] : await User.find({ phone: /^97700/ }).lean();
  const drivers = DRY ? [] : await Driver.find({ phone: /^96600/ }).lean();
  if (!DRY) {
    if (!users.length || !drivers.length) throw new Error('run seedDemoCore.js first');
    if (await Ride.exists({ userId: { $in: users.map((u) => u._id) } })) {
      console.log('Demo rides already present - skipping.');
      await mongoose.disconnect();
      return;
    }
  }
  const prices = DRY ? [] : await SetPrice.find({ pricing_scope: 'ride' }).lean();
  const now = Date.now();
  const docs = [];
  const N = 140;
  for (let i = 0; i < N; i++) {
    const city = i % 2 === 0 ? 'Indore' : 'Hyderabad';
    const cityUsers = users.filter((u) => u.addresses?.[0]?.city === city);
    const cityDrivers = drivers.filter((d) => d.city === city);
    const user = cityUsers[i % Math.max(cityUsers.length, 1)];
    const driver = cityDrivers[(i * 3) % Math.max(cityDrivers.length, 1)];
    if (!user || !driver) continue;
    const places = PLACES[city];
    const a = places[i % places.length]; const b = places[(i * 5 + 3) % places.length === i % places.length ? (i + 1) % places.length : (i * 5 + 3) % places.length];
    const km = Math.max(1.5, hav([a[2], a[1]], [b[2], b[1]]) * 1.3);
    const price = prices.find((p) => String(p.vehicle_type) === String(driver.vehicleTypeId) && String(p.service_location_id) === String(driver.service_location_id));
    const baseP = price?.base_price ?? 60; const perKm = price?.price_per_distance ?? 14; const free = price?.base_distance ?? 2;
    const fare = Math.round(baseP + Math.max(0, km - free) * perKm);
    const created = new Date(now - (i % 30) * 86400000 - Math.floor(rnd(i) * 12 * 3600000) - 3600000);
    const mins = Math.round(km * 3 + 4);
    const roll = rnd(i + 500);
    const status = i < 3 ? 'ongoing' : roll < 0.1 ? 'cancelled' : 'completed';
    const commission = Math.round(fare * 0.1);
    const base = {
      userId: user._id, driverId: driver._id, vehicleTypeId: driver.vehicleTypeId, vehicleIconType: driver.vehicleIconType || 'car',
      bookingSource: 'app', serviceType: 'ride', service_location_id: driver.service_location_id, transport_type: 'taxi',
      pickupLocation: { type: 'Point', coordinates: [a[2], a[1]] }, pickupAddress: `${a[0]}, ${city}`,
      dropLocation: { type: 'Point', coordinates: [b[2], b[1]] }, dropAddress: `${b[0]}, ${city}`,
      fare, baseFare: fare, estimatedDistanceMeters: Math.round(km * 1000), estimatedDurationMinutes: mins,
      paymentMethod: i % 3 === 0 ? 'online' : 'cash', otp: String(1000 + ((i * 37) % 9000)), createdAt: created, updatedAt: created,
    };
    let ride;
    if (status === 'completed') {
      const accepted = new Date(created.getTime() + 40000); const started = new Date(created.getTime() + 6 * 60000); const done = new Date(started.getTime() + mins * 60000);
      ride = { ...base, status: 'completed', liveStatus: 'completed', acceptedAt: accepted, arrivedAt: new Date(created.getTime() + 5 * 60000), startedAt: started, completedAt: done,
        commissionAmount: commission, driverEarnings: fare - commission, collectedVia: base.paymentMethod === 'online' ? 'online' : 'cash',
        feedback: rnd(i + 900) < 0.8 ? { rating: 4 + Math.round(rnd(i + 901)), comment: COMMENTS[i % COMMENTS.length], tipAmount: 0, submittedAt: done } : undefined };
    } else if (status === 'cancelled') {
      ride = { ...base, status: 'cancelled', liveStatus: 'cancelled', cancelledBy: i % 2 ? 'user' : 'driver', cancelReason: REASONS[i % REASONS.length], cancelledAt: new Date(created.getTime() + 3 * 60000) };
    } else {
      const started = new Date(now - 8 * 60000);
      ride = { ...base, createdAt: new Date(now - 15 * 60000), updatedAt: new Date(), status: 'ongoing', liveStatus: 'started', acceptedAt: new Date(now - 13 * 60000), startedAt: started };
    }
    const probe = new Ride(ride);
    const err = probe.validateSync();
    if (err) throw new Error(`ride invalid: ${Object.values(err.errors).map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    docs.push(ride);
  }
  if (DRY) { console.log('DRY RUN: nothing to validate without DB users; schema loads fine.'); return; }
  // Insert straight into the collection so the backdated createdAt is kept.
  await Ride.collection.insertMany(docs.map((d) => ({ ...new Ride(d).toObject({ depopulate: true }), createdAt: d.createdAt, updatedAt: d.updatedAt })));
  const by = docs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  console.log('Seeded rides:', docs.length, JSON.stringify(by));
  await mongoose.disconnect();
};

run().catch((e) => { console.error('seed failed:', e.message); process.exit(1); });
