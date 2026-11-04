import mongoose from 'mongoose';

/**
 * The advance a rider pays online before an outstation booking is created. The admin sets it on each outstation
 * price row (a percentage of the fare, or a fixed amount); the rest of the fare is paid when the ride ends.
 *
 * created -> paid (Razorpay confirmed) -> used (a ride was booked with it) -> refunded (the ride was cancelled).
 * A cancelled ride always gets the whole advance back; if the gateway refuses, it stays `refund_failed` and is retried.
 */
const rideAdvanceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiUser', required: true, index: true },
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiSetPrice', default: null },
    vehicleTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiVehicle', default: null },
    // The booking fare the advance was worked out on (tolls included), and the rule that produced the amount.
    fare: { type: Number, required: true, min: 0 },
    advanceType: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
    advanceValue: { type: Number, default: 0 },
    amount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['created', 'paid', 'used', 'refunding', 'refunded', 'refund_failed', 'expired'],
      default: 'created',
      index: true,
    },
    razorpayOrderId: { type: String, default: '', index: true },
    razorpayPaymentId: { type: String, default: '' },
    paidAt: { type: Date, default: null },
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiRide', default: null, index: true },
    usedAt: { type: Date, default: null },
    refundId: { type: String, default: '' },
    refundedAt: { type: Date, default: null },
    refundError: { type: String, default: '' },
    refundAttempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const RideAdvance = mongoose.models.TaxiRideAdvance || mongoose.model('TaxiRideAdvance', rideAdvanceSchema);
