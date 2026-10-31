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

export const ACTIVE_TRIP_STATUSES = ['open', 'running'];

// One run of a provider's vehicle that riders can share. A driver (or an owner
// for a fleet driver) holds at most one active trip; riders attach to it as
// ShareRide documents. Admin never creates or edits these.
const shareTripSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', required: true, index: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiOwner', default: null, index: true },
    createdBy: { type: String, enum: ['driver', 'owner'], default: 'driver' },

    vehicleTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiVehicle', default: null },
    vehicleSnapshot: {
      type: { type: String, default: 'car' },
      name: { type: String, default: '' },
      number: { type: String, default: '' },
      color: { type: String, default: '' },
    },

    origin: { type: placeSchema, required: true },
    destination: { type: placeSchema, required: true },
    routeDistanceKm: { type: Number, default: 0 },
    // The driver's own normal Ride this trip rides along with, if any.
    baseRideId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiRide', default: null },

    seatsTotal: { type: Number, required: true, min: 1, max: 8 },
    // Seats held by accepted/ongoing riders; freed when a rider completes or leaves.
    seatsTaken: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: [...ACTIVE_TRIP_STATUSES, 'completed', 'cancelled'], default: 'open', index: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // Running totals, bumped as riders complete.
    stats: {
      ridersCompleted: { type: Number, default: 0 },
      gross: { type: Number, default: 0 },
      platformFee: { type: Number, default: 0 },
      commission: { type: Number, default: 0 },
      driverEarnings: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

// A driver can hold only one active trip; the database enforces it so two taps
// cannot create two.
shareTripSchema.index(
  { driverId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_TRIP_STATUSES } }, name: 'one_active_trip_per_driver' },
);
shareTripSchema.index({ ownerId: 1, createdAt: -1 });
shareTripSchema.index({ status: 1, createdAt: -1 });

export const ShareTrip =
  mongoose.models.TaxiShareTrip || mongoose.model('TaxiShareTrip', shareTripSchema);
