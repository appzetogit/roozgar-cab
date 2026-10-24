import { sweepOverduePosts } from './feedService.js';

let timer = null;

export const startFeedOverdueLoop = () => {
  if (timer) return;

  const run = () => sweepOverduePosts().catch((error) => console.error('Feed overdue sweep failed', error));

  timer = setInterval(run, 60 * 1000);
  timer.unref?.();
  run();
};
