import { Vehicle } from '../../admin/models/Vehicle.js';
import { haversineKm } from './shareRideGeo.js';

// Share Ride fares come from the admin's existing city tariff (set-price) so the
// admin sets nothing new for car pooling. Sharing is priced this much below
// riding alone. A constant on purpose: the admin does not configure car pooling.
export const SHARE_DISCOUNT_PERCENT = 30;
export const MAX_SEATS_PER_REQUEST = 4;
export const MIN_TRIP_KM = 1;
export const MAX_TRIP_KM = 800;
// Straight line to road distance, only used when routing is unavailable.
const ROAD_FACTOR = 1.3;

// Vehicle classes that cannot carry a shared ride; anything else is a car.
const NOT_SHARABLE_ICONS = new Set(['bike', 'scooty', 'auto', 'truck', 'ehcb', 'hcv', 'lcv', 'mcv', 'bus', 'mini_bus']);

/**
 * Fare for `seats` seats over `km`, from one tariff row. Same formula the rider
 * app and the normal ride use (base + per km past the free distance, then the
 * rider platform fee), minus the sharing discount.
 *
 * The platform fee is a percentage of the subtotal, or a fixed sum once per ride.
 * Whole rupees, like every other fare.
 */
export const fareFromTariff = (row, km, seats) => {
  const base = Number(row.base_price) || 0;
  const freeKm = Number(row.base_distance) || 0;
  const perKm = Number(row.price_per_distance) || 0;
  const solo = base + Math.max(0, km - freeKm) * perKm;
  const perSeat = Math.round(solo * (1 - SHARE_DISCOUNT_PERCENT / 100));
  const subtotal = perSeat * seats;
  const fee = Number(row.rider_platform_fee) || 0;
  const platformFee = Math.round(row.rider_platform_fee_type === 'percentage' ? (subtotal * fee) / 100 : fee);
  return { perSeat, subtotal, platformFee, total: subtotal + platformFee };
};

// The cheapest car-class tariff at the pickup. The rider does not pick a
// vehicle, so the quote uses the entry-level car and holds even if a bigger
// car ends up picking them up.
const pickShareTariff = async (rows) => {
  const ids = rows.map((row) => row.type_id || row.vehicle_type).filter(Boolean);
  if (!ids.length) return null;
  const vehicles = await Vehicle.find({ _id: { $in: ids } }, { icon_types: 1, capacity: 1 }).lean();
  const sharable = new Set(
    vehicles
      .filter((vehicle) => !NOT_SHARABLE_ICONS.has(String(vehicle.icon_types || '').toLowerCase()))
      .filter((vehicle) => !(Number(vehicle.capacity) > 0 && Number(vehicle.capacity) < 3))
      .map((vehicle) => String(vehicle._id)),
  );
  const candidates = rows.filter((row) => sharable.has(String(row.type_id || row.vehicle_type)));
  return candidates.sort((a, b) => (Number(a.base_price) || 0) - (Number(b.base_price) || 0))[0] || null;
};

const defaultDeps = async () => {
  const [{ getTariffsAt }, { resolveRouteCached }] = await Promise.all([
    import('../../user/controllers/userController.js'),
    import('../../services/routeService.js'),
  ]);
  return { loadTariffs: getTariffsAt, loadRoute: resolveRouteCached };
};

/**
 * Quote a share ride. Never throws for "not available here": it answers
 * `{ available: false, reason }` so the app can say so.
 * pickup/drop are [lng, lat]. `deps` lets tests supply tariffs and routing.
 */
export const quoteShareFare = async ({ pickup, drop, seats }, deps = null) => {
  const { loadTariffs, loadRoute } = deps || (await defaultDeps());
  const seatCount = Math.min(MAX_SEATS_PER_REQUEST, Math.max(1, Math.round(Number(seats) || 1)));

  const straightKm = haversineKm(pickup, drop);
  if (straightKm < MIN_TRIP_KM) return { available: false, reason: 'Pickup and drop are too close for a shared ride' };
  if (straightKm > MAX_TRIP_KM) return { available: false, reason: 'This trip is too long for a shared ride' };

  let distanceKm = Math.round(straightKm * ROAD_FACTOR * 10) / 10;
  try {
    const route = await loadRoute({ origin: pickup, destination: drop });
    if (route?.distanceMeters > 0) distanceKm = Math.round((route.distanceMeters / 1000) * 10) / 10;
  } catch {
    // keep the straight-line estimate
  }

  const { tariffs } = (await loadTariffs({ lat: pickup[1], lng: pickup[0] })) || { tariffs: [] };
  const row = await pickShareTariff(tariffs || []);
  if (!row) return { available: false, reason: 'Share rides are not available in this area yet' };

  const fare = fareFromTariff(row, distanceKm, seatCount);
  return {
    available: true,
    distanceKm,
    seats: seatCount,
    ...fare,
    discountPercent: SHARE_DISCOUNT_PERCENT,
    tariffName: row.vehicle_type_name || row.name || '',
  };
};
