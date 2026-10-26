import mongoose from 'mongoose';

export const POST_STATUS = ['active', 'needs_update', 'unavailable', 'expired', 'under_review', 'removed'];
export const REPORT_REASONS = ['fake_ride', 'wrong_number', 'spam', 'abusive', 'other'];

const pointSchema = new mongoose.Schema(
  { type: { type: String, enum: ['Point'], default: 'Point' }, coordinates: { type: [Number], required: true } },
  { _id: false },
);

function isTextPost() {
  return !this.audioUrl;
}

const ridePostSchema = new mongoose.Schema(
  {
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', required: true },
    ownerName: { type: String, default: '' },
    ownerAvatarUrl: { type: String, default: null },
    phone: { type: String, required: true },
    // Voice posts carry no typed route, so these are required only without audio.
    pickup: { type: String, required: isTextPost, maxlength: 200, default: '' },
    drop: { type: String, required: isTextPost, maxlength: 200, default: '' },
    pickupLocation: { type: pointSchema, default: undefined },
    dropLocation: { type: pointSchema, default: undefined },
    // Straight-line km between the two points; null when the client sent none.
    distanceKm: { type: Number, default: null },
    // 0 for voice posts: the fare is spoken.
    price: { type: Number, required: true },
    dateTime: { type: Date, required: true },
    passengers: { type: Number, required: true, min: 1, max: 6 },
    note: { type: String, default: '', maxlength: 150 },
    // Zone of the poster when the post was made; null = unknown (shown to everyone).
    zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiZone', default: null },
    // Voice post: public URL of the recording, null for typed posts.
    audioUrl: { type: String, default: null },
    audioDurationSec: { type: Number, default: 0 },
    status: { type: String, enum: POST_STATUS, default: 'active' },
    unavailableReason: { type: String, enum: ['given_to_other_driver', 'cancelled', 'other', null], default: null },
    rescheduleCount: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    calls: { type: Number, default: 0 },
    reportCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

ridePostSchema.index({ status: 1, dateTime: 1, createdAt: -1 });
ridePostSchema.index({ status: 1, zoneId: 1, dateTime: 1, createdAt: -1 });
ridePostSchema.index({ postedBy: 1, status: 1, createdAt: -1 });
ridePostSchema.index({ pickupLocation: '2dsphere' }, { sparse: true });

export const RidePost = mongoose.models.TaxiRidePost || mongoose.model('TaxiRidePost', ridePostSchema);

const reportSchema = new mongoose.Schema(
  {
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiRidePost', required: true },
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', required: true },
    postOwnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', required: true, index: true },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    note: { type: String, default: '', maxlength: 200 },
    status: { type: String, enum: ['pending', 'reviewed'], default: 'pending' },
    action: { type: String, enum: ['dismissed', 'removed', null], default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

reportSchema.index({ postId: 1, reporterId: 1 }, { unique: true });
reportSchema.index({ status: 1, createdAt: -1 });
reportSchema.index({ reporterId: 1 });

export const RidePostReport =
  mongoose.models.TaxiRidePostReport || mongoose.model('TaxiRidePostReport', reportSchema);

// One row per (post, driver, kind) so views and calls can be deduped.
const engagementSchema = new mongoose.Schema({
  postId: { type: mongoose.Schema.Types.ObjectId, required: true },
  driverId: { type: mongoose.Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['view', 'call'], required: true },
  at: { type: Date, default: Date.now },
});

engagementSchema.index({ postId: 1, driverId: 1, kind: 1 }, { unique: true });

export const RidePostEngagement =
  mongoose.models.TaxiRidePostEngagement || mongoose.model('TaxiRidePostEngagement', engagementSchema);
