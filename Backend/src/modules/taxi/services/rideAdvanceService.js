import mongoose from 'mongoose';
import { ApiError } from '../../../utils/ApiError.js';
import { SetPrice } from '../admin/models/SetPrice.js';
import { Ride } from '../user/models/Ride.js';
import { RideAdvance } from '../user/models/RideAdvance.js';
import { resolveConfiguredGatewayCredentials } from './paymentGatewayService.js';

/**
 * Outstation advance. The admin sets, on each outstation price row (one vehicle of one package), what the rider must
 * pay online before the booking exists: a percentage of the fare or a fixed amount. The rider pays it (Razorpay),
 * the booking is created with it, the rest of the fare is paid after the ride, and a cancelled ride gets it all back.
 *
 * Money after the ride: the platform holds the advance, so the driver (or the fleet owner) is credited
 * `advance - commission` at settlement and collects the rest in cash (see walletService); if the rider pays the rest
 * online it is credited to them as before.
 */

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const idText = (value) => String(value?._id || value || '');

// An ApiError with a top-level `code` (the error handler reads it) and the numbers the app needs in `details`.
const advanceError = (status, message, code, details = null) => Object.assign(new ApiError(status, message, details), { code });

/** The advance in rupees for a fare: a percentage of it, or a fixed amount, never more than the fare. 0 when not set. */
export const computeAdvanceAmount = ({ type, value, fare }) => {
  const safeFare = Math.max(0, Math.round(Number(fare) || 0));
  const safeValue = Math.max(0, Number(value) || 0);
  if (!safeFare || !safeValue) return 0;
  const amount = String(type).toLowerCase() === 'fixed' ? Math.round(safeValue) : Math.round((safeFare * Math.min(100, safeValue)) / 100);
  return Math.min(safeFare, Math.max(0, amount));
};

/** What the rider has already paid toward this ride (0 unless an advance stands), capped at the fare. */
export const appliedAdvanceAmount = (ride) => {
  if (!ride?.advance || ride.advance.status !== 'applied') return 0;
  return Math.min(roundMoney(ride.advance.amount), roundMoney(ride.fare));
};

/** What is left to pay after the ride. */
export const amountDueAfterAdvance = (ride) => Math.max(0, roundMoney(roundMoney(ride?.fare) - appliedAdvanceAmount(ride)));

/**
 * The advance rule for an outstation booking: the price row of this vehicle in this package. The app sends the
 * package id; if it does not (or it is stale) the package is found by the vehicle, the pickup's service location and
 * the destination city, so leaving the id out does not skip the advance.
 */
export const findAdvanceRule = async ({ packageId = '', vehicleTypeId, toCity = '', serviceLocationId = null }) => {
  if (!vehicleTypeId || !mongoose.isValidObjectId(String(vehicleTypeId))) return null;
  const vehicleId = String(vehicleTypeId);
  const base = { pricing_scope: 'package', package_kind: { $ne: 'hourly_rental' }, active: 1, status: 'active', package_availability: 'available' };

  let packages = [];
  if (packageId && mongoose.isValidObjectId(String(packageId))) {
    packages = await SetPrice.find({ ...base, _id: packageId }).lean();
  }
  if (!packages.length) {
    const city = String(toCity || '').trim().toLowerCase();
    if (!city) return null;
    const candidates = await SetPrice.find({
      ...base,
      'package_vehicle_prices.vehicle_type': vehicleId,
      ...(serviceLocationId && mongoose.isValidObjectId(String(serviceLocationId)) ? { service_location_id: serviceLocationId } : {}),
    }).lean();
    packages = candidates.filter((item) => String(item.package_destination || '').trim().toLowerCase() === city);
  }

  for (const item of packages) {
    const row = (item.package_vehicle_prices || []).find((entry) => idText(entry.vehicle_type) === vehicleId && entry.active !== 0);
    if (row) {
      return {
        packageId: idText(item._id),
        type: row.advance_type === 'fixed' ? 'fixed' : 'percentage',
        value: Math.max(0, Number(row.advance_value) || 0),
      };
    }
  }
  return null;
};

/** What a booking needs to pay up front: { required, amount, remaining, type, value, packageId }. */
export const quoteAdvance = async ({ packageId, vehicleTypeId, toCity, serviceLocationId, fare }) => {
  const rule = await findAdvanceRule({ packageId, vehicleTypeId, toCity, serviceLocationId });
  const safeFare = Math.max(0, Math.round(Number(fare) || 0));
  const amount = rule ? computeAdvanceAmount({ type: rule.type, value: rule.value, fare: safeFare }) : 0;
  return {
    required: amount > 0,
    amount,
    remaining: Math.max(0, safeFare - amount),
    fare: safeFare,
    type: rule?.type || 'percentage',
    value: rule?.value || 0,
    packageId: rule?.packageId || '',
  };
};

/** Creates the record the Razorpay order is attached to. Older unpaid ones for this rider are retired. */
export const createAdvanceRecord = async ({ userId, quote, vehicleTypeId }) => {
  if (!quote.required) throw advanceError(400, 'No advance is needed for this booking', 'ADVANCE_NOT_REQUIRED');
  await RideAdvance.updateMany({ userId, status: 'created' }, { $set: { status: 'expired' } });
  return RideAdvance.create({
    userId,
    packageId: quote.packageId || null,
    vehicleTypeId,
    fare: quote.fare,
    advanceType: quote.type,
    advanceValue: quote.value,
    amount: quote.amount,
  });
};

/** Razorpay confirmed the payment. Once: a repeat finds it already paid. */
export const markAdvancePaid = async ({ advanceId, userId, orderId, paymentId }) => {
  const paid = await RideAdvance.findOneAndUpdate(
    { _id: advanceId, userId, razorpayOrderId: orderId, status: 'created' },
    { $set: { status: 'paid', razorpayPaymentId: paymentId, paidAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (paid) return paid;
  const existing = await RideAdvance.findOne({ _id: advanceId, userId, razorpayOrderId: orderId });
  if (existing && existing.razorpayPaymentId === paymentId && ['paid', 'used'].includes(existing.status)) return existing;
  throw advanceError(404, 'Advance payment not found', 'ADVANCE_NOT_FOUND');
};

/**
 * A booking uses a paid advance. Checked against the amount the server works out for this booking (never the app's),
 * and claimed atomically so one payment cannot start two rides. The caller attaches it to the ride, or releases it.
 */
export const claimAdvance = async ({ advanceId, userId, vehicleTypeId, required }) => {
  const fail = (message, code = 'ADVANCE_REQUIRED') =>
    advanceError(402, message, code, { amount: required.amount, remaining: required.remaining, fare: required.fare, packageId: required.packageId });

  if (!advanceId || !mongoose.isValidObjectId(String(advanceId))) {
    throw fail(`Pay the Rs ${required.amount} advance to book this outstation ride`);
  }
  const claimed = await RideAdvance.findOneAndUpdate(
    { _id: advanceId, userId, status: 'paid', rideId: null, vehicleTypeId, amount: required.amount },
    { $set: { status: 'used', usedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (claimed) return claimed;

  const existing = await RideAdvance.findOne({ _id: advanceId, userId }).lean();
  if (!existing) throw fail('Advance payment not found');
  if (existing.status === 'used') throw fail('This advance was already used for a booking', 'ADVANCE_ALREADY_USED');
  if (existing.status !== 'paid') throw fail('The advance payment is not completed yet');
  throw fail('The advance does not match this booking. The fare changed, so pay the new advance', 'ADVANCE_MISMATCH');
};

export const linkAdvanceToRide = (advanceId, rideId) => RideAdvance.updateOne({ _id: advanceId }, { $set: { rideId } });

/** The booking could not be created: the payment goes back to "paid" so it can be used again (or is refunded later). */
export const releaseAdvance = (advanceId) =>
  RideAdvance.updateOne({ _id: advanceId, status: 'used', rideId: null }, { $set: { status: 'paid', usedAt: null } });

// ----------------------------------------------------------------------------- refunds

const razorpayRefund = async ({ paymentId, amount, advanceId }) => {
  const { keyId, keySecret } = await resolveConfiguredGatewayCredentials('razor_pay');
  const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount: Math.round(roundMoney(amount) * 100), speed: 'normal', notes: { advanceId: String(advanceId), reason: 'outstation advance refund' } }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.description || payload?.error?.message || 'Razorpay refund failed';
    // Already refunded (a retry after a dropped answer): that is the outcome we want.
    if (/already (been )?(fully )?refunded|fully refunded/i.test(message)) return { id: 'already_refunded' };
    throw new Error(message);
  }
  return payload;
};

// The claim is the atomic status change; only one instance (or retry) refunds a given advance.
const refundOne = async (advance, refund) => {
  const claimed = await RideAdvance.findOneAndUpdate(
    { _id: advance._id, status: { $in: ['used', 'paid', 'refund_failed', 'refunding'] } },
    { $set: { status: 'refunding' }, $inc: { refundAttempts: 1 } },
    { returnDocument: 'after' },
  );
  if (!claimed) return null;
  try {
    const result = await refund({ paymentId: claimed.razorpayPaymentId, amount: claimed.amount, advanceId: claimed._id });
    await RideAdvance.updateOne({ _id: claimed._id }, { $set: { status: 'refunded', refundId: String(result?.id || ''), refundedAt: new Date(), refundError: '' } });
    if (claimed.rideId) await Ride.updateOne({ _id: claimed.rideId }, { $set: { 'advance.status': 'refunded' } });
    return { advanceId: String(claimed._id), refunded: true };
  } catch (error) {
    await RideAdvance.updateOne({ _id: claimed._id }, { $set: { status: 'refund_failed', refundError: String(error?.message || error).slice(0, 300) } });
    if (claimed.rideId) await Ride.updateOne({ _id: claimed.rideId }, { $set: { 'advance.status': 'refund_failed' } });
    return { advanceId: String(claimed._id), refunded: false, error: String(error?.message || error) };
  }
};

/** A ride was cancelled: the whole advance goes back. Safe to call any number of times. */
export const refundRideAdvance = async (rideId, { refund = razorpayRefund } = {}) => {
  const advance = await RideAdvance.findOne({ rideId, status: { $in: ['used', 'refund_failed'] } });
  return advance ? refundOne(advance, refund) : null;
};

const MAX_REFUND_ATTEMPTS = 8;
const UNUSED_PAID_AFTER_MS = 30 * 60 * 1000;
const STUCK_REFUNDING_MS = 10 * 60 * 1000;

/**
 * The safety net, run on a timer: refunds the advance of every cancelled ride (however it was cancelled), retries
 * refunds that failed, and returns money a rider paid but never used (the booking did not happen).
 */
export const sweepAdvanceRefunds = async ({ refund = razorpayRefund } = {}) => {
  const now = Date.now();
  let refunded = 0;

  const withRides = await RideAdvance.find({ status: { $in: ['used', 'refund_failed'] }, rideId: { $ne: null }, refundAttempts: { $lt: MAX_REFUND_ATTEMPTS } })
    .limit(100);
  if (withRides.length) {
    const cancelled = new Set((await Ride.find({ _id: { $in: withRides.map((item) => item.rideId) }, status: 'cancelled' }).select('_id').lean()).map((ride) => idText(ride._id)));
    for (const advance of withRides) {
      if (!cancelled.has(idText(advance.rideId))) continue;
      const outcome = await refundOne(advance, refund);
      if (outcome?.refunded) refunded += 1;
    }
  }

  const unused = await RideAdvance.find({ status: 'paid', rideId: null, paidAt: { $lte: new Date(now - UNUSED_PAID_AFTER_MS) }, refundAttempts: { $lt: MAX_REFUND_ATTEMPTS } }).limit(50);
  for (const advance of unused) {
    const outcome = await refundOne(advance, refund);
    if (outcome?.refunded) refunded += 1;
  }

  const stuck = await RideAdvance.find({ status: 'refunding', updatedAt: { $lte: new Date(now - STUCK_REFUNDING_MS) }, refundAttempts: { $lt: MAX_REFUND_ATTEMPTS } }).limit(50);
  for (const advance of stuck) {
    const outcome = await refundOne(advance, refund);
    if (outcome?.refunded) refunded += 1;
  }
  return { refunded };
};

let sweepTimer = null;
export const startAdvanceRefundLoop = () => {
  if (sweepTimer) return;
  const run = () => sweepAdvanceRefunds().catch((error) => console.error('Advance refund sweep failed', error));
  sweepTimer = setInterval(run, 60 * 1000);
  sweepTimer.unref?.();
  run();
};
