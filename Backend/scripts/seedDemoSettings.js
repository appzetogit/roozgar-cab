/**
 * Demo data, part 4: admin Settings pages. Fills the User App Management
 * sections (with images), app modules, languages, user preferences, admin
 * roles, payment methods/gateways (names only, no keys), ride modules,
 * referral translations and the contact details in General Settings.
 * Idempotent. No payment/SMS/mail/Firebase secrets are written.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { env } = await import('../src/config/env.js');
const A = '../src/modules/taxi/admin';
const { AppLanguage } = await import(`${A}/models/AppLanguage.js`);
const { UserPreference } = await import(`${A}/models/UserPreference.js`);
const { AdminRole } = await import(`${A}/models/AdminRole.js`);
const { PaymentMethod } = await import(`${A}/models/PaymentMethod.js`);
const { PaymentGateway } = await import(`${A}/models/PaymentGateway.js`);
const { RideModule } = await import(`${A}/models/RideModule.js`);
const { ReferralTranslation } = await import(`${A}/models/ReferralTranslation.js`);
const { TaxiAppModule } = await import(`${A}/models/TaxiAppModule.js`);
const { createDefaultAppSettings } = await import(`${A}/data/defaultAppSettings.js`);

const BASE = String(env.publicBackendUrl || 'https://roozgarcab.com').replace(/\/+$/, '');
const img = (group, name) => `${BASE}/uploads/roozgarcab/seed/${group}/${name}.webp`;
const RIDE = '/taxi/user/ride/select-location';
const PARCEL = '/taxi/user/parcel/type';

const upsert = (Model, filter, doc) =>
  Model.findOneAndUpdate(filter, { $set: doc }, { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true });

const run = async () => {
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
  const db = mongoose.connection.db;
  const out = {};

  // ---- User App Management (promos are synced from Banners by the admin page itself)
  const userHome = {
    homeSections: { enableEverything: true, enableExplore: true, enablePromo: true, enableGoPlaces: true, enableFooter: true },
    everything: [
      { id: '1', title: 'Parcel', subtitle: 'Send anything', image: img('vehicles', '5_parcel'), route: PARCEL, order: 1, status: 'active' },
      { id: '2', title: 'Bike Taxi', subtitle: 'Beat the traffic', image: img('vehicles', '1_bike'), route: RIDE, order: 2, status: 'active' },
      { id: '3', title: 'Auto', subtitle: 'Metered auto rides', image: img('vehicles', '2_autorickshaw'), route: RIDE, order: 3, status: 'active' },
      { id: '4', title: 'Cab', subtitle: 'Your everyday rides', image: img('vehicles', '4_taxi'), route: RIDE, order: 4, status: 'active' },
      { id: '5', title: 'E-Rickshaw', subtitle: 'Eco-friendly short trips', image: img('vehicles', '3_e-rickshaw'), route: RIDE, order: 5, status: 'active' },
      { id: '6', title: 'Outstation', subtitle: 'One-way and round trips', image: img('app', 'outstation_service_icon'), route: RIDE, order: 6, status: 'active' },
    ],
    explore: [
      { id: '1', title: 'Parcel on Bike', image: img('vehicles', '5_parcel'), route: PARCEL, order: 1, status: 'active' },
      { id: '2', title: 'Auto', image: img('vehicles', '2_autorickshaw'), route: RIDE, order: 2, status: 'active' },
      { id: '3', title: 'Cab Economy', image: img('vehicles', 'hatchback'), route: RIDE, order: 3, status: 'active' },
      { id: '4', title: 'Bike', image: img('vehicles', '1_bike'), route: RIDE, order: 4, status: 'active' },
      { id: '5', title: 'Rentals', image: img('app', 'rental_service_icon'), route: RIDE, order: 5, status: 'active' },
    ],
    goPlaces: [
      { id: '1', title: 'Hassle-Free Airport Rides', image: img('app', 'airport_illustration'), route: RIDE, order: 1, status: 'active' },
      { id: '2', title: 'Quick Rides to Railway Station', image: img('app', 'train_station_illustration'), route: RIDE, order: 2, status: 'active' },
      { id: '3', title: 'Ride to Bus Terminal', image: img('vehicles', 'bus'), route: RIDE, order: 3, status: 'active' },
    ],
    footer: {
      hashtag: '#goRoozgarCab', line1: 'Made for India', line2: 'Crafted for riders',
      image: img('app', 'city_skyline_footer'), uploadedImage: img('app', 'home_footer_gemini'),
    },
  };
  await db.collection('taxiadminbusinesssettings').updateOne(
    { scope: 'default' },
    { $set: Object.fromEntries(Object.entries(userHome).map(([k, v]) => [`user_home_settings.${k}`, v])) },
  );
  out.userHome = Object.keys(userHome).length;

  // ---- General settings: replace the 0000000000 placeholders with usable demo contacts
  await db.collection('taxiadminbusinesssettings').updateOne(
    { scope: 'default', 'general.contact_phone_1': { $in: ['0000000000', '', null] } },
    { $set: { 'general.contact_phone_1': '9876543210', 'general.contact_phone_2': '9876543211', 'general.contact_booking_number': '9876543212', 'general.footer_1': '2026 © RoozgarCab.' } },
  );

  // ---- App modules live nested in the app-settings doc
  const modules = createDefaultAppSettings().app_modules.map((m, i) => ({ ...m, order_by: i + 1, active: true }));
  const cur = await db.collection('taxiadminappsettings').findOne({ scope: 'default' });
  if (!cur?.app_modules?.length) {
    await db.collection('taxiadminappsettings').updateOne({ scope: 'default' }, { $set: { app_modules: modules } });
    out.appModules = modules.length;
  }

  // The App Modules page lists the TaxiAppModule collection (the nested copy above is legacy).
  const MODULES = [
    ['City Ride', 'taxi', 'normal', 'Everyday rides inside the city', 'hatchback'],
    ['Airport Rides', 'taxi', 'normal', 'Pickups and drops at the airport', 'dzire'],
    ['Outstation', 'taxi', 'outstation', 'One-way and round trips between cities', 'innova-crysta'],
    ['Bike Taxi', 'taxi', 'normal', 'Fast bike rides', '1_bike'],
    ['Auto', 'taxi', 'normal', 'Metered auto rides', '2_autorickshaw'],
    ['Parcel Delivery', 'delivery', 'normal', 'Same-day parcel delivery', '5_parcel'],
  ];
  for (const [i, [name, transport_type, service_type, short_description, icon]] of MODULES.entries()) {
    await upsert(TaxiAppModule, { name }, {
      transport_type, service_type, order_by: i + 1, short_description, description: short_description,
      mobile_menu_icon: img('vehicles', icon), mobile_menu_cover_image: img('vehicles', icon), active: 1,
    });
  }
  out.taxiAppModules = MODULES.length;

  // ---- Standalone catalogs
  for (const [code, name, def] of [['en', 'English', 1], ['hi', 'Hindi', 0], ['te', 'Telugu', 0], ['ur', 'Urdu', 0], ['mr', 'Marathi', 0]]) {
    await upsert(AppLanguage, { code }, { name, active: 1, default_status: def });
  }
  out.languages = 5;

  for (const name of ['AC Cab', 'Pet Friendly', 'Child Seat', 'Female Driver', 'Extra Luggage Space', 'Wheelchair Accessible']) {
    await upsert(UserPreference, { name }, { icon: name.toLowerCase().replace(/[^a-z]+/g, '_'), active: 1 });
  }
  out.preferences = 6;

  const ROLES = [
    ['Super Admin', 'super-admin', 'Full access to every section', ['*']],
    ['Operations Manager', 'operations-manager', 'Trips, drivers, owners and zones', ['trips', 'drivers', 'owners', 'zones', 'dispatch']],
    ['Finance Manager', 'finance-manager', 'Payments, wallets and reports', ['payments', 'wallet', 'reports', 'withdrawals']],
    ['Support Agent', 'support-agent', 'Tickets, chat and users', ['support', 'users', 'chat']],
    ['Marketing Manager', 'marketing-manager', 'Promotions, banners and notifications', ['promotions', 'banners', 'notifications', 'cms']],
  ];
  for (const [name, slug, description, permissions] of ROLES) await upsert(AdminRole, { slug }, { name, description, permissions });
  out.roles = ROLES.length;

  const METHODS = [
    ['UPI', [{ type: 'text', name: 'upi_id', placeholder: 'name@bank', is_required: true }]],
    ['Bank Transfer', [{ type: 'text', name: 'account_holder', placeholder: 'Account holder name', is_required: true }, { type: 'text', name: 'account_number', placeholder: 'Account number', is_required: true }, { type: 'text', name: 'ifsc', placeholder: 'IFSC code', is_required: true }]],
    ['Cash', []],
  ];
  for (const [name, fields] of METHODS) await upsert(PaymentMethod, { name }, { fields, active: true });
  out.paymentMethods = METHODS.length;

  // Names only; credentials are entered in Payment Gateway settings by the admin.
  for (const [name, slug, active] of [['Razorpay', 'razorpay', true], ['PhonePe', 'phonepe', false], ['Cash', 'cash', true], ['Wallet', 'wallet', true]]) {
    await upsert(PaymentGateway, { slug }, { name, active });
  }
  out.paymentGateways = 4;

  for (const transport_type of ['taxi', 'delivery']) await upsert(RideModule, { transport_type }, { active: true });
  out.rideModules = 2;

  await upsert(ReferralTranslation, { language_code: 'en' }, {
    language_name: 'English',
    user_referral: {
      instant_referrer_user: 'Invite friends and earn Rs {amount} the moment they join.',
      instant_referrer_user_and_new_user: 'You and your friend both get Rs {amount} when they sign up.',
      conditional_referrer_user_ride_count: 'Earn Rs {amount} when your friend completes {count} rides.',
      conditional_referrer_user_earnings: 'Earn Rs {amount} when your friend spends Rs {target}.',
      dual_conditional_referrer_user_and_new_user_ride_count: 'You both earn Rs {amount} after {count} rides.',
      dual_conditional_referrer_user_and_new_user_earnings: 'You both earn Rs {amount} after Rs {target} in rides.',
      banner_text: 'Refer a friend and ride for less',
    },
    driver_referral: {
      instant_referrer_user: 'Refer a driver and earn Rs {amount} instantly.',
      instant_referrer_user_and_new_user: 'You and the new driver both get Rs {amount}.',
      conditional_referrer_user_ride_count: 'Earn Rs {amount} when your referral completes {count} rides.',
      conditional_referrer_user_earnings: 'Earn Rs {amount} when your referral earns Rs {target}.',
      dual_conditional_referrer_user_and_new_user_ride_count: 'You both earn Rs {amount} after {count} rides.',
      dual_conditional_referrer_user_and_new_user_earnings: 'You both earn Rs {amount} after Rs {target} in earnings.',
      banner_text: 'Bring a driver, earn a bonus',
    },
  });
  out.referralTranslations = 1;

  console.log('Seeded:', JSON.stringify(out));
  await mongoose.disconnect();
};

run().catch((e) => { console.error('seed failed:', e.message); process.exit(1); });
