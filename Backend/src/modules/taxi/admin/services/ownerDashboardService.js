import { Owner } from '../models/Owner.js';
import { OwnerSubscription } from '../models/OwnerSubscription.js';
import { FleetVehicle } from '../models/FleetVehicle.js';
import { Driver } from '../../driver/models/Driver.js';
import { Ride } from '../../user/models/Ride.js';
import { getServingOwnerIds } from '../../driver/services/ownerBillingService.js';

/**
 * Numbers for Admin > Owner Management > Dashboard, all worked out from the database: owners (and how they pay the platform),
 * their fleets and drivers, and the money from the rides their drivers did. A "fleet ride" is a ride taken by a driver who is
 * linked to an owner. Money counts completed rides only.
 */

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Midnight in India, whatever the server's own timezone.
const startOfIstDay = (date = new Date()) => {
  const istDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
  return new Date(`${istDay}T00:00:00+05:30`);
};

// How a completed ride was paid: wallet, online (in the app), otherwise cash/UPI to the driver.
const PAID_BY = {
  $switch: {
    branches: [
      { case: { $eq: ['$driverPaymentCollection.provider', 'wallet'] }, then: 'wallet' },
      { case: { $or: [{ $eq: ['$collectedVia', 'online'] }, { $eq: ['$paymentMethod', 'online'] }] }, then: 'online' },
    ],
    default: 'cash',
  },
};

const fleetRideSummary = async (driverIds, range = {}) => {
  const empty = { rides: { total: 0, completed: 0, cancelled: 0, scheduled: 0, ongoing: 0 }, earnings: 0, commission: 0, driverEarnings: 0, cash: 0, wallet: 0, online: 0 };
  if (!driverIds.length) return empty;
  const base = { driverId: { $in: driverIds }, adminDeletedAt: null, ...range };
  const [facets] = await Ride.aggregate([
    { $match: base },
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
        totals: [
          { $match: { status: 'completed' } },
          { $group: { _id: null, fare: { $sum: '$fare' }, commission: { $sum: '$commissionAmount' }, driverEarnings: { $sum: '$driverEarnings' } } },
        ],
        byPayment: [
          { $match: { status: 'completed' } },
          { $group: { _id: PAID_BY, fare: { $sum: '$fare' } } },
        ],
      },
    },
  ]);
  const count = (status) => facets.byStatus.find((row) => row._id === status)?.n || 0;
  const paid = (key) => round(facets.byPayment.find((row) => row._id === key)?.fare);
  const totals = facets.totals[0] || {};
  return {
    rides: {
      total: facets.byStatus.reduce((sum, row) => sum + row.n, 0),
      completed: count('completed'),
      cancelled: count('cancelled'),
      ongoing: count('accepted') + count('ongoing'),
      // Booked for later and still looking for a driver.
      scheduled: 0,
    },
    earnings: round(totals.fare),
    commission: round(totals.commission),
    driverEarnings: round(totals.driverEarnings),
    cash: paid('cash'),
    wallet: paid('wallet'),
    online: paid('online'),
  };
};

export const buildOwnerDashboard = async () => {
  const now = new Date();
  const today = startOfIstDay(now);

  const [totalOwners, approvedOwners, serving, onCommission, plansPaid, fleetTotals, fleetDriverDocs] = await Promise.all([
    Owner.countDocuments({ deletedAt: null }),
    Owner.countDocuments({ deletedAt: null, approve: true }),
    getServingOwnerIds(),
    Owner.countDocuments({ deletedAt: null, 'billing.mode': 'commission' }),
    OwnerSubscription.aggregate([
      { $match: { paidAt: { $ne: null } } },
      { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 }, thisMonth: { $sum: { $cond: [{ $gte: ['$paidAt', new Date(now.getFullYear(), now.getMonth(), 1)] }, '$amount', 0] } } } },
    ]),
    FleetVehicle.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Driver.find({ owner_id: { $ne: null }, deletedAt: null }).select('owner_id approve isOnline isOnRide').lean(),
  ]);

  const driverIds = fleetDriverDocs.map((driver) => driver._id);
  const ownerOf = new Map(fleetDriverDocs.map((driver) => [String(driver._id), String(driver.owner_id)]));
  const onPlanIds = await OwnerSubscription.distinct('ownerId', { status: 'active', paidAt: { $ne: null }, startsAt: { $lte: now }, expiresAt: { $gt: now } });
  const servingSet = new Set(serving.map(String));
  const approvedIds = new Set((await Owner.find({ deletedAt: null, approve: true }).select('_id').lean()).map((owner) => String(owner._id)));
  const stoppedOwners = [...approvedIds].filter((id) => !servingSet.has(id)).length;

  const fleetCount = (status) => fleetTotals.find((row) => row._id === status)?.n || 0;
  const fleetAll = fleetTotals.reduce((sum, row) => sum + row.n, 0);

  const [todaySummary, overallSummary, scheduledToday, monthly, perDriver] = await Promise.all([
    fleetRideSummary(driverIds, { createdAt: { $gte: today } }),
    fleetRideSummary(driverIds),
    driverIds.length ? Ride.countDocuments({ driverId: { $in: driverIds }, status: 'searching', scheduledAt: { $gt: now }, adminDeletedAt: null }) : 0,
    driverIds.length
      ? Ride.aggregate([
        { $match: { driverId: { $in: driverIds }, status: 'completed', adminDeletedAt: null, completedAt: { $gte: new Date(now.getFullYear(), now.getMonth() - 5, 1) } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$completedAt', timezone: 'Asia/Kolkata' } }, earnings: { $sum: '$fare' }, commission: { $sum: '$commissionAmount' }, rides: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
      : [],
    driverIds.length
      ? Ride.aggregate([
        { $match: { driverId: { $in: driverIds }, status: 'completed', adminDeletedAt: null } },
        { $group: { _id: '$driverId', rides: { $sum: 1 }, fare: { $sum: '$fare' }, commission: { $sum: '$commissionAmount' }, earnings: { $sum: '$driverEarnings' } } },
      ])
      : [],
  ]);
  todaySummary.rides.scheduled = scheduledToday;

  // The last six months, every month present (an empty month is a zero, not a gap).
  const months = [];
  for (let i = 5; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const row = monthly.find((entry) => entry._id === key);
    months.push({ key, label: date.toLocaleString('en-IN', { month: 'short', year: '2-digit' }), earnings: round(row?.earnings), commission: round(row?.commission), rides: row?.rides || 0 });
  }

  // Which owners earned the most: the driver totals rolled up to their owner.
  const byOwner = new Map();
  for (const row of perDriver) {
    const ownerId = ownerOf.get(String(row._id));
    if (!ownerId) continue;
    const entry = byOwner.get(ownerId) || { rides: 0, earnings: 0, commission: 0 };
    entry.rides += row.rides; entry.earnings += row.fare; entry.commission += row.commission;
    byOwner.set(ownerId, entry);
  }
  const driversPerOwner = new Map();
  for (const driver of fleetDriverDocs) driversPerOwner.set(String(driver.owner_id), (driversPerOwner.get(String(driver.owner_id)) || 0) + 1);
  const ranked = [...new Set([...byOwner.keys(), ...driversPerOwner.keys()])];
  const ownerDocs = ranked.length ? await Owner.find({ _id: { $in: ranked } }).select('company_name owner_name name mobile billing').lean() : [];
  const topOwners = ownerDocs
    .map((owner) => {
      const id = String(owner._id);
      const stats = byOwner.get(id) || { rides: 0, earnings: 0, commission: 0 };
      return {
        id,
        name: owner.company_name || owner.owner_name || owner.name || 'Owner',
        phone: owner.mobile || '',
        mode: owner.billing?.mode === 'commission' ? 'commission' : 'subscription',
        serviceActive: servingSet.has(id),
        drivers: driversPerOwner.get(id) || 0,
        rides: stats.rides,
        earnings: round(stats.earnings),
        commission: round(stats.commission),
      };
    })
    .sort((a, b) => b.earnings - a.earnings || b.drivers - a.drivers)
    .slice(0, 8);

  const drivers = {
    total: fleetDriverDocs.length,
    approved: fleetDriverDocs.filter((driver) => driver.approve === true).length,
    online: fleetDriverDocs.filter((driver) => driver.isOnline).length,
    onTrip: fleetDriverDocs.filter((driver) => driver.isOnRide).length,
  };
  drivers.pending = drivers.total - drivers.approved;

  return {
    owners: { total: totalOwners, approved: approvedOwners, pending: totalOwners - approvedOwners },
    billing: {
      onPlan: onPlanIds.length,
      onCommission,
      stopped: stoppedOwners,
      plansSold: plansPaid[0]?.count || 0,
      planRevenue: round(plansPaid[0]?.amount),
      planRevenueThisMonth: round(plansPaid[0]?.thisMonth),
    },
    fleets: { total: fleetAll, approved: fleetCount('approved'), pending: fleetCount('pending'), rejected: fleetCount('rejected') },
    drivers,
    today: todaySummary,
    overall: overallSummary,
    monthly: months,
    topOwners,
    generatedAt: now,

    // Older field names the page used to read (kept so nothing else breaks).
    total_owners: totalOwners,
    approved_owners: approvedOwners,
    pending_owners: totalOwners - approvedOwners,
    total_drivers: drivers.total,
    approved_drivers: drivers.approved,
    pending_drivers: drivers.pending,
    total_fleets: fleetAll,
    approved_fleets: fleetCount('approved'),
    pending_fleets: fleetCount('pending'),
    today_earnings: todaySummary.earnings,
    today_cash: todaySummary.cash,
    today_wallet: todaySummary.wallet,
    today_online: todaySummary.online,
    admin_commission: todaySummary.commission,
    driver_earnings: todaySummary.driverEarnings,
    overall_earnings: overallSummary.earnings,
    overall_cash: overallSummary.cash,
    overall_wallet: overallSummary.wallet,
    overall_online: overallSummary.online,
    overall_admin_comm: overallSummary.commission,
    overall_owner_earnings: overallSummary.driverEarnings,
  };
};
