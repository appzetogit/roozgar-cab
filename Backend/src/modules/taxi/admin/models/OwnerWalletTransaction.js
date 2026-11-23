import mongoose from 'mongoose';

const ownerWalletTransactionSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiOwner',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    kind: {
      type: String,
      enum: ['credit', 'debit'],
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    balance: {
      type: Number,
      required: true,
    },
    // Set for fleet-ride money and plan purchases; older rows have none.
    type: { type: String, default: '' },
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiRide', default: null, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

export const OwnerWalletTransaction = mongoose.model('TaxiOwnerWalletTransaction', ownerWalletTransactionSchema);