import { ApiError } from '../../../../utils/ApiError.js';
import { Ride } from '../../user/models/Ride.js';
import { RideBid } from '../../user/models/RideBid.js';
import { RideAdvance } from '../../user/models/RideAdvance.js';
import { WalletTransaction } from '../../driver/models/WalletTransaction.js';
import { OwnerWalletTransaction } from '../models/OwnerWalletTransaction.js';
import { Owner } from '../models/Owner.js';
import { SetPrice } from '../models/SetPrice.js';

/**
 * The admin's view of ONE request in full: who, what kind, where, the fare and how it was built, the offers, the payment and the
 * advance, what was settled, and everything that happened in order. Used by the Trip Requests, Deliveries and Ongoing pages.
 * Nothing secret (OTP) is returned.
 */

const idText = (value) => String(value?._id || value || '');
const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const km = (meters) => Math.round(((Number(meters) || 0) / 1000) * 10) / 10;
const pointOf = (location) => {
  const [lng, lat] = location?.coordinates || [];
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
};

/** What kind of request this is, in words an admin reads at a glance. */
export const describeRideKind = (ride = {}) => {
  const serviceType = String(ride.serviceType || 'ride').toLowerCase();
  const family = String(ride.vehicleTypeId?.icon_types || ride.vehicleIconType || '').toLowerCase();
  if (serviceType === 'parcel') {
    const outstation = ride.parcel?.deliveryScope === 'outstation' || ride.parcel?.isOutstation;
    return { key: 'parcel', label: outstation ? 'Parcel (Outstation)' : 'Parcel Delivery', tone: 'purple' };
  }
  if (serviceType === 'intercity') {
    const roundTrip = /round/i.test(String(ride.intercity?.tripType || ''));
    return { key: 'outstation', label: roundTrip ? 'Outstation (Round trip)' : 'Outstation (One way)', tone: 'blue' };
  }
  if (serviceType === 'hourly_rental') return { key: 'rental', label: 'Hourly Rental', tone: 'amber' };
  if (String(ride.trip_category?.category || '') === 'airport') return { key: 'airport', label: 'Airport Ride', tone: 'sky' };
  if (family === 'bike' || family === 'scooty') return { key: 'bike', label: 'Bike Taxi', tone: 'green' };
  if (family === 'auto') return { key: 'auto', label: 'Auto', tone: 'green' };
  return { key: 'city', label: 'City Ride', tone: 'slate' };
};

/** Mongo filter for a kind chip on the list pages (all kinds are 'ride' unless they say otherwise). */
export const rideKindFilter = (kind) => {
  switch (String(kind || '').toLowerCase()) {
    case 'outstation': return { serviceType: 'intercity' };
    case 'rental': return { serviceType: 'hourly_rental' };
    case 'parcel': return { serviceType: 'parcel' };
    case 'airport': return { serviceType: 'ride', 'trip_category.category': 'airport' };
    case 'city': return { serviceType: 'ride', 'trip_category.category': { $ne: 'airport' } };
    default: return {};
  }
};

const labelStatus = (ride) => {
  const status = String(ride.status || '').toLowerCase();
  const live = String(ride.liveStatus || '').toLowerCase();
  if (status === 'completed') return 'Completed';
  if (status === 'cancelled') return 'Cancelled';
  if (live === 'started' || status === 'ongoing') return 'Trip started';
  if (live === 'arrived') return 'Driver arrived';
  if (live === 'arriving') return 'Driver on the way';
  if (status === 'accepted') return 'Driver assigned';
  return ride.scheduledAt && new Date(ride.scheduledAt).getTime() > Date.now() ? 'Scheduled, finding a driver' : 'Searching for a driver';
};

const paymentWords = (ride) => {
  const method = String(ride.paymentMethod || 'cash').toLowerCase();
  const via = String(ride.collectedVia || '').toLowerCase();
  const collection = ride.driverPaymentCollection || {};
  const paid = Boolean(collection.paidAt) || String(collection.status || '').toLowerCase() === 'paid';
  return {
    method,
    methodLabel: method === 'cash' ? 'Cash' : method === 'online' ? 'Online' : method.charAt(0).toUpperCase() + method.slice(1),
    collectedVia: via,
    collectedLabel: via === 'online' ? 'Paid online in the app' : via === 'upi' ? 'UPI to the driver' : via === 'cash' ? 'Cash to the driver' : '',
    collection: {
      status: collection.status || '',
      provider: collection.provider || '',
      source: collection.source || '',
      amount: money(collection.amount),
      paidAt: collection.paidAt || null,
      providerPaymentId: collection.providerPaymentId || '',
    },
    paid,
  };
};

export const getAdminRideDetails = async (id) => {
  const ride = await Ride.findById(id)
    .populate('userId', 'name phone email profileImage')
    .populate('driverId', 'name phone email vehicleType vehicleNumber vehicleColor vehicleMake vehicleModel vehicleImage rating owner_id profileImage')
    .populate('vehicleTypeId', 'name icon_types capacity')
    .populate('deliveryId')
    .lean();
  if (!ride) throw new ApiError(404, 'Request not found');

  const setPriceId = ride.pricingSnapshot?.setPriceId;
  const [bids, advance, driverTransactions, ownerTransactions, owner, tariff] = await Promise.all([
    RideBid.find({ rideId: ride._id }).populate('driverId', 'name phone').sort({ createdAt: 1 }).lean(),
    RideAdvance.findOne({ rideId: ride._id }).lean(),
    WalletTransaction.find({ rideId: ride._id }).sort({ createdAt: 1 }).lean(),
    OwnerWalletTransaction.find({ rideId: ride._id }).sort({ createdAt: 1 }).lean(),
    ride.driverId?.owner_id ? Owner.findById(ride.driverId.owner_id).select('company_name owner_name name mobile').lean() : null,
    setPriceId ? SetPrice.findById(setPriceId).select('base_price base_distance price_per_distance time_price waiting_charge outstation_base_price outstation_base_distance outstation_price_per_distance pricing_scope package_destination').lean() : null,
  ]);

  const kind = describeRideKind(ride);
  const payment = paymentWords(ride);
  const advanceAmount = ride.advance?.status && ride.advance.status !== 'none' ? money(ride.advance.amount) : 0;
  const fare = money(ride.fare);
  const parcel = ride.deliveryId?.parcel || ride.parcel || {};
  const driver = ride.driverId || null;

  // ---- what happened, in order
  const timeline = [];
  const at = (when, label, detail = '', tone = 'slate') => { if (when) timeline.push({ at: when, label, detail, tone }); };
  at(ride.createdAt, 'Request created', `${kind.label}, booked from the ${ride.bookingSource || 'app'}`);
  if (ride.scheduledAt) at(ride.scheduledAt, 'Scheduled for', 'The rider asked for this time', 'blue');
  if (ride.advance?.paidAt) at(ride.advance.paidAt, 'Advance paid online', `Rs ${advanceAmount}`, 'green');
  const notified = ride.dispatchTracking?.notifiedDriverIds?.length || 0;
  if (notified) at(ride.dispatchTracking?.lastDispatchAttemptAt || ride.createdAt, 'Offered to drivers', `${notified} driver${notified > 1 ? 's' : ''} notified, ${ride.dispatchTracking?.rejectedDriverIds?.length || 0} declined`);
  for (const bid of bids) {
    at(bid.createdAt, bid.kind === 'counter' ? 'Counter-offer' : 'Bid', `${bid.driverId?.name || 'Driver'} offered Rs ${money(bid.bidFare)} (+Rs ${money(bid.incrementAmount)}), ${bid.status}`, 'amber');
  }
  at(ride.acceptedAt, 'Driver accepted', driver ? `${driver.name || 'Driver'}${driver.vehicleNumber ? `, ${driver.vehicleNumber}` : ''}` : '', 'blue');
  at(ride.arrivedAt, 'Driver arrived at pickup', '', 'blue');
  at(ride.startedAt, 'Trip started', '', 'blue');
  at(ride.completedAt, 'Trip completed', `Fare Rs ${fare}`, 'green');
  at(ride.cancelledAt, 'Cancelled', `${ride.cancelledBy ? `by ${ride.cancelledBy}` : ''}${ride.cancelReason ? `: ${ride.cancelReason}` : ''}`.trim(), 'red');
  at(ride.driverPaymentCollection?.paidAt, 'Payment received', `${payment.collection.provider || payment.collectedLabel} Rs ${payment.collection.amount}`, 'green');
  at(ride.walletSettledAt, 'Settled to wallet', `Commission Rs ${money(ride.commissionAmount)}, earnings Rs ${money(ride.driverEarnings)}`, 'green');
  at(ride.feedback?.submittedAt, 'Rider feedback', `${ride.feedback?.rating || 0}/5${ride.feedback?.comment ? `, "${ride.feedback.comment}"` : ''}${ride.feedback?.tipAmount ? `, tip Rs ${money(ride.feedback.tipAmount)}` : ''}`, 'green');
  if (advance?.refundedAt) at(advance.refundedAt, 'Advance refunded', `Rs ${money(advance.amount)} back to the rider`, 'green');
  timeline.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // ---- what is specific to this kind of request
  const typeDetails = {};
  if (kind.key === 'outstation') {
    Object.assign(typeDetails, {
      fromCity: ride.intercity?.fromCity || '', toCity: ride.intercity?.toCity || '', tripType: ride.intercity?.tripType || '',
      travelDate: ride.intercity?.travelDate || '', returnDate: ride.intercity?.returnDate || '', passengers: ride.intercity?.passengers || 1,
      distanceKm: ride.intercity?.distance || 0, vehicleName: ride.intercity?.vehicleName || '', packageId: ride.intercity?.packageId || '',
      packageName: ride.intercity?.packageTypeName || '',
    });
  } else if (kind.key === 'rental') {
    const r = ride.rental || {};
    Object.assign(typeDetails, {
      packageName: r.packageName || '', packagePrice: money(r.packagePrice), includedKm: r.includedKm || 0, includedMinutes: r.includedMinutes || 0,
      extraKmRate: r.extraKmRate || 0, extraMinuteRate: r.extraMinuteRate || 0, travelledKm: r.travelledKm || 0, usedMinutes: r.usedMinutes || 0,
      extraKm: r.extraKm || 0, extraMinutes: r.extraMinutes || 0, extraKmCharge: money(r.extraKmCharge), extraTimeCharge: money(r.extraTimeCharge),
      billedAt: r.settledAt || null,
    });
  } else if (kind.key === 'parcel') {
    Object.assign(typeDetails, {
      category: parcel.category || '', weight: parcel.weight || '', description: parcel.description || '', scope: parcel.deliveryScope || '',
      senderName: parcel.senderName || '', senderMobile: parcel.senderMobile || '', receiverName: parcel.receiverName || '', receiverMobile: parcel.receiverMobile || '',
      instructions: parcel.instructions || '', photos: Array.isArray(parcel.photos) ? parcel.photos : [],
      pickupProof: parcel.pickupProof || null, deliveryProof: parcel.deliveryProof || null,
    });
  } else if (kind.key === 'airport') {
    Object.assign(typeDetails, { airport: ride.trip_category?.airport_name || '', airportFee: money(ride.trip_category?.airport_fee) });
  }

  return {
    id: String(ride._id),
    requestId: `${kind.key === 'parcel' ? 'DEL' : 'REQ'}_${String(ride._id).slice(-12).toUpperCase()}`,
    kind,
    serviceType: ride.serviceType || 'ride',
    status: { label: labelStatus(ride), ride: ride.status, live: ride.liveStatus },
    createdAt: ride.createdAt,
    bookingSource: ride.bookingSource || 'app',
    scheduledAt: ride.scheduledAt || null,

    user: ride.userId ? { id: idText(ride.userId), name: ride.userId.name || '', phone: ride.userId.phone || '', email: ride.userId.email || '', profileImage: ride.userId.profileImage || '' } : null,
    driver: driver ? {
      id: idText(driver), name: driver.name || '', phone: driver.phone || '', rating: Number(driver.rating || 0), profileImage: driver.profileImage || '',
      vehicle: { type: driver.vehicleType || '', number: driver.vehicleNumber || '', color: driver.vehicleColor || '', make: driver.vehicleMake || '', model: driver.vehicleModel || '', image: driver.vehicleImage || '' },
      fleetOwner: owner ? { id: idText(owner), name: owner.company_name || owner.owner_name || owner.name || '', phone: owner.mobile || '' } : null,
    } : null,
    requestedVehicle: ride.vehicleTypeId ? { id: idText(ride.vehicleTypeId), name: ride.vehicleTypeId.name || '', capacity: ride.vehicleTypeId.capacity || 0 } : { name: ride.vehicleIconType || '' },

    route: {
      pickup: { address: ride.pickupAddress || '', point: pointOf(ride.pickupLocation) },
      drop: { address: ride.dropAddress || '', point: pointOf(ride.dropLocation) },
      stops: Array.isArray(ride.stops) ? ride.stops : [],
      estimatedDistanceKm: km(ride.estimatedDistanceMeters),
      estimatedDurationMinutes: Math.round(Number(ride.estimatedDurationMinutes) || 0),
      roadDistanceKm: km(ride.route?.distanceMeters),
      lastDriverLocation: pointOf(ride.lastDriverLocation),
    },
    typeDetails,

    fare: {
      final: fare,
      quoted: money(ride.baseFare || ride.fare),
      waitingMinutes: Number(ride.waitingMinutes || 0),
      waitingCharge: money(ride.waitingCharge),
      surge: { multiplier: Number(ride.surge?.multiplier || 1), source: ride.surge?.source || 'none' },
      tolls: { total: money(ride.tollCharges?.total), roundTrip: Boolean(ride.tollCharges?.roundTrip), items: ride.tollCharges?.items || [] },
      platformFee: money(ride.pricingSnapshot?.rider_platform_fee),
      promo: ride.promo?.code ? { code: ride.promo.code, discount: money(ride.promo.discount_amount) } : null,
      subscription: ride.subscriptionUsage?.covered ? { plan: ride.subscriptionUsage.planName || '', fareCovered: money(ride.subscriptionUsage.fareCovered) } : null,
      advancePaid: advanceAmount,
      amountDue: Math.max(0, money(fare - advanceAmount)),
    },

    negotiation: {
      mode: ride.pricingNegotiationMode || 'none',
      bookingMode: ride.bookingMode || 'normal',
      status: ride.biddingStatus || 'none',
      step: Number(ride.bidStepAmount || 0),
      riderCeiling: money(ride.bidCeilingMaxFare),
      driverCounter: { enabled: Boolean(ride.driverCounter?.enabled), maxPercentage: Number(ride.driverCounter?.maxPercentage || 0), step: Number(ride.driverCounter?.stepAmount || 0) },
      acceptedBidId: ride.acceptedBidId ? String(ride.acceptedBidId) : null,
      offers: bids.map((bid) => ({
        id: String(bid._id), driver: bid.driverId ? { id: idText(bid.driverId), name: bid.driverId.name || '', phone: bid.driverId.phone || '' } : null,
        fare: money(bid.bidFare), increase: money(bid.incrementAmount), kind: bid.kind || 'bid', status: bid.status, at: bid.createdAt,
      })),
    },

    payment: {
      ...payment,
      advance: advance ? {
        amount: money(advance.amount), status: advance.status, paidAt: advance.paidAt || null, paymentId: advance.razorpayPaymentId || '',
        refundId: advance.refundId || '', refundedAt: advance.refundedAt || null, refundError: advance.refundError || '', refundAttempts: advance.refundAttempts || 0,
      } : null,
    },

    settlement: {
      settled: Boolean(ride.walletSettledAt), settledAt: ride.walletSettledAt || null,
      commission: money(ride.commissionAmount), driverEarnings: money(ride.driverEarnings),
      fleetOwnerId: ride.ownerId ? String(ride.ownerId) : null,
      driverWallet: driverTransactions.map((t) => ({ id: String(t._id), type: t.type, amount: money(t.amount), balanceAfter: money(t.balanceAfter), description: t.description || '', at: t.createdAt })),
      ownerWallet: ownerTransactions.map((t) => ({ id: String(t._id), type: t.type || '', kind: t.kind, amount: money(t.amount), title: t.title, balance: money(t.balance), at: t.createdAt })),
    },

    cancellation: ride.status === 'cancelled' ? { by: ride.cancelledBy || '', reason: ride.cancelReason || '', at: ride.cancelledAt || null } : null,
    feedback: ride.feedback?.submittedAt ? { rating: ride.feedback.rating || 0, comment: ride.feedback.comment || '', tip: money(ride.feedback.tipAmount), at: ride.feedback.submittedAt } : null,
    messages: (ride.messages || []).map((m) => ({ from: m.senderRole || '', message: m.message || '', imageUrl: m.imageUrl || '', at: m.sentAt })),

    timeline,

    // The numbers as they were when the request was made: they do not change if the admin edits prices later.
    snapshots: {
      pricing: ride.pricingSnapshot ? {
        setPriceId: idText(ride.pricingSnapshot.setPriceId) || null,
        driverCommission: { type: Number(ride.pricingSnapshot.admin_commission_type_from_driver ?? 1) === 1 ? 'percentage' : 'fixed', value: Number(ride.pricingSnapshot.admin_commission_from_driver || 0) },
        ownerCommission: { type: Number(ride.pricingSnapshot.admin_commission_type_for_owner ?? 1) === 1 ? 'percentage' : 'fixed', value: Number(ride.pricingSnapshot.admin_commission_for_owner || 0) },
        riderPlatformFee: money(ride.pricingSnapshot.rider_platform_fee),
        resolvedAt: ride.pricingSnapshot.resolvedAt || null,
      } : null,
      tariff: tariff || null,
      vehicle: { type: ride.vehicleTypeId?.name || ride.vehicleIconType || '', icon: ride.vehicleIconType || '' },
      tripCategory: ride.trip_category || null,
      dispatch: { notifiedDrivers: notified, declinedDrivers: ride.dispatchTracking?.rejectedDriverIds?.length || 0, lastAttemptAt: ride.dispatchTracking?.lastDispatchAttemptAt || null },
    },
  };
};
