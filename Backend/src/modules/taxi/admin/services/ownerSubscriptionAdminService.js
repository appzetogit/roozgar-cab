import { ApiError } from '../../../../utils/ApiError.js';
import { Owner } from '../models/Owner.js';
import { OwnerSubscription } from '../models/OwnerSubscription.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { SetPrice } from '../models/SetPrice.js';
import { Vehicle } from '../models/Vehicle.js';
import { Driver } from '../../driver/models/Driver.js';
import {
  getOwnerServiceStatus,
  grantOwnerSubscription,
  setOwnerBillingMode,
} from '../../driver/services/ownerBillingService.js';

// Admin side of owner billing: the plans owners can buy, what they paid, a
// per-owner status, and manual grant / mode override. Mirrors the driver
// subscription admin; commission itself is set where it always was (price and
// vehicle-type "owner commission" fields).

export const listOwnerPlansAdmin = async () =>
  SubscriptionPlan.find({ audience: 'owner' }).sort({ amount: 1 }).lean();

export const createOwnerPlan = async (payload = {}) => {
  if (!String(payload.name || '').trim()) throw new ApiError(400, 'Plan name is required');
  const plan = await SubscriptionPlan.create({
    name: String(payload.name).trim(),
    description: payload.description || '',
    how_it_works: payload.how_it_works || '',
    audience: 'owner',
    amount: Math.max(0, Number(payload.amount || 0)),
    duration: Math.max(1, Math.floor(Number(payload.duration || 30))),
    benefit_type: 'standard',
    ride_limit: 0,
    active: payload.active === undefined ? true : Boolean(payload.active),
  });
  return plan.toObject();
};

export const updateOwnerPlan = async (id, payload = {}) => {
  const update = {};
  for (const key of ['name', 'description', 'how_it_works']) if (payload[key] !== undefined) update[key] = payload[key];
  if (payload.amount !== undefined) update.amount = Math.max(0, Number(payload.amount || 0));
  if (payload.duration !== undefined) update.duration = Math.max(1, Math.floor(Number(payload.duration || 1)));
  if (payload.active !== undefined) update.active = Boolean(payload.active);
  const plan = await SubscriptionPlan.findOneAndUpdate({ _id: id, audience: 'owner' }, { $set: update }, { returnDocument: 'after' }).lean();
  if (!plan) throw new ApiError(404, 'Owner plan not found');
  return plan;
};

export const deleteOwnerPlan = async (id) => {
  const plan = await SubscriptionPlan.findOneAndDelete({ _id: id, audience: 'owner' }).lean();
  if (!plan) throw new ApiError(404, 'Owner plan not found');
  return plan;
};

export const listOwnerSubscriptionPayments = async ({ page = 1, limit = 25, ownerId = '', status = '' } = {}) => {
  const query = { paidAt: { $ne: null } };
  if (ownerId) query.ownerId = ownerId;
  if (status === 'active') {
    query.status = 'active';
    query.expiresAt = { $gt: new Date() };
  } else if (status === 'expired') {
    query.expiresAt = { $lte: new Date() };
  }
  const pageNumber = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 25));
  const [rows, total, revenue] = await Promise.all([
    OwnerSubscription.find(query).sort({ paidAt: -1 }).skip((pageNumber - 1) * pageSize).limit(pageSize)
      .populate('ownerId', 'name owner_name company_name mobile').lean(),
    OwnerSubscription.countDocuments(query),
    OwnerSubscription.aggregate([{ $match: query }, { $group: { _id: null, amount: { $sum: '$amount' } } }]),
  ]);
  const now = Date.now();
  return {
    results: rows.map((row) => ({
      id: String(row._id),
      ownerId: String(row.ownerId?._id || ''),
      ownerName: row.ownerId?.company_name || row.ownerId?.owner_name || row.ownerId?.name || 'Owner',
      ownerPhone: row.ownerId?.mobile || '',
      planName: row.planName,
      amount: row.amount,
      paymentMethod: row.paymentMethod,
      paidAt: row.paidAt,
      startsAt: row.startsAt,
      expiresAt: row.expiresAt,
      active: row.status === 'active' && new Date(row.expiresAt).getTime() > now,
      tripsCovered: row.tripsCovered,
      commissionWaived: row.commissionWaived,
    })),
    total,
    page: pageNumber,
    limit: pageSize,
    collected: revenue[0]?.amount || 0,
  };
};

/** Every owner with how they pay now, whether their fleet is working, and when the plan ends. */
export const listOwnerBillingOverview = async () => {
  const owners = await Owner.find({ deletedAt: null }).select('name owner_name company_name mobile billing wallet active').sort({ createdAt: -1 }).lean();
  const fleet = await Driver.aggregate([
    { $match: { owner_id: { $ne: null }, deletedAt: null } },
    { $group: { _id: '$owner_id', drivers: { $sum: 1 } } },
  ]);
  const fleetBy = new Map(fleet.map((row) => [String(row._id), row.drivers]));
  const rows = [];
  for (const owner of owners) {
    const status = await getOwnerServiceStatus(owner._id);
    rows.push({
      id: String(owner._id),
      name: owner.company_name || owner.owner_name || owner.name || 'Owner',
      phone: owner.mobile || '',
      mode: status.mode,
      serviceActive: status.active,
      expiresAt: status.subscription?.expiresAt || null,
      planName: status.subscription?.planName || '',
      drivers: fleetBy.get(String(owner._id)) || 0,
      walletBalance: Number(owner.wallet?.balance || 0),
    });
  }
  return { results: rows };
};

export const grantOwnerPlan = async (payload = {}) => grantOwnerSubscription(payload);

export const setOwnerMode = async (ownerId, mode) => setOwnerBillingMode(ownerId, mode);

// ---------------------------------------------------------------- owner commission
// The commission the platform takes on a fleet ride when the owner runs on commission
// (an owner on a plan pays none). It lives on every price row, rental package row and
// vehicle type as admin_commission_*_for_owner; these two calls show and set it in one place.
// Type 1 = percentage of the fare, 2 = fixed rupees per ride.

export const getOwnerCommissionSummary = async () => {
  const [prices, vehicles, packages] = await Promise.all([
    SetPrice.aggregate([
      { $match: { pricing_scope: { $ne: 'package' } } },
      { $group: { _id: { type: '$admin_commission_type_for_owner', value: '$admin_commission_for_owner' }, rows: { $sum: 1 } } },
    ]),
    Vehicle.aggregate([
      { $group: { _id: { type: '$admin_commission_type_for_owner', value: '$admin_commission_for_owner' }, rows: { $sum: 1 } } },
    ]),
    SetPrice.aggregate([
      { $match: { pricing_scope: 'package' } },
      { $unwind: '$package_vehicle_prices' },
      { $group: { _id: { type: '$package_vehicle_prices.admin_commission_type_for_owner', value: '$package_vehicle_prices.admin_commission_for_owner' }, rows: { $sum: 1 } } },
    ]),
  ]);
  const shape = (list) => list
    .map((row) => ({ type: Number(row._id.type ?? 1) === 1 ? 'percentage' : 'fixed', value: Number(row._id.value || 0), rows: row.rows }))
    .sort((a, b) => b.rows - a.rows);
  return { prices: shape(prices), vehicleTypes: shape(vehicles), packages: shape(packages) };
};

export const applyOwnerCommission = async ({ type, value } = {}) => {
  const typeNumber = String(type).toLowerCase() === 'fixed' || Number(type) === 2 ? 2 : 1;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new ApiError(400, 'Commission must be a number, 0 or more');
  if (typeNumber === 1 && amount > 100) throw new ApiError(400, 'A percentage cannot be more than 100');

  const set = { admin_commission_type_for_owner: typeNumber, admin_commission_for_owner: amount };
  const [prices, vehicles] = await Promise.all([
    SetPrice.updateMany({ pricing_scope: { $ne: 'package' } }, { $set: set }),
    Vehicle.updateMany({}, { $set: set }),
  ]);
  const packages = await SetPrice.updateMany(
    { pricing_scope: 'package' },
    { $set: { 'package_vehicle_prices.$[].admin_commission_type_for_owner': typeNumber, 'package_vehicle_prices.$[].admin_commission_for_owner': amount } },
  );
  return {
    type: typeNumber === 1 ? 'percentage' : 'fixed',
    value: amount,
    updated: { prices: prices.modifiedCount, vehicleTypes: vehicles.modifiedCount, packageGroups: packages.modifiedCount },
  };
};
