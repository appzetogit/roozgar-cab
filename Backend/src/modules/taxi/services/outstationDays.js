import mongoose from 'mongoose';
import { ApiError } from '../../../utils/ApiError.js';
import { SetPrice } from '../admin/models/SetPrice.js';
import { isRoundTripValue } from './tollService.js';

/**
 * Multi-day outstation round trip: the rider keeps the cab for several days.
 *
 * Price = the round-trip price of the package row (base_price x 1.8, what a same-day round trip costs) plus the row's
 * `extra_day_price` for every further day. The server works it out itself from the row (the app's fare is ignored for
 * a multi-day booking); tolls are added on top by the booking as for any outstation ride. A trip of 1 day is untouched.
 *
 * After the ride, days kept beyond the booked ones are billed at the same `extra_day_price` (a day = a calendar day in
 * India), so the commission, the advance balance and the driver's collection all follow the final fare.
 */

export const MAX_TRIP_DAYS = 30;
const ROUND_TRIP_FACTOR = 1.8;
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const fail = (message, code) => Object.assign(new ApiError(400, message), { code });

/** Days of a booking: 1 unless it is a round trip with more. Capped at MAX_TRIP_DAYS. */
export const normalizeTripDays = (intercity = {}) => {
  if (!isRoundTripValue(intercity?.tripType)) return 1;
  const days = Math.floor(Number(intercity?.days) || 1);
  return Math.min(MAX_TRIP_DAYS, Math.max(1, days));
};

/** The fare of a round trip of `days` days, before tolls. */
export const outstationDayFare = ({ basePrice, extraDayPrice, days }) =>
  Math.round((Number(basePrice) || 0) * ROUND_TRIP_FACTOR) + Math.max(0, days - 1) * (Number(extraDayPrice) || 0);

/**
 * The server's price of a multi-day booking: { days, extraDayPrice, fare }, or null for a booking of 1 day (the
 * normal flow). A multi-day booking on a vehicle whose row has no extra day price is refused, never given away.
 */
export const resolveOutstationDayQuote = async ({ packageId, vehicleTypeId, intercity }) => {
  const days = normalizeTripDays(intercity);
  if (days <= 1) return null;
  const unavailable = () => fail('Multi-day trips are not available for this vehicle', 'MULTI_DAY_NOT_AVAILABLE');
  if (!mongoose.isValidObjectId(String(packageId || '')) || !mongoose.isValidObjectId(String(vehicleTypeId || ''))) throw unavailable();

  const pkg = await SetPrice.findOne({ _id: packageId, pricing_scope: 'package', package_kind: { $ne: 'hourly_rental' } })
    .select('package_vehicle_prices').lean();
  const row = (pkg?.package_vehicle_prices || []).find((item) => String(item.vehicle_type) === String(vehicleTypeId) && item.active !== 0);
  const extraDayPrice = Number(row?.extra_day_price) || 0;
  if (!row || extraDayPrice <= 0) throw unavailable();
  return { days, extraDayPrice, fare: outstationDayFare({ basePrice: row.base_price, extraDayPrice, days }) };
};

const indiaDayNumber = (date) => Math.floor((new Date(date).getTime() + IST_OFFSET_MS) / DAY_MS);

/** Calendar days (India) from the start of the trip to its end, both included. */
export const actualTripDays = (startedAt, endedAt) => Math.max(1, indiaDayNumber(endedAt) - indiaDayNumber(startedAt) + 1);

/**
 * Bills the days kept beyond the booked ones, once, before the ride is saved as arrived/completed (wallet settlement
 * reads ride.fare). Only multi-day bookings; a 1-day round trip and every other ride are untouched.
 */
export const applyOutstationExtraDays = (ride) => {
  const trip = ride?.intercity;
  if (!ride || ride.serviceType !== 'intercity' || !trip || trip.daysSettledAt) return;
  const bookedDays = Number(trip.days) || 1;
  const extraDayPrice = Number(trip.extraDayPrice) || 0;
  if (bookedDays < 2 || extraDayPrice <= 0) return;

  const endedAt = ride.completedAt || new Date();
  const actualDays = actualTripDays(ride.startedAt || endedAt, endedAt);
  const extraDays = Math.max(0, actualDays - bookedDays);
  trip.actualDays = actualDays;
  trip.extraDays = extraDays;
  trip.extraDayCharge = roundMoney(extraDays * extraDayPrice);
  trip.daysSettledAt = new Date();
  ride.fare = roundMoney(Number(ride.fare || 0) + trip.extraDayCharge);
};

/** Offer-card fields (strings, for FCM): how many days the rider keeps the cab. {} for any other ride. */
export const outstationOfferFields = (ride) => {
  const days = Number(ride?.intercity?.days) || 1;
  if (ride?.serviceType !== 'intercity' || days < 2) return {};
  return { tripDays: String(days), returnDate: String(ride.intercity.returnDate || '') };
};
