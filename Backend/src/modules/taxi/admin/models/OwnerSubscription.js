import mongoose from 'mongoose';

/**
 * A plan a fleet owner bought. While one is active the owner's whole fleet
 * works (no pass per driver) and ride commission is waived; once it lapses the
 * owner and their drivers stop getting work until they renew or switch to
 * commission. Expiry is a comparison against `expiresAt`, never a status write.
 */
const ownerSubscriptionSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiOwner', required: true, index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiSubscriptionPlan', default: null },
    planName: { type: String, default: '' },
    amount: { type: Number, required: true, min: 0 },
    startsAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: true },
    status: { type: String, enum: ['active', 'cancelled', 'refunded'], default: 'active', index: true },
    paymentMethod: { type: String, enum: ['wallet', 'razorpay', 'admin'], required: true },
    paymentReference: { type: String, default: '' },
    // An unpaid (gateway not confirmed yet) row never counts as cover.
    paidAt: { type: Date, default: null },
    tripsCovered: { type: Number, default: 0 },
    commissionWaived: { type: Number, default: 0 },
    // Claimed atomically so the server instances notify once per plan.
    expiryNotifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

ownerSubscriptionSchema.index({ ownerId: 1, status: 1, paidAt: 1, expiresAt: -1 });

export const OwnerSubscription =
  mongoose.models.TaxiOwnerSubscription || mongoose.model('TaxiOwnerSubscription', ownerSubscriptionSchema);
