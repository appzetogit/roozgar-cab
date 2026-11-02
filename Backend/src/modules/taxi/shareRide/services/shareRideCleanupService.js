import { runShareCleanup } from './shareRideService.js';

// Scheduled housekeeping for Share Ride: requests nobody took, rides stuck in accepted/ongoing, and empty
// trips idle for SHARE_TRIP_IDLE_MINUTES. Safe on every PM2 instance: each change inside runShareCleanup is
// an atomic update whose filter holds the old status, so only one instance acts on a document.
const intervalMs = () => Math.max(30, Number(process.env.SHARE_CLEANUP_INTERVAL_SEC) || 300) * 1000;

let timer = null;

export const startShareRideCleanupLoop = () => {
  if (timer) return;
  const run = () => runShareCleanup().catch((error) => console.error('Share ride cleanup failed', error));
  timer = setInterval(run, intervalMs());
  timer.unref?.();
  run();
};
