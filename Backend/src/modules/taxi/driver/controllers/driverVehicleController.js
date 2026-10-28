import { asyncHandler } from '../../../../utils/asyncHandler.js';
import {
  activateDriverVehicle,
  approveDriverVehicleRequest,
  cancelDriverVehicleRequest,
  listDriverVehicleRequests,
  listDriverVehicles,
  rejectDriverVehicleRequest,
  removeDriverVehicle,
  requestDriverVehicle,
} from '../services/driverVehicleService.js';

const driverId = (req) => req.auth.sub;
const send = (res, data, message = '', status = 200) => res.status(status).json({ success: true, message, data });

// ---- driver app (/drivers/vehicles...)
export const getMyVehicles = asyncHandler(async (req, res) => send(res, await listDriverVehicles(driverId(req))));

export const addMyVehicle = asyncHandler(async (req, res) =>
  send(res, await requestDriverVehicle(driverId(req), req.body), 'Vehicle sent to admin for approval', 201));

export const cancelMyVehicleRequest = asyncHandler(async (req, res) =>
  send(res, await cancelDriverVehicleRequest(driverId(req), req.params.requestId), 'Request cancelled'));

export const activateMyVehicle = asyncHandler(async (req, res) =>
  send(res, await activateDriverVehicle(driverId(req), req.params.vehicleId), 'Vehicle switched'));

export const removeMyVehicle = asyncHandler(async (req, res) =>
  send(res, await removeDriverVehicle(driverId(req), req.params.vehicleId), 'Vehicle removed'));

// ---- admin panel (/admin/drivers/vehicle-requests...)
export const getVehicleRequests = asyncHandler(async (req, res) =>
  send(res, await listDriverVehicleRequests(req.query)));

export const approveVehicleRequest = asyncHandler(async (req, res) =>
  send(res, await approveDriverVehicleRequest(req.params.id, req.auth?.sub), 'Vehicle approved'));

export const rejectVehicleRequest = asyncHandler(async (req, res) =>
  send(res, await rejectDriverVehicleRequest(req.params.id, req.body, req.auth?.sub), 'Vehicle rejected'));
