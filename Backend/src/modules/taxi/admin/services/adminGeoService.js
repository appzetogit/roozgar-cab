// Lean, map-oriented reads for the admin Heat Map and Gods Eye pages. Kept out of adminService.js so
// they return compact points instead of the paginated, populated list rows (which are capped at 100).
import mongoose from 'mongoose';
import { Ride } from '../../user/models/Ride.js';
import { Driver } from '../../driver/models/Driver.js';
import { Zone } from '../../driver/models/Zone.js';
import { SafetyAlert } from '../../common/models/SafetyAlert.js';
import { normalizeAdminType } from './adminAccessService.js';
import { describeRideKind, rideKindFilter } from './adminRideDetailService.js';

const MAX_POINTS = 20000;
const LIVE_WINDOW_MS = 10 * 60 * 1000;
const oid = (v) => (mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(String(v)) : null);

// shortcut: scope = service-location ids only (rides/drivers carry service_location_id); zone-only sub-admins see their locations' data.
const scopeIds = (admin = {}) => {
  if (normalizeAdminType(admin.admin_type || admin.role) === 'superadmin') return null;
  return (admin.service_location_ids || []).map((v) => oid(v)).filter(Boolean);
};

const toLatLng = (point) => {
  const [lng, lat] = Array.isArray(point?.coordinates) ? point.coordinates.map(Number) : [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
};

const parseDate = (value, endOfDay = false) => {
  if (!value) return null;
  const text = String(value);
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) && endOfDay ? `${text}T23:59:59.999Z` : text);
  return Number.isNaN(date.getTime()) ? null : date;
};

const areaLabel = (address, lat, lng) => {
  const parts = String(address || '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts.slice(0, 2).join(', ') || `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
};

const summarise = (rows, tzOffsetMin) => {
  const cells = new Map();
  const byHour = Array(24).fill(0);
  const points = [];
  for (const row of rows) {
    const ll = toLatLng(row.loc);
    if (!ll) continue;
    points.push({ lat: ll.lat, lng: ll.lng, weight: 1 });
    const key = `${ll.lat.toFixed(2)}:${ll.lng.toFixed(2)}`;
    const cell = cells.get(key) || { count: 0, labels: new Map(), lat: ll.lat, lng: ll.lng };
    cell.count += 1;
    const label = areaLabel(row.address, ll.lat, ll.lng);
    cell.labels.set(label, (cell.labels.get(label) || 0) + 1);
    cells.set(key, cell);
    if (row.at) {
      const local = new Date(new Date(row.at).getTime() + tzOffsetMin * 60000);
      byHour[local.getUTCHours()] += 1;
    }
  }
  const byArea = [...cells.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
    .map((c) => ({
      label: [...c.labels.entries()].sort((a, b) => b[1] - a[1])[0][0],
      count: c.count,
      lat: c.lat,
      lng: c.lng,
    }));
  return { points, byArea, byHour };
};

export const getHeatmapPoints = async (query = {}, admin = {}) => {
  const layer = ['requests', 'trips', 'completed', 'cancelled', 'drivers', 'sos'].includes(query.layer) ? query.layer : 'requests';
  const tzOffsetMin = Number.isFinite(Number(query.tz_offset_min)) ? Number(query.tz_offset_min) : 330;
  const from = parseDate(query.from);
  const to = parseDate(query.to, true);
  const scope = scopeIds(admin);
  const dateFilter = from || to ? { createdAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {};

  let rows;
  let total;
  if (layer === 'drivers') {
    const filter = { isOnline: true, deletedAt: null, 'location.coordinates.0': { $exists: true } };
    if (scope) filter.service_location_id = { $in: scope };
    if (oid(query.zone_id)) filter.zoneId = oid(query.zone_id);
    if (oid(query.vehicle_type_id)) filter.$or = [{ vehicleTypeId: oid(query.vehicle_type_id) }, { vehicleTypeIds: oid(query.vehicle_type_id) }];
    const docs = await Driver.find(filter).select('location locationUpdatedAt').limit(MAX_POINTS + 1).lean();
    total = docs.length;
    rows = docs.map((d) => ({ loc: d.location, at: d.locationUpdatedAt, address: '' }));
  } else if (layer === 'sos') {
    const filter = { ...dateFilter, 'location.coordinates.0': { $exists: true } };
    if (scope) filter.rideId = { $in: await Ride.find({ service_location_id: { $in: scope } }).distinct('_id') };
    const docs = await SafetyAlert.find(filter).select('location createdAt locationLabel').sort({ createdAt: -1 }).limit(MAX_POINTS + 1).lean();
    total = docs.length;
    rows = docs.map((d) => ({ loc: d.location, at: d.createdAt, address: d.locationLabel }));
  } else {
    const filter = { adminDeletedAt: null, ...dateFilter, ...rideKindFilter(query.kind), 'pickupLocation.coordinates.0': { $exists: true } };
    if (scope) filter.service_location_id = { $in: scope };
    if (oid(query.vehicle_type_id)) filter.vehicleTypeId = oid(query.vehicle_type_id);
    if (query.zone_id) {
      const zone = oid(query.zone_id) ? await Zone.findById(oid(query.zone_id)).select('service_location_id').lean() : null;
      // shortcut: rides carry no zone id, so a zone narrows to its service location; add a polygon test to tell zones of one city apart.
      filter.service_location_id = zone?.service_location_id ? zone.service_location_id : { $in: [] };
    }
    if (layer === 'completed') filter.status = 'completed';
    else if (layer === 'cancelled') filter.status = 'cancelled';
    else if (layer === 'trips') filter.status = { $in: ['ongoing', 'completed'] };
    const status = String(query.status || '').toLowerCase();
    if (layer === 'requests' && ['searching', 'accepted', 'ongoing', 'completed', 'cancelled'].includes(status)) filter.status = status;
    const [docs, count] = await Promise.all([
      Ride.find(filter).select('pickupLocation pickupAddress createdAt').sort({ createdAt: -1 }).limit(MAX_POINTS + 1).lean(),
      Ride.countDocuments(filter),
    ]);
    total = count;
    rows = docs.map((d) => ({ loc: d.pickupLocation, at: d.createdAt, address: d.pickupAddress }));
  }

  const truncated = rows.length > MAX_POINTS;
  if (truncated) rows = rows.slice(0, MAX_POINTS);
  const { points, byArea, byHour } = summarise(rows, tzOffsetMin);
  return { layer, points, total, mapped: points.length, byArea, byHour, truncated };
};

export const getLiveMap = async (admin = {}) => {
  const now = Date.now();
  const since = new Date(now - LIVE_WINDOW_MS);
  const scope = scopeIds(admin);

  const driverFilter = {
    isOnline: true,
    deletedAt: null,
    'location.coordinates.0': { $exists: true },
    $or: [{ locationUpdatedAt: { $gte: since } }, { locationUpdatedAt: null, updatedAt: { $gte: since } }],
  };
  const rideFilter = { status: { $in: ['searching', 'accepted', 'ongoing'] }, adminDeletedAt: null };
  if (scope) {
    driverFilter.service_location_id = { $in: scope };
    rideFilter.service_location_id = { $in: scope };
  }

  const [driverDocs, rideDocs] = await Promise.all([
    Driver.find(driverFilter)
      .select('name phone location heading isOnRide locationUpdatedAt updatedAt vehicleMake vehicleModel vehicleNumber vehicleIconType')
      .limit(5000)
      .lean(),
    Ride.find(rideFilter)
      .select('status liveStatus serviceType trip_category vehicleIconType driverId userId pickupLocation pickupAddress dropLocation dropAddress fare scheduledAt createdAt intercity parcel')
      .sort({ createdAt: -1 })
      .limit(2000)
      .populate('userId', 'name phone')
      .lean(),
  ]);

  const rideByDriver = new Map();
  const rides = rideDocs.map((r) => {
    const kind = describeRideKind(r);
    const scheduled = Boolean(r.scheduledAt && new Date(r.scheduledAt).getTime() > now);
    if (r.driverId && r.status !== 'searching') rideByDriver.set(String(r.driverId), String(r._id));
    return {
      id: String(r._id),
      requestId: String(r._id),
      status: r.status,
      liveStatus: r.liveStatus,
      kind: kind.key,
      kindLabel: kind.label,
      scheduled,
      pickup: { ...(toLatLng(r.pickupLocation) || { lat: null, lng: null }), address: r.pickupAddress || '' },
      drop: { ...(toLatLng(r.dropLocation) || { lat: null, lng: null }), address: r.dropAddress || '' },
      driverId: r.driverId ? String(r.driverId) : null,
      rider: r.userId ? { name: r.userId.name || '', phone: r.userId.phone || '' } : null,
      fare: r.fare ?? 0,
      createdAt: r.createdAt,
    };
  });

  const drivers = driverDocs
    .map((d) => {
      const ll = toLatLng(d.location);
      if (!ll) return null;
      return {
        id: String(d._id),
        name: d.name || '',
        phone: d.phone || '',
        ...ll,
        heading: d.heading !== null && Number.isFinite(Number(d.heading)) ? Number(d.heading) : null,
        isOnRide: Boolean(d.isOnRide) || rideByDriver.has(String(d._id)),
        rideId: rideByDriver.get(String(d._id)) || null,
        vehicle: { label: [d.vehicleMake, d.vehicleModel].filter(Boolean).join(' '), number: d.vehicleNumber || '', type: d.vehicleIconType || '' },
        updatedAt: d.locationUpdatedAt || d.updatedAt || null,
      };
    })
    .filter(Boolean);

  const alertFilter = { status: 'active' };
  if (scope) alertFilter.rideId = { $in: await Ride.find({ service_location_id: { $in: scope } }).distinct('_id') };
  const alertDocs = await SafetyAlert.find(alertFilter).sort({ createdAt: -1 }).limit(200).lean();
  const alerts = alertDocs.map((a) => ({
    id: String(a._id),
    ...(toLatLng(a.location) || { lat: null, lng: null }),
    riderName: a.riderName || '',
    riderPhone: a.riderPhone || '',
    driverName: a.driverName || '',
    driverPhone: a.driverPhone || '',
    tripCode: a.tripCode || '',
    rideId: a.rideId ? String(a.rideId) : null,
    triggeredBy: a.snapshot?.triggeredBy || a.sourceApp,
    createdAt: a.createdAt,
  }));

  const onTrip = drivers.filter((d) => d.isOnRide).length;
  const searching = rides.filter((r) => r.status === 'searching' && !r.scheduled).length;
  return {
    drivers,
    rides,
    alerts,
    counts: {
      onlineDrivers: drivers.length,
      idleDrivers: drivers.length - onTrip,
      onTripDrivers: onTrip,
      searchingRides: searching,
      pendingRequests: searching,
      scheduledRides: rides.filter((r) => r.scheduled).length,
      activeRides: rides.filter((r) => r.status !== 'searching').length,
      openAlerts: alerts.length,
    },
    at: new Date(now).toISOString(),
  };
};
