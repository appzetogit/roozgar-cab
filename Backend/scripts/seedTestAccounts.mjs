/**
 * Creates two test accounts on a database: a rider (1111111111) and an APPROVED car driver (2222222222), so the
 * rider and driver apps can be opened without going through registration. Dry run unless --apply; running it again
 * changes nothing (an existing phone is left alone).
 *
 *   node scripts/seedTestAccounts.mjs            show what it would do
 *   node scripts/seedTestAccounts.mjs --apply    do it
 *
 * Login is by OTP, and an SMS cannot reach these numbers: add them to DEMO_LOGIN_PHONES (phone:otp) to log in.
 * The accounts are plainly named "Test ..." so they are easy to find and delete.
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { User } from '../src/modules/taxi/user/models/User.js';
import { Driver } from '../src/modules/taxi/driver/models/Driver.js';
import { Vehicle } from '../src/modules/taxi/admin/models/Vehicle.js';
import { ServiceLocation } from '../src/modules/taxi/admin/models/ServiceLocation.js';
import { Zone } from '../src/modules/taxi/driver/models/Zone.js';
import { hashPassword } from '../src/modules/taxi/services/passwordService.js';

const APPLY = process.argv.includes('--apply');
const RIDER_PHONE = '1111111111';
const DRIVER_PHONE = '2222222222';

await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${mongoose.connection.name}`);

// The password is never used (login is by OTP); a random one keeps the field filled.
const randomPassword = () => hashPassword(crypto.randomBytes(24).toString('hex'));

// ---- rider
const existingUser = await User.findOne({ phone: RIDER_PHONE }).lean();
if (existingUser) {
  console.log(`rider ${RIDER_PHONE}: already exists (${existingUser.name})`);
} else {
  console.log(`rider ${RIDER_PHONE}: will create "Test Rider"`);
  if (APPLY) {
    await User.create({
      phone: RIDER_PHONE, countryCode: '+91', name: 'Test Rider', gender: 'male',
      password: await randomPassword(), isVerified: true, isActive: true, active: true, role: 'USER',
      referralCode: 'USR1111TEST1',
    });
  }
}

// ---- driver: a car driver in Indore on the Sedan type, approved
const existingDriver = await Driver.findOne({ phone: DRIVER_PHONE }).lean();
if (existingDriver) {
  console.log(`driver ${DRIVER_PHONE}: already exists (${existingDriver.name}, approve=${existingDriver.approve})`);
} else {
  const location = await ServiceLocation.findOne({ name: /indore/i }).select('_id name').lean()
    || await ServiceLocation.findOne({ service_location_name: /indore/i }).select('_id').lean();
  const zone = location ? await Zone.findOne({ service_location_id: location._id, name: /indore/i }).select('_id name').lean() : null;
  const sedan = await Vehicle.findOne({ name: /sedan/i, transport_type: 'taxi', active: { $ne: false } }).select('_id name icon_types').lean();
  console.log(`driver ${DRIVER_PHONE}: will create "Test Driver" (car, ${sedan ? `${sedan.name} [${sedan._id}]` : "NO SEDAN TYPE FOUND"}, zone ${zone?.name || 'NONE'})`);
  if (!sedan || !location) throw new Error('Indore location or Sedan vehicle type not found; nothing created');

  if (APPLY) {
    const now = new Date();
    await Driver.create({
      name: 'Test Driver', phone: DRIVER_PHONE, email: 'test.driver@roozgarcab.com', gender: 'male',
      password: await randomPassword(),
      approve: true, status: 'approved', isOnline: false, isOnRide: false,
      vehicleType: 'car', vehicleIconType: sedan.icon_types || 'car', vehicleTypeId: sedan._id, vehicleTypeIds: [sedan._id],
      vehicleMake: 'Maruti', vehicleModel: 'Dzire', vehicleNumber: 'MP09TS2222', vehicleColor: 'White',
      registerFor: 'taxi', serviceCategories: ['taxi'], city: 'Indore',
      service_location_id: location._id, zoneId: zone?._id || null,
      location: { type: 'Point', coordinates: [75.8577, 22.7196] },
      referralCode: 'DRV2222TEST1',
      onboarding: {
        registrationId: crypto.randomUUID(), role: 'driver', verifiedAt: now, submittedAt: now,
        personal: { fullName: 'Test Driver', email: 'test.driver@roozgarcab.com', gender: 'male' },
        vehicle: {
          registerFor: 'taxi', serviceCategories: ['taxi'], locationId: String(location._id), locationName: 'Indore',
          vehicleTypeId: String(sedan._id), vehicleTypeIds: [String(sedan._id)], rcNumber: 'MP09TS2222',
          make: 'Maruti', model: 'Dzire', year: '2020', number: 'MP09TS2222', color: 'White', city: 'Indore',
        },
      },
    });
  }
}

console.log(APPLY ? '\nDone.' : '\nDry run only, nothing written.');
await mongoose.disconnect();
process.exit(0);
