// The server's own city-ride fare, from the admin's tariff, with the same formula the rider web app uses
// (SelectVehicle.calculateEstimatedFare). Nothing here changes what is charged: POST /rides still stores the fare the app
// sends. The quote is recorded next to it (pricingSnapshot.serverQuote) so the admin can see where apps and tariff disagree.
import mongoose from 'mongoose';
import { Vehicle } from '../admin/models/Vehicle.js';
import { resolveRideRoute } from './routeService.js';
import { ABSOLUTE_MAX_MULTIPLIER, getSurgeAt, getSurgeProfiles, surgeForVehicle } from './surgeService.js';
import { classifyTrip } from './tripCategoryService.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Pure: fare parts for one tariff row. Mirrors the web app, then layers surge, platform fee and airport fee. */
export const computeCityFare = ({ rule, distanceMeters, durationMinutes, surgeMultiplier = 1, airportFee = 0 }) => {
  const km = Math.max(0, num(distanceMeters) / 1000);
  const minutes = Math.max(0, num(durationMinutes));
  const basePrice = num(rule?.base_price);
  const baseDistance = Math.max(0, num(rule?.base_distance));
  const withinBase = baseDistance > 0 && km <= baseDistance;
  const extraKm = withinBase ? 0 : Math.max(0, km - baseDistance);
  const distanceAmount = r2(extraKm * num(rule?.price_per_distance));
  const timeAmount = withinBase ? 0 : r2(minutes * num(rule?.time_price));
  const subtotal = r2(basePrice + distanceAmount + timeAmount);
  const tax = r2((subtotal * num(rule?.service_tax)) / 100);
  const fareBeforeSurge = Math.round(subtotal + tax);
  const multiplier = Math.min(ABSOLUTE_MAX_MULTIPLIER, Math.max(1, num(surgeMultiplier) || 1));
  const surgeAmount = r2(fareBeforeSurge * (multiplier - 1));
  const fareAfterSurge = Math.round(fareBeforeSurge + surgeAmount);
  const platformFee = r2(
    Number(rule?.admin_commision_type ?? 1) === 1
      ? (fareAfterSurge * Math.max(0, num(rule?.admin_commision))) / 100
      : Math.max(0, num(rule?.admin_commision)),
  );
  const airport = r2(Math.max(0, num(airportFee)));
  return {
    distanceKm: r2(km), durationMinutes: r2(minutes), baseDistanceKm: baseDistance,
    basePrice: r2(basePrice), extraKm: r2(extraKm), distanceAmount, timeAmount, subtotal,
    serviceTaxPercent: num(rule?.service_tax), tax, fareBeforeSurge,
    surgeMultiplier: multiplier, surgeAmount, platformFee, airportFee: airport,
    total: r2(fareAfterSurge + platformFee + airport),
  };
};

/** Percent / amount by which the app's fare differs from the quote, or null when it is within max(Rs 5, 5%). */
export const compareFareToQuote = ({ appFare, quote }) => {
  if (!quote || !Number.isFinite(Number(appFare))) return null;
  // An app may or may not add the airport fee (and the platform fee) into the fare it sends: accept any of those forms.
  const candidates = [0, 1].flatMap((dropFee) => [0, 1].map((dropAirport) => r2(quote.total - (dropFee ? quote.platformFee : 0) - (dropAirport ? quote.airportFee : 0))));
  const nearest = candidates.reduce((best, c) => (Math.abs(c - appFare) < Math.abs(best - appFare) ? c : best), candidates[0]);
  const diff = r2(appFare - nearest);
  if (Math.abs(diff) <= Math.max(5, nearest * 0.05)) return null;
  return { appFare: r2(appFare), serverTotal: nearest, difference: diff, percent: nearest > 0 ? r2((diff / nearest) * 100) : null };
};

/**
 * Quote every requested vehicle for one trip. `resolveRule(vehicleTypeId, ctx)` is injected by the caller
 * (rideService.resolveSetPriceForRide) so this file does not import rideService, which imports it.
 */
export const quoteCityFares = async ({
  pickupCoords, dropCoords, vehicleTypeIds = [], zoneId = null, serviceLocationId = null, transportType = 'taxi',
  fallbackDistanceMeters = 0, fallbackDurationMinutes = 0, resolveRule,
}) => {
  const route = await resolveRideRoute({ pickupCoords, dropCoords });
  const distanceMeters = route?.distanceMeters > 0 ? route.distanceMeters : Math.max(0, num(fallbackDistanceMeters));
  const durationMinutes = route?.durationMinutes > 0 ? route.durationMinutes : Math.max(0, num(fallbackDurationMinutes));
  const [surgeAt, profiles, trip] = await Promise.all([
    getSurgeAt(pickupCoords?.[1], pickupCoords?.[0]).catch(() => null),
    getSurgeProfiles().catch(() => null),
    classifyTrip({ pickup: pickupCoords, drop: dropCoords }).catch(() => null),
  ]);
  const ids = (vehicleTypeIds || []).map(String).filter((id) => mongoose.Types.ObjectId.isValid(id));
  const vehicles = await Vehicle.find(
    ids.length ? { _id: { $in: ids } } : { active: { $ne: false }, status: { $nin: [0, '0'] }, transport_type: { $in: ['taxi', 'both', 'all'] } },
  ).select('name icon_types').lean();

  const quotes = [];
  for (const vehicle of vehicles) {
    const rule = await resolveRule(vehicle._id, { zoneId, serviceLocationId, transportType });
    if (!rule) {
      quotes.push({ vehicleTypeId: String(vehicle._id), name: vehicle.name, available: false, reason: 'No tariff for this area' });
      continue;
    }
    const surge = profiles ? surgeForVehicle(surgeAt, profiles, vehicle._id).multiplier : 1;
    quotes.push({
      vehicleTypeId: String(vehicle._id), name: vehicle.name, available: true, setPriceId: String(rule._id),
      ...computeCityFare({ rule, distanceMeters, durationMinutes, surgeMultiplier: surge, airportFee: trip?.airport?.total_fee || 0 }),
    });
  }
  return {
    serviceType: 'ride', category: trip?.category || 'city', distanceMeters, durationMinutes,
    routeSource: route?.provider || 'fallback', quotes,
  };
};
