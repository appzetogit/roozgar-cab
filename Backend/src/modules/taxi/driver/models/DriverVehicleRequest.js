import mongoose from 'mongoose';

// A driver's request to add another vehicle. Nothing reaches the driver's own
// record until an admin approves it, so a pending request never affects dispatch.
const driverVehicleRequestSchema = new mongoose.Schema(
  {
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiDriver',
      required: true,
      index: true,
    },
    vehicleTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiVehicle', required: true },
    vehicleTypeIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TaxiVehicle' }], default: [] },
    vehicleType: { type: String, default: 'car', trim: true },
    vehicleIconType: { type: String, default: 'car', trim: true },
    vehicleMake: { type: String, default: '', trim: true },
    vehicleModel: { type: String, default: '', trim: true },
    vehicleNumber: { type: String, required: true, trim: true },
    vehicleColor: { type: String, default: '', trim: true },
    vehicleImage: { type: String, default: '', trim: true },
    documents: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
    },
    rejectionReason: { type: String, default: '', trim: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiAdmin', default: null },
    reviewedAt: { type: Date, default: null },
    // The Driver.vehicles entry this request became, once approved.
    vehicleEntryId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

driverVehicleRequestSchema.index({ status: 1, createdAt: -1 });
driverVehicleRequestSchema.index({ vehicleNumber: 1, status: 1 });

export const DriverVehicleRequest =
  mongoose.models.TaxiDriverVehicleRequest ||
  mongoose.model('TaxiDriverVehicleRequest', driverVehicleRequestSchema);
