// Pure geometry for matching a rider onto a provider's route. Points are GeoJSON
// order, [lng, lat]. No database, no network, so it is unit-tested directly.

// How far off the straight line origin -> destination a rider's pickup and drop
// may be and still count as "on the way".
// The widest it gets; short routes get a narrower one (see corridorKmFor).
export const CORRIDOR_KM = 4;
const MIN_CORRIDOR_KM = 1.5;
// How far past the destination (or before the origin) a rider's drop (pickup) may be: the driver does not detour.
const ENDS_TOLERANCE_KM = 1;
// A driver with no route yet sees requests whose pickup is this close to them.
export const IDLE_RADIUS_KM = 6;

// The corridor scales with the route: about 15% of its length, between 1.5 km and 4 km. A fixed 4 km let almost
// any rider near a short route (A to B) in, and a rider going somewhere else (A to C) with them.
export const corridorKmFor = (routeKm) => Math.min(CORRIDOR_KM, Math.max(MIN_CORRIDOR_KM, routeKm * 0.15));

const toRad = (degrees) => (degrees * Math.PI) / 180;

export const haversineKm = (a, b) => {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
};

// Where `point` falls along origin -> destination (t: 0 at origin, 1 at the
// destination, clamped) and how far it is from that segment, in km. A flat
// projection around the origin: accurate to well under a percent at the
// distances a shared cab runs (tens to a few hundred km).
export const projectOnSegment = ({ origin, destination, point }) => {
  const cosLat = Math.cos(toRad(origin[1]));
  const toXY = (p) => ({ x: (p[0] - origin[0]) * cosLat * 111.32, y: (p[1] - origin[1]) * 110.574 });
  const b = toXY(destination);
  const p = toXY(point);
  const lengthSq = b.x * b.x + b.y * b.y;
  if (lengthSq < 1e-9) return { t: 0, raw: 0, offKm: Math.hypot(p.x, p.y) };
  const raw = (p.x * b.x + p.y * b.y) / lengthSq;
  const t = Math.min(1, Math.max(0, raw));
  return { t, raw, offKm: Math.hypot(p.x - b.x * t, p.y - b.y * t) };
};

// Does a rider (pickup -> drop) sit on the route origin -> destination, going the same way? Both points must be
// inside the corridor, the rider must go forward along the route, and must not start before the origin or end past the
// destination by more than a kilometre (a rider heading beyond the driver's destination is on another route).
export const corridorFit = ({ origin, destination, pickup, drop, corridorKm = null }) => {
  const routeKm = haversineKm(origin, destination);
  const limit = corridorKm ?? corridorKmFor(routeKm);
  const from = projectOnSegment({ origin, destination, point: pickup });
  const to = projectOnSegment({ origin, destination, point: drop });
  const forward = to.t - from.t >= 0.05;
  const startsBeforeKm = Math.max(0, -from.raw) * routeKm;
  const endsPastKm = Math.max(0, to.raw - 1) * routeKm;
  return {
    fits: from.offKm <= limit && to.offKm <= limit && forward && startsBeforeKm <= ENDS_TOLERANCE_KM && endsPastKm <= ENDS_TOLERANCE_KM,
    pickupOffKm: Math.round(from.offKm * 10) / 10,
    dropOffKm: Math.round(to.offKm * 10) / 10,
    forward,
  };
};

// Bounding box of a route widened by the corridor, as a Mongo $geoWithin box,
// to cut the candidates before the exact check above.
export const routeBox = ({ origin, destination, corridorKm = CORRIDOR_KM }) => {
  const midLat = (origin[1] + destination[1]) / 2;
  const padLat = corridorKm / 110.574;
  const padLng = corridorKm / (111.32 * Math.max(0.2, Math.cos(toRad(midLat))));
  return [
    [Math.min(origin[0], destination[0]) - padLng, Math.min(origin[1], destination[1]) - padLat],
    [Math.max(origin[0], destination[0]) + padLng, Math.max(origin[1], destination[1]) + padLat],
  ];
};
