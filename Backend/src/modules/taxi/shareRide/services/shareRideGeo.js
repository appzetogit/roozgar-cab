// Pure geometry for matching a rider onto a provider's route. Points are GeoJSON
// order, [lng, lat]. No database, no network, so it is unit-tested directly.

// How far off the straight line origin -> destination a rider's pickup and drop
// may be and still count as "on the way".
export const CORRIDOR_KM = 4;
// A driver with no route yet sees requests whose pickup is this close to them.
export const IDLE_RADIUS_KM = 6;

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
  if (lengthSq < 1e-9) return { t: 0, offKm: Math.hypot(p.x, p.y) };
  const t = Math.min(1, Math.max(0, (p.x * b.x + p.y * b.y) / lengthSq));
  return { t, offKm: Math.hypot(p.x - b.x * t, p.y - b.y * t) };
};

// Does a rider (pickup -> drop) sit on the route origin -> destination, going the same way?
export const corridorFit = ({ origin, destination, pickup, drop, corridorKm = CORRIDOR_KM }) => {
  const from = projectOnSegment({ origin, destination, point: pickup });
  const to = projectOnSegment({ origin, destination, point: drop });
  const forward = to.t - from.t >= 0.05;
  return {
    fits: from.offKm <= corridorKm && to.offKm <= corridorKm && forward,
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
