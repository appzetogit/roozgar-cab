import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { Driver } from '../models/Driver.js';
import { DriverVehicleRequest } from '../models/DriverVehicleRequest.js';
import { Vehicle } from '../../admin/models/Vehicle.js';
import { emitToDriver } from '../../services/dispatchService.js';
import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';
import { VEHICLE_NUMBER_PATTERNS } from './onboardingService.js';

// A driver's flat vehicle* fields are always the ACTIVE vehicle (dispatch reads
// only those). Driver.vehicles holds every approved vehicle, and switching copies
// one into the flat fields. See the Driver model.

const MAX_VEHICLES = 5; // approved + pending
const MAX_DOCUMENTS = 6;
const FIELDS = [
  'vehicleTypeId', 'vehicleTypeIds', 'vehicleType', 'vehicleIconType',
  'vehicleMake', 'vehicleModel', 'vehicleNumber', 'vehicleColor', 'vehicleImage',
];

const text = (value) => String(value ?? '').trim();
const idOf = (value) => String(value?._id || value || '');

// shortcut: same rule as the existing updateDriverVehicle, kept here so this
// service does not import the 9k-line driver controller; unify if either changes.
const genericVehicleType = (vehicle = {}) => {
  const value = text(vehicle.icon_types || vehicle.name).toLowerCase();
  if (value.includes('bike')) return 'bike';
  if (value.includes('auto')) return 'auto';
  return 'car';
};

const flatSnapshot = (source) =>
  Object.fromEntries(FIELDS.map((key) => [key, key === 'vehicleTypeIds' ? [...(source[key] || [])] : source[key]]));

/** Make sure `vehicles` includes the driver's current vehicle. Lazy, so no migration is needed. */
const ensureVehicleList = (driver) => {
  if (driver.vehicles.length || !driver.vehicleTypeId) return;
  driver.vehicles.push({ ...flatSnapshot(driver), documents: {}, approvedAt: driver.createdAt || new Date() });
  driver.activeVehicleId = driver.vehicles[0]._id;
};

/** Copy edits made to the active vehicle (profile edit, admin edit) back into its list entry. */
const syncActiveEntry = (driver) => {
  const active = driver.vehicles.id(driver.activeVehicleId);
  if (active) Object.assign(active, flatSnapshot(driver));
};

const loadDriver = async (driverId) => {
  const driver = await Driver.findOne({ _id: driverId, deletedAt: null });
  if (!driver) throw new ApiError(404, 'Driver not found');
  return driver;
};

const typeNames = async (docs) => {
  const ids = [...new Set(docs.flatMap((d) => [d.vehicleTypeId, ...(d.vehicleTypeIds || [])]).map(idOf).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await Vehicle.find({ _id: { $in: ids } }).select('name icon map_icon image').lean();
  return new Map(rows.map((row) => [String(row._id), row]));
};

const serializeVehicle = (item, names, extra = {}) => {
  const type = names.get(idOf(item.vehicleTypeId));
  return {
    id: String(item._id),
    vehicleTypeId: item.vehicleTypeId ? idOf(item.vehicleTypeId) : null,
    vehicleTypeIds: (item.vehicleTypeIds || []).map(idOf),
    vehicleTypeName: type?.name || '',
    vehicleType: item.vehicleType || '',
    vehicleIconType: item.vehicleIconType || '',
    vehicleIconUrl: type?.map_icon || type?.icon || type?.image || '',
    vehicleMake: item.vehicleMake || '',
    vehicleModel: item.vehicleModel || '',
    vehicleNumber: item.vehicleNumber || '',
    vehicleColor: item.vehicleColor || '',
    vehicleImage: item.vehicleImage || '',
    documents: item.documents || {},
    ...extra,
  };
};

const notify = (driverId, title, body, type) => {
  emitToDriver(driverId, 'driver:vehicle:updated', { type });
  sendPushNotificationToEntities({ driverIds: [String(driverId)], title, body, data: { type } }).catch((error) => {
    console.error('Failed to send driver vehicle push', error);
  });
};

// ---------------------------------------------------------------- driver side

export const listDriverVehicles = async (driverId) => {
  const driver = await loadDriver(driverId);
  ensureVehicleList(driver);
  syncActiveEntry(driver);
  if (driver.isModified()) await driver.save({ validateModifiedOnly: true });

  const requests = await DriverVehicleRequest.find({
    driverId,
    status: { $in: ['pending', 'rejected'] },
  }).sort({ createdAt: -1 }).limit(20).lean();

  const names = await typeNames([...driver.vehicles, ...requests]);
  const active = idOf(driver.activeVehicleId);

  return {
    activeVehicleId: active || null,
    canAdd: !driver.owner_id && driver.approve !== false &&
      driver.vehicles.length + requests.filter((r) => r.status === 'pending').length < MAX_VEHICLES,
    vehicles: driver.vehicles.map((v) => serializeVehicle(v, names, { isActive: idOf(v._id) === active })),
    requests: requests.map((r) => serializeVehicle(r, names, {
      status: r.status, rejectionReason: r.rejectionReason || '', createdAt: r.createdAt,
    })),
  };
};

const cleanDocuments = (documents) => {
  if (!documents || typeof documents !== 'object' || Array.isArray(documents)) return {};
  const entries = Object.entries(documents)
    .map(([key, value]) => [text(key).slice(0, 40), text(value).slice(0, 600)])
    .filter(([key, value]) => key && value)
    .slice(0, MAX_DOCUMENTS);
  return Object.fromEntries(entries);
};

export const requestDriverVehicle = async (driverId, body = {}) => {
  const driver = await loadDriver(driverId);
  if (driver.owner_id) throw new ApiError(403, 'Fleet drivers use the vehicle their owner assigned');
  if (driver.approve === false) {
    throw new ApiError(409, 'Your account is still waiting for approval. Update your vehicle from your profile instead.');
  }

  const requestedIds = [...new Set(
    [...(Array.isArray(body.vehicleTypeIds) ? body.vehicleTypeIds : []), body.vehicleTypeId]
      .map(text).filter(Boolean),
  )];
  if (!requestedIds.length || requestedIds.some((id) => !mongoose.isValidObjectId(id))) {
    throw new ApiError(400, 'Choose a vehicle type');
  }

  const found = await Vehicle.find({ _id: { $in: requestedIds } });
  const ordered = requestedIds.map((id) => found.find((v) => String(v._id) === id)).filter(Boolean);
  if (ordered.length !== requestedIds.length || ordered.some((v) => v.active === false || Number(v.status) === 0)) {
    throw new ApiError(404, 'Active vehicle type not found');
  }

  const vehicleNumber = text(body.vehicleNumber).toUpperCase().replace(/[\s-]/g, '');
  if (!vehicleNumber) throw new ApiError(400, 'Vehicle number is required');
  if (!VEHICLE_NUMBER_PATTERNS.some((pattern) => pattern.test(vehicleNumber))) {
    throw new ApiError(400, 'Vehicle number must be in a valid format, for example MH12AB1234, DL1ABCD1234, KA651635, or 22BH1234AA');
  }
  const vehicleColor = text(body.vehicleColor);
  if (!vehicleColor) throw new ApiError(400, 'Vehicle color is required');

  ensureVehicleList(driver);
  syncActiveEntry(driver);

  const pending = await DriverVehicleRequest.countDocuments({ driverId, status: 'pending' });
  if (driver.vehicles.length + pending >= MAX_VEHICLES) {
    throw new ApiError(409, `You can have at most ${MAX_VEHICLES} vehicles`);
  }

  const taken = await Driver.exists({
    deletedAt: null,
    $or: [{ vehicleNumber }, { 'vehicles.vehicleNumber': vehicleNumber }],
  });
  if (taken || await DriverVehicleRequest.exists({ vehicleNumber, status: 'pending' })) {
    throw new ApiError(409, 'This vehicle number is already registered or waiting for approval');
  }

  const primary = ordered[0];
  const request = await DriverVehicleRequest.create({
    driverId,
    vehicleTypeId: primary._id,
    vehicleTypeIds: ordered.map((v) => v._id),
    vehicleType: genericVehicleType(primary),
    vehicleIconType: primary.icon_types || genericVehicleType(primary),
    vehicleMake: text(body.vehicleMake),
    vehicleModel: text(body.vehicleModel),
    vehicleNumber,
    vehicleColor,
    vehicleImage: text(body.vehicleImage),
    documents: cleanDocuments(body.documents),
  });
  if (driver.isModified()) await driver.save({ validateModifiedOnly: true });

  const names = await typeNames([request]);
  return serializeVehicle(request, names, { status: request.status, createdAt: request.createdAt });
};

export const cancelDriverVehicleRequest = async (driverId, requestId) => {
  const request = await DriverVehicleRequest.findOneAndUpdate(
    { _id: requestId, driverId, status: 'pending' },
    { status: 'cancelled' },
    { returnDocument: 'after' },
  );
  if (!request) throw new ApiError(404, 'Pending vehicle request not found');
  return { id: String(request._id), status: request.status };
};

export const activateDriverVehicle = async (driverId, vehicleId) => {
  const driver = await loadDriver(driverId);
  ensureVehicleList(driver);
  const entry = driver.vehicles.id(vehicleId);
  if (!entry) throw new ApiError(404, 'Vehicle not found');

  if (idOf(driver.activeVehicleId) !== idOf(entry._id)) {
    if (driver.isOnRide) throw new ApiError(409, 'Finish your current ride before switching vehicle');
    syncActiveEntry(driver); // keep edits made to the vehicle we are leaving
    Object.assign(driver, flatSnapshot(entry));
    driver.activeVehicleId = entry._id;
    await driver.save({ validateModifiedOnly: true });
  }
  return listDriverVehicles(driverId);
};

export const removeDriverVehicle = async (driverId, vehicleId) => {
  const driver = await loadDriver(driverId);
  ensureVehicleList(driver);
  const entry = driver.vehicles.id(vehicleId);
  if (!entry) throw new ApiError(404, 'Vehicle not found');
  if (idOf(driver.activeVehicleId) === idOf(entry._id)) {
    throw new ApiError(409, 'Switch to another vehicle before removing this one');
  }
  entry.deleteOne();
  await driver.save({ validateModifiedOnly: true });
  return listDriverVehicles(driverId);
};

// ----------------------------------------------------------------- admin side

const serializeRequestForAdmin = (request, driver, names) => ({
  ...serializeVehicle(request, names),
  status: request.status,
  rejectionReason: request.rejectionReason || '',
  createdAt: request.createdAt,
  reviewedAt: request.reviewedAt || null,
  driver: driver
    ? {
      id: String(driver._id),
      name: driver.name || '',
      phone: driver.phone || '',
      currentVehicleNumber: driver.vehicleNumber || '',
      vehicleCount: Math.max(1, driver.vehicles?.length || 0),
    }
    : null,
});

export const listDriverVehicleRequests = async ({ page = 1, limit = 50, status = 'pending', search = '' } = {}) => {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const wanted = text(status || 'pending').toLowerCase();
  const query = wanted === 'all' ? { status: { $in: ['pending', 'approved', 'rejected'] } } : { status: wanted };

  const term = text(search);
  if (term) {
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const matching = await Driver.find({ deletedAt: null, $or: [{ name: pattern }, { phone: pattern }] })
      .select('_id').limit(200).lean();
    query.$or = [{ vehicleNumber: pattern }, { driverId: { $in: matching.map((d) => d._id) } }];
  }

  const [requests, total, pendingCount] = await Promise.all([
    DriverVehicleRequest.find(query).sort({ createdAt: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    DriverVehicleRequest.countDocuments(query),
    DriverVehicleRequest.countDocuments({ status: 'pending' }),
  ]);

  const drivers = await Driver.find({ _id: { $in: requests.map((r) => r.driverId) } })
    .select('name phone vehicleNumber vehicles.vehicleNumber').lean();
  const driverById = new Map(drivers.map((d) => [String(d._id), d]));
  const names = await typeNames(requests);

  return {
    results: requests.map((r) => serializeRequestForAdmin(r, driverById.get(String(r.driverId)), names)),
    pendingCount,
    paginator: {
      current_page: safePage,
      per_page: safeLimit,
      total,
      last_page: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
};

export const approveDriverVehicleRequest = async (requestId, adminId = null) => {
  // Claim it first so two admins approving at once cannot add the vehicle twice.
  const request = await DriverVehicleRequest.findOneAndUpdate(
    { _id: requestId, status: 'pending' },
    { status: 'approved', reviewedBy: adminId || null, reviewedAt: new Date() },
    { returnDocument: 'after' },
  );
  if (!request) throw new ApiError(404, 'Pending vehicle request not found');

  const driver = await Driver.findOne({ _id: request.driverId, deletedAt: null });
  const taken = driver && await Driver.exists({
    _id: { $ne: driver._id },
    deletedAt: null,
    $or: [{ vehicleNumber: request.vehicleNumber }, { 'vehicles.vehicleNumber': request.vehicleNumber }],
  });
  if (!driver || taken) {
    await DriverVehicleRequest.updateOne({ _id: request._id }, { status: 'pending', reviewedBy: null, reviewedAt: null });
    throw new ApiError(409, driver ? 'This vehicle number now belongs to another driver' : 'Driver no longer exists');
  }

  ensureVehicleList(driver);
  syncActiveEntry(driver);
  driver.vehicles.push({ ...flatSnapshot(request), documents: request.documents || {}, approvedAt: new Date() });
  const entry = driver.vehicles[driver.vehicles.length - 1];
  await driver.save({ validateModifiedOnly: true });
  await DriverVehicleRequest.updateOne({ _id: request._id }, { vehicleEntryId: entry._id });

  notify(
    driver._id,
    'Vehicle approved',
    `${request.vehicleNumber} is approved. Switch to it from your vehicles to receive its bookings.`,
    'driver_vehicle_approved',
  );
  return { id: String(request._id), status: 'approved', vehicleId: String(entry._id) };
};

export const rejectDriverVehicleRequest = async (requestId, { reason = '' } = {}, adminId = null) => {
  const request = await DriverVehicleRequest.findOneAndUpdate(
    { _id: requestId, status: 'pending' },
    { status: 'rejected', rejectionReason: text(reason).slice(0, 300), reviewedBy: adminId || null, reviewedAt: new Date() },
    { returnDocument: 'after' },
  );
  if (!request) throw new ApiError(404, 'Pending vehicle request not found');

  notify(request.driverId, 'Vehicle not approved', text(reason) || `${request.vehicleNumber} was not approved.`, 'driver_vehicle_rejected');
  return { id: String(request._id), status: 'rejected' };
};
