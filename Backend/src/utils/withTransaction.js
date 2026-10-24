import mongoose from 'mongoose';

/**
 * Runs fn(session) in a transaction; on a standalone mongod, which rejects
 * transactions ("Transaction numbers are only allowed on a replica set member
 * or mongos"), runs fn(null) instead.
 *
 * shortcut: the no-transaction path is not atomic across documents, so fn must
 * do its checks before its writes. Drop the fallback once Mongo is a replica set.
 */
export const withTransactionIfSupported = async (fn) => {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(() => fn(session));
  } catch (error) {
    if (!/Transaction numbers are only allowed/i.test(error?.message || '')) throw error;
    await fn(null);
  } finally {
    await session.endSession();
  }
};
