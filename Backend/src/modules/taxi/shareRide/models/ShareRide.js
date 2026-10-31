import mongoose from 'mongoose';

const placeSchema = new mongoose.Schema(
  {
    address: { type: String, default: '', trim: true },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
  },
  { _id: false },
);

export const ACTIVE_RIDE_STATUSES = ['searching', 'accepted', 'ongoing'];

// One rider's seats on a share trip. Created as a request ('searching', no
// trip); a provider adding it to their trip sets tripId/driverId and moves it
// to 'accepted'.
const shareRideSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiUser', required: true, index: true },
    passenger: {
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
    },

    pickup: { type: placeSchema, required: true },
    drop: { type: placeSchema, required: true },
    seats: { type: Number, required: true, min: 1, max: 4 },
    distanceKm: { type: Number, default: 0 },

    // Computed by the server only. `fare` is what the rider pays in total.
    fare: { type: Number, required: true, min: 0 },
    fareBreakdown: {
      perSeat: { type: Number, default: 0 },
      subtotal: { type: Number, default: 0 },
      platformFee: { type: Number, default: 0 },
      discountPercent: { type: Number, default: 0 },
      tariffName: { type: String, default: '' },
    },

    status: {
      type: String,
      enum: [...ACTIVE_RIDE_STATUSES, 'completed', 'cancelled', 'expired'],
      default: 'searching',
      index: true,
    },
    expiresAt: { type: Date, required: true },

    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiShareTrip', default: null, index: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', default: null, index: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiOwner', default: null, index: true },
    driverSnapshot: {
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
      photo: { type: String, default: '' },
    },
    vehicleSnapshot: {
      type: { type: String, default: '' },
      name: { type: String, default: '' },
      number: { type: String, default: '' },
      color: { type: String, default: '' },
    },
    // Drivers who handed this rider back: they are not shown the request again.
    declinedBy: { type: [mongoose.Schema.Types.ObjectId], default: [] },

    otp: { type: String, required: true },
    // Wrong OTPs typed by the driver; the OTP is locked after a few.
    otpAttempts: { type: Number, default: 0 },
    acceptedAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, enum: ['', 'user', 'driver', 'system'], default: '' },
    cancelReason: { type: String, default: '' },

    collectedVia: { type: String, enum: ['', 'cash', 'upi'], default: '' },
    // Written once, when the ride completes.
    settlement: {
      settledAt: { type: Date, default: null },
      platformFee: { type: Number, default: 0 },
      commission: { type: Number, default: 0 },
      commissionWaived: { type: Number, default: 0 },
      driverEarnings: { type: Number, default: 0 },
      subscriptionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      // 'pending' = the driver's wallet debit did not go through; shown to admin.
      walletStatus: { type: String, enum: ['none', 'settled', 'pending'], default: 'none' },
    },
  },
  { timestamps: true },
);

shareRideSchema.index({ 'pickup.location': '2dsphere' });
shareRideSchema.index({ status: 1, expiresAt: 1 });
shareRideSchema.index({ ownerId: 1, createdAt: -1 });
shareRideSchema.index({ driverId: 1, status: 1, createdAt: -1 });
// A rider has one active share ride at a time.
shareRideSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_RIDE_STATUSES } }, name: 'one_active_share_ride_per_user' },
);

export const ShareRide =
  mongoose.models.TaxiShareRide || mongoose.model('TaxiShareRide', shareRideSchema);
