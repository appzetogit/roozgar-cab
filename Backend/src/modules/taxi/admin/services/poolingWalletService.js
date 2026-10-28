import { PoolingVehicle } from '../models/PoolingVehicle.js';
import { PoolingWalletTransaction } from '../models/PoolingWalletTransaction.js';
import { Owner } from '../models/Owner.js';
import { OwnerWalletTransaction } from '../models/OwnerWalletTransaction.js';

// Credits a booking's driverCommissionAmount to the vehicle's own wallet (a
// pooling driver has no separate Driver row - see PoolingVehicle.wallet), and
// ownerCommissionAmount to the vehicle's owner, if it has one. Called once a
// booking's seats are confirmed (not on create: a seat-clash rollback must
// never have already paid anyone). The unique index on
// (bookingId, recipient) makes this safe to call more than once for the
// same booking - a repeat call credits nothing twice.
export const settlePoolingBookingWallets = async (booking) => {
  const vehicle = await PoolingVehicle.findById(booking.vehicle);
  if (!vehicle) return;

  const driverAmount = Number(booking.driverCommissionAmount || 0);
  if (driverAmount > 0) {
    try {
      const updated = await PoolingVehicle.findByIdAndUpdate(
        vehicle._id,
        { $inc: { 'wallet.balance': driverAmount } },
        { returnDocument: 'after' },
      );
      await PoolingWalletTransaction.create({
        bookingId: booking._id,
        recipient: 'driver',
        vehicleId: vehicle._id,
        ownerId: vehicle.ownerId || null,
        amount: driverAmount,
        balanceAfter: Number(updated?.wallet?.balance || 0),
      });
    } catch (error) {
      if (error?.code !== 11000) throw error; // already settled for this booking
      await PoolingVehicle.findByIdAndUpdate(vehicle._id, { $inc: { 'wallet.balance': -driverAmount } });
    }
  }

  const ownerAmount = Number(booking.ownerCommissionAmount || 0);
  if (ownerAmount > 0 && vehicle.ownerId) {
    const owner = await Owner.findById(vehicle.ownerId);
    if (owner) {
      const nextBalance = Math.round((Number(owner.wallet?.balance || 0) + ownerAmount) * 100) / 100;
      try {
        await PoolingWalletTransaction.create({
          bookingId: booking._id,
          recipient: 'owner',
          vehicleId: vehicle._id,
          ownerId: owner._id,
          amount: ownerAmount,
          balanceAfter: nextBalance,
        });
      } catch (error) {
        if (error?.code !== 11000) throw error; // already settled for this booking
        return;
      }
      owner.wallet = owner.wallet || {};
      owner.wallet.balance = nextBalance;
      owner.markModified('wallet');
      await owner.save();
      await OwnerWalletTransaction.create({
        ownerId: owner._id,
        amount: ownerAmount,
        kind: 'credit',
        title: `Pooling booking ${booking.bookingId || booking._id}`,
        balance: nextBalance,
      });
    }
  }
};

// Reverses a settlement that should not have happened (booking cancelled /
// refunded after being settled). No-op if it was never settled.
export const reversePoolingBookingWallets = async (bookingId) => {
  const transactions = await PoolingWalletTransaction.find({ bookingId });
  for (const transaction of transactions) {
    if (transaction.recipient === 'driver') {
      await PoolingVehicle.findByIdAndUpdate(transaction.vehicleId, {
        $inc: { 'wallet.balance': -transaction.amount },
      });
    } else if (transaction.recipient === 'owner' && transaction.ownerId) {
      const owner = await Owner.findById(transaction.ownerId);
      if (owner) {
        const nextBalance = Math.round((Number(owner.wallet?.balance || 0) - transaction.amount) * 100) / 100;
        owner.wallet = owner.wallet || {};
        owner.wallet.balance = nextBalance;
        owner.markModified('wallet');
        await owner.save();
        await OwnerWalletTransaction.create({
          ownerId: owner._id,
          amount: transaction.amount,
          kind: 'debit',
          title: `Pooling booking reversal ${bookingId}`,
          balance: nextBalance,
        });
      }
    }
  }
  if (transactions.length) {
    await PoolingWalletTransaction.deleteMany({ bookingId });
  }
};
