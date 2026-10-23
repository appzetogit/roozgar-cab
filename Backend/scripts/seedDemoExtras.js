/**
 * Demo data, part 2 (run after seedDemoCore.js): promo codes, banners, push
 * notifications, subscription plans, airports, toll plazas, goods types,
 * cancellation reasons, onboarding screens, careers, employees and support
 * tickets. Idempotent; DRY_RUN=1 validates without writing.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { env } = await import('../src/config/env.js');
const M = 'src/modules/taxi';
const imp = (p) => import(`../${M}/${p}`);
const { ServiceLocation } = await imp('admin/models/ServiceLocation.js');
const { Zone } = await imp('driver/models/Zone.js');
const { Vehicle } = await imp('admin/models/Vehicle.js');
const { User } = await imp('user/models/User.js');
const { Driver } = await imp('driver/models/Driver.js');
const { Owner } = await imp('admin/models/Owner.js');
const { PromoCode } = await imp('admin/promotions/models/PromoCode.js');
const { Banner } = await imp('admin/promotions/models/Banner.js');
const { Notification } = await imp('admin/promotions/models/Notification.js');
const { SubscriptionPlan } = await imp('admin/models/SubscriptionPlan.js');
const { Airport } = await imp('admin/models/Airport.js');
const { TollPlaza } = await imp('admin/models/TollPlaza.js');
const { GoodsType } = await imp('admin/models/GoodsType.js');
const { CancellationReason } = await imp('admin/models/CancellationReason.js');
const { OnboardingScreen } = await imp('admin/models/OnboardingScreen.js');
const { CareerJob } = await imp('career/models/CareerJob.js');
const { Employee } = await imp('admin/models/Employee.js');
const { SupportTicketTitle } = await imp('support/models/SupportTicketTitle.js');
const { SupportTicket } = await imp('support/models/SupportTicket.js');

const DRY = process.env.DRY_RUN === '1';
const BASE = String(env.publicBackendUrl || 'https://roozgarcab.com').replace(/\/+$/, '');
const img = (group, name) => `${BASE}/uploads/roozgarcab/seed/${group}/${name}.webp`;
const stats = {};

const upsert = async (Model, filter, doc, label) => {
  const probe = new Model({ ...filter, ...doc });
  const err = probe.validateSync();
  if (err) throw new Error(`${label} invalid: ${Object.values(err.errors).map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  stats[label] = (stats[label] || 0) + 1;
  if (DRY) return probe;
  return Model.findOneAndUpdate(filter, { $set: doc }, { new: true, upsert: true, setDefaultsOnInsert: true });
};

const run = async () => {
  if (!DRY) await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
  const fake = (n) => ({ _id: new mongoose.Types.ObjectId(), name: n });
  const locs = DRY
    ? [fake('Indore'), fake('Hyderabad')]
    : await ServiceLocation.find({ name: { $in: ['Indore', 'Hyderabad'] } }).lean();
  const byName = Object.fromEntries(locs.map((l) => [l.name, l]));
  const zones = DRY ? [] : await Zone.find({ name: { $in: ['Indore City Zone', 'Bahadurpura Zone'] } }).lean();
  const vehicles = DRY ? [fake('v1')] : await Vehicle.find({ name: /^Roozgar / }).lean();
  const vById = (needle) => vehicles.find((v) => v.name.includes(needle));
  const now = new Date();
  const daysFrom = (d) => new Date(now.getTime() + d * 86400000);

  // promo codes (one set per city + a global "all locations" one)
  const PROMOS = [
    ['WELCOME50', 50, 100, 'First ride offer: 50% off up to Rs 100', 1],
    ['ROOZGAR20', 20, 60, 'Flat 20% off on every ride', 5],
    ['WEEKEND30', 30, 120, 'Weekend special: 30% off', 3],
    ['AIRPORT15', 15, 80, 'Airport rides 15% off', 4],
    ['NIGHTOWL25', 25, 90, 'Late night rides 25% off', 2],
  ];
  for (const [city, loc] of Object.entries(byName)) {
    for (const [code, pct, max, , uses] of PROMOS) {
      await upsert(PromoCode, { code: `${code}${city === 'Indore' ? 'IND' : 'HYD'}`.toUpperCase() }, {
        service_location_id: loc._id, service_location_ids: [loc._id], service_location_names: [city],
        transport_type: 'taxi', minimum_trip_amount: 80, maximum_discount_amount: max, cumulative_max_discount_amount: max * 20,
        discount_percentage: pct, from_date: daysFrom(-10), to_date: daysFrom(120), uses_per_user: uses, max_uses_total: 1000,
        usage_count: 0, active: true,
      }, 'promoCodes');
    }
  }

  // banners
  const BANNERS = [
    ['Ride now, pay later', 'ride_now_banner', 'Book a cab in seconds'],
    ['Auto rides, low fares', 'auto_with_people_banner', 'Metered autos across the city'],
    ['Exclusive offers for you', 'offers_banner', 'Use code WELCOME50'],
    ['Outstation made easy', 'chardham_banner', 'One-way and round trips'],
    ['Holiday taxis', 'holiday_taxi_bg', 'Plan your next getaway'],
    ['Premium sedans', 'white_sedan_banner_car', 'Comfort on every trip'],
    ['Send parcels fast', 'parcel_offer_assets', 'Same-day parcel delivery'],
  ];
  for (const [title, file] of BANNERS) {
    await upsert(Banner, { title }, { image: img('banners', file), link_type: 'external_link', external_link: 'https://roozgarcab.com', redirect_url: 'https://roozgarcab.com', active: true }, 'banners');
  }

  // push notifications
  const NOTIFS = [
    ['Welcome to Roozgar Cab', 'Book your first ride and get 50% off with WELCOME50.', 'users', 'banners/offers_banner'],
    ['Weekend offer', 'Use WEEKEND30 for 30% off this weekend.', 'users', 'banners/ride_now_banner'],
    ['Drivers: new incentive', 'Complete 10 rides today and earn a Rs 200 bonus.', 'drivers', null],
    ['Drivers: update documents', 'Please keep your licence and insurance up to date.', 'drivers', null],
  ];
  for (const loc of Object.values(byName)) {
    for (const [title, message, to, imgPath] of NOTIFS) {
      await upsert(Notification, { push_title: title, service_location_id: loc._id }, {
        service_location_name: loc.name, send_to: to, message, image: imgPath ? img(...imgPath.split('/')) : '',
        status: 'sent', sent_at: daysFrom(-2),
      }, 'notifications');
    }
  }

  // subscription plans
  const PLANS = [
    ['driver', 'Bike & Auto Day Pass', 'Zero commission for 24 hours', 29, 1, 'unlimited', 0, ['bike', 'auto']],
    ['driver', 'Car Day Pass', 'Zero commission for 24 hours', 49, 1, 'unlimited', 0, ['car']],
    ['driver', 'Car Weekly Pass', 'Zero commission for 7 days', 299, 7, 'unlimited', 0, ['car']],
    ['driver', 'Car Monthly Pass', 'Zero commission for 30 days', 999, 30, 'unlimited', 0, ['car']],
    ['driver', 'Bike & Auto Weekly Pass', 'Zero commission for 7 days', 149, 7, 'limited', 120, ['bike', 'auto']],
    ['user', 'Rider Monthly Saver', '10% off on every ride for 30 days', 99, 30, 'unlimited', 0, []],
    ['user', 'Rider Quarterly Saver', '10% off on every ride for 90 days', 249, 90, 'unlimited', 0, []],
  ];
  for (const [audience, name, description, amount, duration, benefit, limit, classes] of PLANS) {
    await upsert(SubscriptionPlan, { audience, name }, {
      description, amount, duration, transport_type: 'taxi', vehicle_classes: classes, benefit_type: benefit, ride_limit: limit,
      how_it_works: 'Purchase the plan from the app wallet; benefits apply automatically until it expires.', active: true,
    }, 'subscriptionPlans');
  }

  // airports
  const sq = (lat, lng, h) => ({ type: 'Polygon', coordinates: [[[lng - h, lat - h], [lng + h, lat - h], [lng + h, lat + h], [lng - h, lat + h], [lng - h, lat - h]]] });
  const AIRPORTS = [
    ['Devi Ahilya Bai Holkar Airport', 'IDR', 'Indore', 22.7218, 75.8011, 'Airport Road, Indore'],
    ['Rajiv Gandhi International Airport', 'HYD', 'Hyderabad', 17.2403, 78.4294, 'Shamshabad, Hyderabad'],
  ];
  for (const [name, code, city, lat, lng, address] of AIRPORTS) {
    const zone = zones.find((z) => String(z.service_location_id) === String(byName[city]._id));
    await upsert(Airport, { code }, {
      name, service_location_id: byName[city]._id, zone_id: zone?._id || null, terminal: 'Terminal 1', address,
      contact_number: '1800 000 000', latitude: lat, longitude: lng, location: { type: 'Point', coordinates: [lng, lat] },
      boundary: sq(lat, lng, 0.01), airport_surge: 50, support_airport_fee: true, status: 'active', active: true,
      pickup_availability: true, drop_availability: true,
    }, 'airports');
  }

  // toll plazas
  if (vehicles.length) {
    const TOLLS = [
      ['Choral Toll Plaza', 'NH-52 (Indore-Khandwa)', 22.4783, 75.8419, 90, 130],
      ['Dewas Toll Plaza', 'NH-52 (Indore-Dewas)', 22.9676, 76.0534, 60, 90],
      ['Pedda Amberpet Toll Plaza', 'ORR Hyderabad', 17.3322, 78.6431, 40, 60],
      ['Shamshabad Toll Plaza', 'ORR Exit 17', 17.2573, 78.4214, 45, 70],
    ];
    for (const [name, highway, lat, lng, one, ret] of TOLLS) {
      await upsert(TollPlaza, { name }, {
        highway, location: { type: 'Point', coordinates: [lng, lat] }, radius_meters: 300,
        service_location_ids: Object.values(byName).map((l) => l._id),
        prices: vehicles.filter((v) => v.category === 'car').map((v) => ({ vehicle_type_id: v._id, one_way: one, return_trip: ret })),
        active: true, notes: 'Demo toll rates',
      }, 'tollPlazas');
    }
  }

  // goods types
  for (const g of ['Documents', 'Groceries', 'Electronics', 'Clothing', 'Furniture', 'Food', 'Medicines', 'Auto Parts']) {
    await upsert(GoodsType, { goods_type_name: g }, { goods_types_for: 'all', active: true, status: 'active' }, 'goodsTypes');
  }

  // cancellation reasons
  const REASONS = {
    user: ['Driver is too far away', 'Driver asked me to cancel', 'Changed my plans', 'Booked by mistake', 'Waiting for too long', 'Wrong pickup location'],
    driver: ['Rider not at pickup point', 'Rider not responding', 'Vehicle problem', 'Rider asked to cancel', 'Too much traffic', 'Personal emergency'],
  };
  for (const [audience, list] of Object.entries(REASONS)) {
    for (const [i, title] of list.entries()) {
      await upsert(CancellationReason, { title, audience }, { requiresNote: i === list.length - 1, order_by: i + 1, active: true }, 'cancellationReasons');
    }
  }

  // onboarding screens
  const ONB = {
    user: [['Book in seconds', 'Pick your pickup and drop and get a cab in moments.'], ['Fair, upfront fares', 'See the price before you ride. No surprises.'], ['Ride safe', 'Share your trip live and reach help with one tap.']],
    driver: [['Drive and earn', 'Go online whenever you want and earn on your terms.'], ['Keep what you earn', 'Low commission and daily payouts to your wallet.'], ['Get paid on time', 'Track earnings and withdrawals right in the app.']],
    owner: [['Grow your fleet', 'Add vehicles and assign drivers from one dashboard.'], ['Track every trip', 'Live location, earnings and reports for your cabs.']],
  };
  for (const [audience, list] of Object.entries(ONB)) {
    for (const [i, [title, description]] of list.entries()) {
      await upsert(OnboardingScreen, { audience, screen: `screen_${i + 1}` }, { order: i + 1, title, description, active: true }, 'onboardingScreens');
    }
  }

  // careers + employees
  const JOBS = [
    ['Customer Support Executive', 'Support', 'Indore', 'Full-time', 'Handle rider and driver queries over call and chat.'],
    ['Driver Onboarding Associate', 'Operations', 'Hyderabad', 'Full-time', 'Verify driver documents and guide new drivers.'],
    ['Field Operations Executive', 'Operations', 'Indore', 'Full-time', 'Manage driver partners across city zones.'],
    ['Backend Developer (Node.js)', 'Engineering', 'Remote', 'Full-time', 'Build and scale our ride-hailing APIs.'],
    ['Marketing Intern', 'Marketing', 'Hyderabad', 'Internship', 'Support local campaigns and social media.'],
  ];
  for (const [title, department, location, type, description] of JOBS) {
    await upsert(CareerJob, { title }, { department, location, type, description, active: true }, 'careerJobs');
  }
  const EMPS = [['Rohit Mehra', '9555000001', 'EMP001'], ['Kavya Nair', '9555000002', 'EMP002'], ['Arjun Reddy', '9555000003', 'EMP003'], ['Sana Mirza', '9555000004', 'EMP004'], ['Vishal Dubey', '9555000005', 'EMP005']];
  for (const [name, phone, employeeCode] of EMPS) {
    await upsert(Employee, { phone }, { name, employeeCode, active: true, notes: 'Field acquisition executive' }, 'employees');
  }

  // support ticket titles + tickets
  const TITLES = [
    ['user', 'general', 'Payment or refund issue'], ['user', 'general', 'Driver behaviour complaint'], ['user', 'request', 'Lost an item in the cab'],
    ['driver', 'general', 'Earnings or payout query'], ['driver', 'request', 'Update my vehicle details'], ['owner', 'general', 'Fleet vehicle approval status'],
  ];
  const titles = [];
  for (const [userType, supportType, title] of TITLES) {
    titles.push(await upsert(SupportTicketTitle, { title, userType, supportType }, { active: true }, 'supportTitles'));
  }
  if (!DRY) {
    const users = await User.find({ phone: /^97700/ }).limit(6).lean();
    const drivers = await Driver.find({ phone: /^96600/ }).limit(4).lean();
    const owners = await Owner.find({ mobile: /^98100/ }).limit(2).lean();
    const mk = (who, role, t, i, status, body) => ({
      ticketCode: `RZ-T${String(1000 + i)}`, titleId: t._id, title: t.title, userType: role, supportType: t.supportType,
      requesterRole: role, requesterId: who._id, requesterName: who.name || who.owner_name, requesterPhone: who.phone || who.mobile,
      status, messages: [{ senderRole: role, senderId: who._id, senderName: who.name || who.owner_name, message: body, createdAt: daysFrom(-3) }],
      lastMessageAt: daysFrom(-3),
    });
    const T = (needle) => titles.find((t) => t.title.includes(needle));
    const tickets = [
      ...users.slice(0, 3).map((u, i) => mk(u, 'user', T('Payment'), i, i === 0 ? 'pending' : 'closed', 'My payment was deducted but the ride was cancelled. Please check.')),
      ...users.slice(3, 5).map((u, i) => mk(u, 'user', T('Lost an item'), 10 + i, 'pending', 'I left my bag in the cab on my last trip.')),
      ...drivers.slice(0, 3).map((d, i) => mk(d, 'driver', T('Earnings'), 20 + i, i === 1 ? 'closed' : 'pending', 'My weekly payout has not reached my wallet yet.')),
      ...owners.slice(0, 2).map((o, i) => mk(o, 'owner', T('Fleet vehicle'), 30 + i, 'pending', 'Please approve my newly added vehicle.')),
    ];
    for (const t of tickets) await upsert(SupportTicket, { ticketCode: t.ticketCode }, t, 'supportTickets');
  }

  console.log(DRY ? 'DRY RUN (validated, nothing written):' : 'Seeded:', JSON.stringify(stats));
  if (!DRY) await mongoose.disconnect();
};

run().catch((e) => { console.error('seed failed:', e.message); process.exit(1); });
