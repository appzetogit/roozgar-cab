import { ApiError } from '../../../../utils/ApiError.js';
import { Owner } from '../../admin/models/Owner.js';
import { OwnerSubscription } from '../../admin/models/OwnerSubscription.js';
import { OwnerWalletTransaction } from '../../admin/models/OwnerWalletTransaction.js';
import { SubscriptionPlan } from '../../admin/models/SubscriptionPlan.js';
import { SetPrice } from '../../admin/models/SetPrice.js';
import { getCycleWindow, resolveDriverSubscriptionSettings } from './driverSubscriptionService.js';

/**
 * How a fleet owner (and every driver linked to them) pays the platform.
 *
 *  - subscription: the owner buys a plan. While it is active the whole fleet
 *    works and no commission is charged. Fleet drivers never buy a pass of
 *    their own.
 *  - commission: no plan; the platform takes the admin-set owner commission on
 *    every fleet ride.
 *
 * A subscription-mode owner whose plan lapsed has no service at all (owner and
 * fleet) until they renew or switch to commission. Solo drivers are unaffected:
 * they keep their own daily pass.
 */

const round = (value) => Math.round(Number(value || 0) * 100) / 100;

const idOf = (value) => (value && value._id ? value._id : value);

export const getActiveOwnerSubscription = async (ownerId, { at = new Date() } = {}) => {
  if (!ownerId) return null;
  return OwnerSubscription.findOne({
    ownerId: idOf(ownerId),
    status: 'active',
    paidAt: { $ne: null },
    startsAt: { $lte: at },
    expiresAt: { $gt: at },
  }).sort({ expiresAt: -1 }).lean();
};

/** { active, mode, subscription, reason } for one owner. */
export const getOwnerServiceStatus = async (ownerId) => {
  const owner = await Owner.findById(idOf(ownerId)).select('billing active approve deletedAt').lean();
  if (!owner || owner.deletedAt || owner.active === false) {
    return { active: false, mode: 'subscription', subscription: null, reason: 'Owner account is not active' };
  }
  const mode = owner.billing?.mode === 'commission' ? 'commission' : 'subscription';
  const subscription = await getActiveOwnerSubscription(owner._id);

  if (subscription) return { active: true, mode, subscription, reason: '' };
  if (mode === 'commission') return { active: true, mode, subscription: null, reason: '' };
  return {
    active: false,
    mode,
    subscription: null,
    reason: "Your owner's subscription has ended. The owner needs to renew it or switch to commission.",
  };
};

/** Owners whose fleet may work right now: on a plan, or on commission. */
export const getServingOwnerIds = async () => {
  const now = new Date();
  const [onPlan, onCommission] = await Promise.all([
    OwnerSubscription.distinct('ownerId', {
      status: 'active', paidAt: { $ne: null }, startsAt: { $lte: now }, expiresAt: { $gt: now },
    }),
    Owner.distinct('_id', { 'billing.mode': 'commission', deletedAt: null, active: { $ne: false } }),
  ]);
  const seen = new Set();
  return [...onPlan, ...onCommission].filter((id) => {
    const key = String(id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const listOwnerPlans = async () => {
  const plans = await SubscriptionPlan.find({ audience: 'owner', active: true }).sort({ amount: 1 }).lean();
  return plans.map((plan) => ({
    id: String(plan._id),
    name: plan.name || 'Owner Plan',
    description: plan.description || '',
    amount: Number(plan.amount || 0),
    durationDays: Math.max(1, Math.floor(Number(plan.duration) || 1)),
    howItWorks: plan.how_it_works || '',
  }));
};

/** The commission range the platform takes from a fleet owner, for the owner's screen. */
const ownerCommissionSummary = async () => {
  const rows = await SetPrice.find({ active: 1, status: 'active', pricing_scope: { $ne: 'package' } })
    .select('admin_commission_type_for_owner admin_commission_for_owner').lean();
  const percent = rows.filter((row) => Number(row.admin_commission_type_for_owner ?? 1) === 1)
    .map((row) => Number(row.admin_commission_for_owner || 0));
  const fixed = rows.filter((row) => Number(row.admin_commission_type_for_owner ?? 1) !== 1)
    .map((row) => Number(row.admin_commission_for_owner || 0));
  const span = (list) => (list.length ? { min: Math.min(...list), max: Math.max(...list) } : null);
  return { percentage: span(percent), fixedPerRide: span(fixed) };
};

export const getOwnerBilling = async (ownerId) => {
  const owner = await Owner.findById(idOf(ownerId)).select('billing wallet').lean();
  if (!owner) throw new ApiError(404, 'Owner not found');
  const [status, plans, settings, commission] = await Promise.all([
    getOwnerServiceStatus(ownerId),
    listOwnerPlans(),
    resolveDriverSubscriptionSettings(),
    ownerCommissionSummary(),
  ]);
  const sub = status.subscription;
  return {
    mode: status.mode,
    serviceActive: status.active,
    // Said to the owner here; the fleet drivers get the "Your owner's ..." wording.
    reason: status.active ? '' : 'Your subscription has ended. Renew it or switch to commission to get your fleet working again.',
    walletBalance: round(owner.wallet?.balance),
    paymentMethods: settings.paymentMethods,
    currentCycle: getCycleWindow(settings),
    subscription: sub
      ? { id: String(sub._id), planName: sub.planName, amount: sub.amount, startsAt: sub.startsAt, expiresAt: sub.expiresAt, paymentMethod: sub.paymentMethod }
      : null,
    plans,
    commission,
  };
};

/** Buy a plan from the owner wallet, or start a gateway payment. */
export const purchaseOwnerSubscription = async ({ ownerId, planId, paymentMethod = 'wallet' }) => {
  const settings = await resolveDriverSubscriptionSettings();
  const method = String(paymentMethod || 'wallet').trim().toLowerCase();
  const isGateway = method === 'razorpay';

  if (method !== 'wallet' && !isGateway) throw new ApiError(400, 'Unsupported payment method');
  if (method === 'wallet' && !settings.paymentMethods.includes('wallet')) {
    throw new ApiError(400, 'Paying from the wallet is not enabled');
  }
  if (isGateway && !settings.paymentMethods.includes('gateway')) {
    throw new ApiError(400, 'Online payment is not enabled');
  }

  const owner = await Owner.findOne({ _id: idOf(ownerId), deletedAt: null });
  if (!owner) throw new ApiError(404, 'Owner not found');
  if (await getActiveOwnerSubscription(owner._id)) {
    throw new ApiError(409, 'A plan is already active. Renew once it ends.');
  }

  const plan = await SubscriptionPlan.findOne({ _id: planId, audience: 'owner', active: true }).lean();
  if (!plan) throw new ApiError(400, 'Choose a subscription plan');

  const amount = round(plan.amount);
  const { startsAt } = getCycleWindow(settings);
  const days = Math.max(1, Math.floor(Number(plan.duration) || 1));
  const record = {
    ownerId: owner._id,
    planId: plan._id,
    planName: plan.name || 'Owner Plan',
    amount,
    startsAt,
    expiresAt: new Date(startsAt.getTime() + days * 24 * 60 * 60 * 1000),
    paymentMethod: method,
    paidAt: null,
  };

  if (isGateway) {
    const created = await OwnerSubscription.create(record);
    return { subscription: created.toObject(), requiresPayment: true, amount };
  }

  // One conditional update both checks the balance and takes the money, so two
  // taps cannot spend the same rupees (no transactions on a standalone Mongo).
  const debited = await Owner.findOneAndUpdate(
    { _id: owner._id, 'wallet.balance': { $gte: amount } },
    { $inc: { 'wallet.balance': -amount } },
    { returnDocument: 'after' },
  );
  if (!debited) throw new ApiError(400, 'Not enough wallet balance for this plan');

  try {
    const created = await OwnerSubscription.create({ ...record, paidAt: new Date() });
    await OwnerWalletTransaction.create({
      ownerId: owner._id,
      amount,
      kind: 'debit',
      title: `Subscription: ${record.planName}`,
      balance: round(debited.wallet?.balance),
      type: 'subscription_purchase',
      metadata: { subscriptionId: created._id, planId: plan._id },
    });
    await Owner.updateOne({ _id: owner._id }, { $set: { 'billing.mode': 'subscription', 'billing.changedAt': new Date() } });
    return { subscription: created.toObject(), requiresPayment: false, amount };
  } catch (error) {
    await Owner.updateOne({ _id: owner._id }, { $inc: { 'wallet.balance': amount } });
    throw error;
  }
};

/** Called once a gateway payment is verified. */
export const activateOwnerSubscription = async ({ subscriptionId, paymentReference = '' }) => {
  const updated = await OwnerSubscription.findOneAndUpdate(
    { _id: subscriptionId, paidAt: null, status: 'active' },
    { $set: { paidAt: new Date(), paymentReference: String(paymentReference || '') } },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw new ApiError(404, 'Subscription payment not found or already confirmed');
  await Owner.updateOne({ _id: updated.ownerId }, { $set: { 'billing.mode': 'subscription', 'billing.changedAt': new Date() } });
  return updated;
};

/** Admin gives an owner a plan without payment (amount defaults to 0 so revenue is not inflated). */
export const grantOwnerSubscription = async ({ ownerId, planId, amount = 0, days }) => {
  const owner = await Owner.findOne({ _id: idOf(ownerId), deletedAt: null }).select('_id').lean();
  if (!owner) throw new ApiError(404, 'Owner not found');
  const plan = await SubscriptionPlan.findOne({ _id: planId, audience: 'owner' }).lean();
  if (!plan) throw new ApiError(400, 'Choose a subscription plan');

  const settings = await resolveDriverSubscriptionSettings();
  const { startsAt } = getCycleWindow(settings);
  const span = Math.max(1, Math.floor(Number(days) || Number(plan.duration) || 1));
  const created = await OwnerSubscription.create({
    ownerId: owner._id,
    planId: plan._id,
    planName: plan.name || 'Owner Plan',
    amount: Math.max(0, round(amount)),
    startsAt,
    expiresAt: new Date(startsAt.getTime() + span * 24 * 60 * 60 * 1000),
    paymentMethod: 'admin',
    paidAt: new Date(),
  });
  await Owner.updateOne({ _id: owner._id }, { $set: { 'billing.mode': 'subscription', 'billing.changedAt': new Date() } });
  return created.toObject();
};

export const setOwnerBillingMode = async (ownerId, mode) => {
  const next = String(mode || '').trim().toLowerCase();
  if (!['subscription', 'commission'].includes(next)) throw new ApiError(400, 'Mode must be subscription or commission');
  const owner = await Owner.findOneAndUpdate(
    { _id: idOf(ownerId), deletedAt: null },
    { $set: { 'billing.mode': next, 'billing.changedAt': new Date() } },
    { returnDocument: 'after' },
  ).select('billing').lean();
  if (!owner) throw new ApiError(404, 'Owner not found');
  return getOwnerServiceStatus(ownerId);
};
