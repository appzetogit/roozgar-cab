import mongoose from 'mongoose';

// Records every pooling-earning credit, so a driver's or owner's wallet.balance
// is explainable. `recipient` tells which wallet got the money: a
// PoolingVehicle (driver commission) or an Owner (owner commission) -
// a pooling vehicle has no separate driver account, see PoolingVehicle.wallet.
const poolingWalletTransactionSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiPoolingBooking',
      required: true,
      index: true,
    },
    recipient: {
      type: String,
      enum: ['driver', 'owner'],
      required: true,
    },
    vehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiPoolingVehicle',
      required: true,
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Owner',
      default: null,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true },
);

// One credit per booking per recipient - a booking is settled exactly once.
poolingWalletTransactionSchema.index({ bookingId: 1, recipient: 1 }, { unique: true });

export const PoolingWalletTransaction =
  mongoose.models.TaxiPoolingWalletTransaction ||
  mongoose.model('TaxiPoolingWalletTransaction', poolingWalletTransactionSchema);
