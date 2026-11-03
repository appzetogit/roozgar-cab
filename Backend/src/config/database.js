import mongoose from 'mongoose';
import { env } from './env.js';

/**
 * Production Mongo is a standalone mongod, where `startTransaction()` works but the first query inside it fails
 * with "Transaction numbers are only allowed on a replica set member or mongos". Several flows (rider fare payment
 * verification, ride bid acceptance, wallet top-up, refunds...) open one. On a standalone server this makes the
 * transaction calls no-ops, so those flows run their steps one by one on the same session (a session without a
 * transaction is fine on standalone).
 *
 * shortcut: no rollback on a standalone server (nothing there could provide one), so each flow must order its writes
 * so a half-way failure is safe; drop this once Mongo is a replica set (it then does nothing).
 */
export const installStandaloneTransactionShim = async () => {
  const admin = mongoose.connection.db.admin();
  const hello = await admin.command({ hello: 1 }).catch(() => admin.command({ isMaster: 1 }));
  if (hello.setName || hello.msg === 'isdbgrid') return false; // replica set or mongos: real transactions

  if (mongoose.startSession.isStandaloneShim) return true;
  const original = mongoose.startSession.bind(mongoose);
  const shimmed = async (...args) => {
    const session = await original(...args);
    session.startTransaction = () => {};
    session.commitTransaction = async () => {};
    session.abortTransaction = async () => {};
    session.withTransaction = async (fn) => fn(session);
    return session;
  };
  shimmed.isStandaloneShim = true;
  mongoose.startSession = shimmed;
  return true;
};

export const connectDatabase = async () => {
  mongoose.set('strictQuery', true);

  const connection = await mongoose.connect(env.mongoUri, {
    autoIndex: env.nodeEnv !== 'production',
    dbName: env.mongoDbName,
  });

  const { host, name } = connection.connection;
  console.log(`MongoDB connected to ${host}/${name}`);

  if (await installStandaloneTransactionShim()) {
    console.log('MongoDB is a standalone server: transactions run without rollback');
  }
};
