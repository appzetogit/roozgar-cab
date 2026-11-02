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

// ---- vehicles: the rider picks one; every passenger vehicle except a bike can share a ride
export const BIKE_TYPES = ['bike', 'scooty'];
const NOT_PASSENGER_ICONS = new Set(['bike', 'scooty', 'truck', 'ehcb', 'hcv', 'lcv', 'mcv', 'bus', 'mini_bus']);
const VEHICLE_FIELDS = 'name icon_types category capacity is_accept_share_ride is_taxi active status icon image';

// Seats one request can hold at most, whatever the vehicle (the driver always takes one seat).
export const maxSeatsCap = () => Math.max(1, Math.round(Number(process.env.SHARE_MAX_SEATS) || 6));

// Admin sets `capacity` per vehicle type; when it is not set an auto seats 3 and anything else 4.
export const vehicleCapacityOf = (vehicle = {}) => {
  const capacity = Number(vehicle.capacity);
  if (capacity > 0) return capacity;
  const family = String(vehicle.category || vehicle.icon_types || vehicle.vehicleType || '').toLowerCase();
  return family === 'auto' ? 3 : 4;
};
export const maxSeatsFor = (vehicle) => Math.max(0, Math.min(maxSeatsCap(), vehicleCapacityOf(vehicle) - 1));

// Admin's switch (`is_accept_share_ride`) is respected: 0 means this type is off; a type without the flag is allowed.
export const isShareVehicle = (vehicle) => {
  if (!vehicle) return false;
  if (BIKE_TYPES.includes(String(vehicle.category || '').toLowerCase())) return false;
  if (NOT_PASSENGER_ICONS.has(String(vehicle.icon_types || '').toLowerCase())) return false;
  if (['delivery', 'pooling'].includes(String(vehicle.is_taxi || '').toLowerCase())) return false;
  if (vehicle.active === false || (vehicle.status !== undefined && Number(vehicle.status) === 0)) return false;
  return vehicle.is_accept_share_ride === undefined || vehicle.is_accept_share_ride === null || Number(vehicle.is_accept_share_ride) !== 0;
};

const rowTypeId = (row) => String(row.type_id || row.vehicle_type || '');

// Road distance for the route; the straight-line estimate if routing is unavailable.
const resolveDistanceKm = async (pickup, drop, loadRoute) => {
  let distanceKm = Math.round(haversineKm(pickup, drop) * ROAD_FACTOR * 10) / 10;
  try {
    const route = await loadRoute({ origin: pickup, destination: drop });
    if (route?.distanceMeters > 0) distanceKm = Math.round((route.distanceMeters / 1000) * 10) / 10;
  } catch {
    // keep the straight-line estimate
  }
  return distanceKm;
};

const tooShortOrLong = (pickup, drop) => {
  const straightKm = haversineKm(pickup, drop);
  if (straightKm < MIN_TRIP_KM) return 'Pickup and drop are too close for a shared ride';
  if (straightKm > MAX_TRIP_KM) return 'This trip is too long for a shared ride';
  return '';
};

/**
 * Quote a share ride. Never throws for "not available here": it answers
 * `{ available: false, reason }` so the app can say so. A request that names a
 * vehicle (`vehicleTypeId`) is priced from that vehicle's own tariff and limited
 * to its seats; the unavailable answer then carries a `code`
 * (VEHICLE_NOT_AVAILABLE, SEATS_EXCEED_CAPACITY). Without one it is the old
 * behaviour: 1 to 4 seats at the cheapest car tariff.
 * pickup/drop are [lng, lat]. `deps` lets tests supply tariffs and routing.
 */
export const quoteShareFare = async ({ pickup, drop, seats, vehicleTypeId = '' }, deps = null) => {
  const { loadTariffs, loadRoute } = deps || (await defaultDeps());
  const wantedSeats = Math.max(1, Math.round(Number(seats) || 1));
  const seatCount = vehicleTypeId ? wantedSeats : Math.min(MAX_SEATS_PER_REQUEST, wantedSeats);

  const problem = tooShortOrLong(pickup, drop);
  if (problem) return { available: false, reason: problem };

  const distanceKm = await resolveDistanceKm(pickup, drop, loadRoute);
  const { tariffs } = (await loadTariffs({ lat: pickup[1], lng: pickup[0] })) || { tariffs: [] };

  let row;
  let vehicle = null;
  if (vehicleTypeId) {
    vehicle = await Vehicle.findById(vehicleTypeId).select(VEHICLE_FIELDS).lean();
    row = vehicle && isShareVehicle(vehicle) ? (tariffs || []).find((entry) => rowTypeId(entry) === String(vehicle._id)) : null;
    if (!row) return { available: false, code: 'VEHICLE_NOT_AVAILABLE', reason: 'This vehicle is not available for share rides here' };
    const maxSeats = maxSeatsFor(vehicle);
    if (seatCount > maxSeats) {
      return { available: false, code: 'SEATS_EXCEED_CAPACITY', reason: `This vehicle takes up to ${maxSeats} seats`, maxSeats };
    }
  } else {
    row = await pickShareTariff(tariffs || []);
    if (!row) return { available: false, reason: 'Share rides are not available in this area yet' };
  }

  const fare = fareFromTariff(row, distanceKm, seatCount);
  return {
    available: true,
    distanceKm,
    seats: seatCount,
    ...fare,
    discountPercent: SHARE_DISCOUNT_PERCENT,
    tariffName: vehicle?.name || row.vehicle_type_name || row.name || '',
    ...(vehicle
      ? { vehicle: { vehicleTypeId: String(vehicle._id), name: vehicle.name, capacity: vehicleCapacityOf(vehicle) }, maxSeats: maxSeatsFor(vehicle) }
      : {}),
  };
};

/**
 * The vehicles a rider can pick for this route: every share-enabled passenger
 * vehicle type with a tariff at the pickup, each with its seat limit and price
 * per seat. Driver availability is added by the caller.
 */
export const listShareVehicleOptions = async ({ pickup, drop }, deps = null) => {
  const { loadTariffs, loadRoute } = deps || (await defaultDeps());
  const problem = tooShortOrLong(pickup, drop);
  if (problem) return { available: false, options: [], reason: problem };

  const distanceKm = await resolveDistanceKm(pickup, drop, loadRoute);
  const { tariffs } = (await loadTariffs({ lat: pickup[1], lng: pickup[0] })) || { tariffs: [] };
  const rows = tariffs || [];
  const ids = [...new Set(rows.map(rowTypeId).filter(Boolean))];
  const vehicles = ids.length ? await Vehicle.find({ _id: { $in: ids } }).select(VEHICLE_FIELDS).lean() : [];

  const options = [];
  for (const vehicle of vehicles) {
    if (!isShareVehicle(vehicle)) continue;
    const row = rows.find((entry) => rowTypeId(entry) === String(vehicle._id));
    const maxSeats = maxSeatsFor(vehicle);
    if (!row || maxSeats < 1) continue;
    options.push({
      vehicleTypeId: String(vehicle._id),
      name: vehicle.name,
      icon: vehicle.icon || vehicle.image || '',
      capacity: vehicleCapacityOf(vehicle),
      maxSeats,
      perSeat: fareFromTariff(row, distanceKm, 1).perSeat,
      discountPercent: SHARE_DISCOUNT_PERCENT,
    });
  }
  options.sort((a, b) => a.perSeat - b.perSeat);
  if (!options.length) return { available: false, options: [], distanceKm, reason: 'Share rides are not available in this area yet' };
  return { available: true, distanceKm, options };
};
