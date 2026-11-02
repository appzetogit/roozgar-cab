import { OwnerSubscription } from '../../admin/models/OwnerSubscription.js';
import { Driver } from '../models/Driver.js';
import { getOwnerServiceStatus } from './ownerBillingService.js';
import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Only plans that ended recently are acted on, so the first sweep after a
// deploy does not take every long-gone owner's drivers offline again.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 200;

let sweepTimer = null;

/**
 * When an owner's plan ends and they have not renewed or moved to commission,
 * their fleet stops: drivers are taken offline and told why. Dispatch and the
 * accept gate already refuse them (they compare against `expiresAt`); this
 * makes the app reflect it. Each plan is claimed atomically so the server
 * instances act once.
 */
export const sweepExpiredOwnerSubscriptions = async () => {
  const now = new Date();
  const expired = await OwnerSubscription.find({
    status: 'active',
    paidAt: { $ne: null },
    expiresAt: { $lte: now, $gt: new Date(now.getTime() - LOOKBACK_MS) },
    expiryNotifiedAt: null,
  }).select('_id ownerId').limit(BATCH_SIZE).lean();

  for (const row of expired) {
    const claim = await OwnerSubscription.updateOne({ _id: row._id, expiryNotifiedAt: null }, { $set: { expiryNotifiedAt: new Date() } });
    if (!claim.modifiedCount) continue;

    try {
      const status = await getOwnerServiceStatus(row.ownerId);
      if (status.active) continue; // renewed, or already on commission

      const fleet = await Driver.find({ owner_id: row.ownerId, deletedAt: null }).select('_id').lean();
      if (!fleet.length) continue;
      const ids = fleet.map((driver) => driver._id);
      await Driver.updateMany({ _id: { $in: ids }, isOnRide: { $ne: true } }, { $set: { isOnline: false } });
      await sendPushNotificationToEntities({
        driverIds: ids.map(String),
        title: 'Your fleet subscription has ended',
        body: 'Ask your owner to renew the plan or switch to commission to get rides again.',
        data: { type: 'owner_subscription_expired' },
      });
    } catch (error) {
      console.error('Owner subscription expiry handling failed', row.ownerId, error.message);
    }
  }
};

export const startOwnerSubscriptionExpiryLoop = () => {
  if (sweepTimer) return;
  const run = () => sweepExpiredOwnerSubscriptions().catch((error) => console.error('Owner subscription expiry sweep failed', error));
  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  run();
};
