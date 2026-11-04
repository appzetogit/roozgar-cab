/**
 * READ-ONLY audit of booking calculations on a database: for the rides already stored, recompute what the admin's tariff says the
 * fare should be (the same formulas the rider app uses) and compare it with what was charged, and check the settlement maths
 * (commission, earnings, advance). Writes nothing.
 *
 *   node scripts/auditFares.mjs [--limit 400] [--kind city|outstation|rental|parcel|all]
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Ride } from '../src/modules/taxi/user/models/Ride.js';
import { SetPrice } from '../src/modules/taxi/admin/models/SetPrice.js';
import '../src/modules/taxi/admin/models/Vehicle.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const LIMIT = Number(arg('limit', 400));
const KIND = arg('kind', 'all');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
const filter = { adminDeletedAt: null, ...(KIND === 'city' ? { serviceType: 'ride' } : KIND === 'outstation' ? { serviceType: 'intercity' } : KIND === 'rental' ? { serviceType: 'hourly_rental' } : KIND === 'parcel' ? { serviceType: 'parcel' } : {}) };
const rides = await Ride.find(filter).sort({ createdAt: -1 }).limit(LIMIT).populate('vehicleTypeId', 'name icon_types').lean();
const ids = [...new Set(rides.map((r) => String(r.pricingSnapshot?.setPriceId || '')).filter(Boolean))];
const prices = new Map((await SetPrice.find({ _id: { $in: ids } }).lean()).map((p) => [String(p._id), p]));

// The rider app's city formula (SelectVehicle.calculateEstimatedFare): within the base distance only the base price; beyond it base + extra km x price per km
// + the WHOLE trip minutes x time price; then the service tax percentage.
const cityFormula = (p, meters, minutes) => {
  const km = Math.max(0, meters / 1000);
  const base = Number(p.base_price) || 0; const baseKm = Math.max(0, Number(p.base_distance) || 0);
  const subtotal = baseKm > 0 && km <= baseKm ? base : base + Math.max(0, km - baseKm) * (Number(p.price_per_distance) || 0) + Math.max(0, minutes) * (Number(p.time_price) || 0);
  return Math.round(subtotal + (subtotal * (Number(p.service_tax) || 0)) / 100);
};
const outstationFormula = (p, km) => (Number(p.outstation_base_price) || 0) + Math.max(0, km - (Number(p.outstation_base_distance) || 0)) * (Number(p.outstation_price_per_distance) || 0);

const rows = [];
const problems = {};
const flag = (key, ride, note) => { (problems[key] ||= []).push(`${String(ride._id).slice(-8)} ${note}`); };
for (const ride of rides) {
  const p = prices.get(String(ride.pricingSnapshot?.setPriceId || ''));
  const kind = ride.serviceType;
  const km = (ride.estimatedDistanceMeters || 0) / 1000;
  const fee = Number(ride.pricingSnapshot?.rider_platform_fee) || 0;
  const surge = Number(ride.surge?.multiplier) || 1;
  const toll = Number(ride.tollCharges?.total) || 0;
  const promo = Number(ride.promo?.discount_amount) || 0;
  const row = { id: String(ride._id).slice(-8), kind, vehicle: ride.vehicleTypeId?.name || ride.vehicleIconType, status: ride.status, fare: ride.fare, baseFare: ride.baseFare, km: r2(km), min: Math.round(ride.estimatedDurationMinutes || 0), surge, fee, toll, promo, adv: ride.advance?.amount || 0, pay: ride.paymentMethod };
  if (p && kind === 'ride') {
    const expected = cityFormula(p, ride.estimatedDistanceMeters || 0, ride.estimatedDurationMinutes || 0);
    row.tariff = expected; row.ratio = expected ? r2(ride.baseFare / expected) : null;
    if (expected && Math.abs(ride.baseFare - expected) > Math.max(2, expected * 0.03) && ride.bookingMode !== 'bidding' && ride.pricingNegotiationMode !== 'driver_bid') flag('city_fare_vs_tariff', ride, `charged base ${ride.baseFare} vs tariff ${expected} (${r2(km)} km, ${Math.round(ride.estimatedDurationMinutes || 0)} min)`);
  }
  if (p && kind === 'intercity') {
    const expected = Math.round(outstationFormula(p, km));
    row.tariff = expected;
  }
  // settlement maths
  if (ride.status === 'completed') {
    const fare = Number(ride.fare) || 0;
    const pct = Number(ride.pricingSnapshot?.admin_commission_from_driver) || 0;
    const type = Number(ride.pricingSnapshot?.admin_commission_type_from_driver ?? 1);
    if (ride.walletSettledAt) {
      const tripCommission = type === 1 ? (Math.max(0, fare - toll) * pct) / 100 : Math.min(pct, fare);
      if (Math.abs((ride.commissionAmount || 0) + (ride.driverEarnings || 0) - fare) > 1) flag('settlement_sum', ride, `commission ${ride.commissionAmount} + earnings ${ride.driverEarnings} != fare ${fare}`);
      row.commission = ride.commissionAmount; row.earn = ride.driverEarnings; row.expCommission = r2(tripCommission + fee);
    } else if (fare > 0) flag('not_settled', ride, `completed, fare ${fare}, never settled (older ride)`);
    if (ride.advance?.status === 'applied' && ride.advance.amount > fare) flag('advance_over_fare', ride, `advance ${ride.advance.amount} > fare ${fare}`);
  }
  if (ride.status === 'cancelled' && ride.advance?.status === 'applied') flag('cancelled_advance_not_refunded', ride, `advance ${ride.advance.amount} still applied`);
  if (!ride.fare && ride.status !== 'cancelled') flag('zero_fare', ride, `${kind} fare 0`);
  if (kind === 'ride' && !p) flag('no_pricing_snapshot', ride, 'no tariff row recorded at booking');
  rows.push(row);
}

console.log(`rides audited: ${rows.length} (${KIND})`);
const byKind = {};
for (const r of rows) { const k = r.kind; (byKind[k] ||= { n: 0, completed: 0, cancelled: 0, fare: 0 }); byKind[k].n += 1; if (r.status === 'completed') { byKind[k].completed += 1; byKind[k].fare += r.fare || 0; } if (r.status === 'cancelled') byKind[k].cancelled += 1; }
console.log('BY KIND', JSON.stringify(byKind));
console.log('\nSAMPLE (newest first): id kind vehicle status fare baseFare tariff km min surge fee toll promo adv pay commission earn');
for (const r of rows.filter((x) => x.status !== 'cancelled').slice(0, 40)) console.log([r.id, r.kind, String(r.vehicle || '').replace('Roozgar ', '').slice(0, 14), r.status, r.fare, r.baseFare, r.tariff ?? '-', r.km, r.min, r.surge, r.fee, r.toll, r.promo, r.adv, r.pay, r.commission ?? '-', r.earn ?? '-'].join(' | '));
console.log('\nPROBLEMS');
for (const [key, list] of Object.entries(problems)) console.log(`  ${key}: ${list.length}\n     ${list.slice(0, 6).join('\n     ')}`);
if (!Object.keys(problems).length) console.log('  none found');
await mongoose.disconnect();
process.exit(0);
