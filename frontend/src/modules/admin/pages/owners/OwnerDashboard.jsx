import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users, Car, UserCheck, Clock, IndianRupee, Wallet, CreditCard, TrendingUp, Monitor, RefreshCw, Briefcase, Banknote, Percent, Loader2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import AdminPageHeader from '../../components/ui/AdminPageHeader';
import { adminService } from '../../services/adminService';

const rupees = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const num = (value) => Number(value || 0).toLocaleString('en-IN');
const when = (value) => (value ? new Date(value).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

const Tone = {
  green: { bg: 'bg-emerald-50', text: 'text-emerald-600' },
  red: { bg: 'bg-red-50', text: 'text-red-500' },
  amber: { bg: 'bg-amber-50', text: 'text-amber-600' },
  sky: { bg: 'bg-sky-50', text: 'text-sky-600' },
  slate: { bg: 'bg-slate-50', text: 'text-slate-600' },
};

const StatCard = ({ icon: Icon, label, value, hint, tone = Tone.green, onClick }) => (
  <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm flex items-center justify-between hover:shadow-md transition-shadow">
    <div className="flex items-center gap-3 min-w-0">
      <div className={`w-10 h-10 ${tone.bg} ${tone.text} rounded-lg flex items-center justify-center shrink-0`}><Icon size={20} /></div>
      <div className="min-w-0">
        <p className="text-[11px] font-bold text-gray-500">{label}</p>
        <p className="text-xl font-black text-gray-900 mt-0.5">{value}</p>
        {hint ? <p className="text-[10px] font-semibold text-gray-400">{hint}</p> : null}
      </div>
    </div>
    {onClick ? <button type="button" onClick={onClick} className="text-[10px] font-bold text-yellow-600 hover:underline shrink-0">View all</button> : null}
  </div>
);

const MoneyCard = ({ icon: Icon, label, value, tone = Tone.sky }) => (
  <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm flex items-center justify-between">
    <div>
      <p className="text-[11px] font-bold text-gray-500">{label}</p>
      <p className="text-lg font-black text-gray-900 mt-0.5">{rupees(value)}</p>
    </div>
    <div className={`w-8 h-8 ${tone.bg} ${tone.text} rounded-lg flex items-center justify-center`}><Icon size={16} /></div>
  </div>
);

const Section = ({ title, hint, children, right }) => (
  <section className="space-y-3">
    <div className="flex items-end justify-between gap-3">
      <div>
        <h2 className="text-sm font-black text-gray-900">{title}</h2>
        {hint ? <p className="text-[11px] font-semibold text-gray-400">{hint}</p> : null}
      </div>
      {right}
    </div>
    {children}
  </section>
);

// Today's trips as a ring: completed / cancelled / on a trip / scheduled, drawn with SVG so it needs no library.
const TripsRing = ({ rides }) => {
  const parts = [
    { key: 'completed', label: 'Completed', value: rides.completed, color: '#facc15' },
    { key: 'cancelled', label: 'Cancelled', value: rides.cancelled, color: '#f59e0b' },
    { key: 'ongoing', label: 'On a trip now', value: rides.ongoing, color: '#10b981' },
    { key: 'scheduled', label: 'Scheduled', value: rides.scheduled, color: '#0ea5e9' },
  ];
  const sum = parts.reduce((total, part) => total + part.value, 0) || 1;
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="flex flex-col items-center">
      <div className="relative w-36 h-36">
        <svg viewBox="0 0 128 128" className="w-36 h-36 -rotate-90">
          <circle cx="64" cy="64" r={radius} fill="none" stroke="#f1f5f9" strokeWidth="14" />
          {parts.map((part) => {
            const length = (part.value / sum) * circumference;
            const circle = (
              <circle key={part.key} cx="64" cy="64" r={radius} fill="none" stroke={part.color} strokeWidth="14"
                strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset} />
            );
            offset += length;
            return part.value ? circle : null;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-2xl font-black text-gray-900">{num(rides.total)}</p>
          <p className="text-[10px] font-bold text-gray-400">Fleet trips today</p>
        </div>
      </div>
      <div className="mt-4 w-full space-y-2">
        {parts.map((part) => (
          <div key={part.key} className="flex items-center justify-between px-2">
            <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full" style={{ background: part.color }} /><span className="text-xs font-bold text-gray-500">{part.label}</span></div>
            <span className="text-xs font-black text-gray-900">{num(part.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const MonthlyBars = ({ months }) => {
  const max = Math.max(1, ...months.map((month) => month.earnings));
  return (
    <div>
      <div className="h-44 flex items-end justify-between gap-2 border-b-2 border-gray-100 pb-0">
        {months.map((month) => (
          <div key={month.key} className="flex-1 flex flex-col items-center justify-end h-full" title={`${month.label}: ${rupees(month.earnings)} from ${month.rides} trips, platform kept ${rupees(month.commission)}`}>
            <span className="text-[9px] font-bold text-gray-400 mb-1">{month.earnings ? rupees(month.earnings) : ''}</span>
            <div className="w-full max-w-[34px] rounded-t bg-emerald-500/80" style={{ height: `${Math.max(month.earnings ? 4 : 1, (month.earnings / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between mt-2">
        {months.map((month) => <span key={month.key} className="flex-1 text-center text-[10px] font-bold text-gray-400">{month.label}</span>)}
      </div>
    </div>
  );
};

const OwnerDashboard = () => {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const res = await adminService.getOwnerManagementDashboard();
      const body = res?.data?.data ?? res?.data ?? res;
      if (!body || typeof body !== 'object' || !body.owners) throw new Error('The dashboard returned no data');
      setData(body);
    } catch (err) {
      const message = err?.response?.data?.message || err?.message || 'Could not load the owner dashboard';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const header = (
    <AdminPageHeader
      module="Owner Management"
      page="Owner Dashboard"
      title="Owner Dashboard"
      right={(
        <button type="button" onClick={load} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-60">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      )}
    />
  );

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-2 lg:px-6">
        {header}
        <div className="flex flex-col items-center justify-center min-h-[320px] gap-3">
          <Loader2 className="animate-spin text-gray-400" size={32} />
          <p className="text-sm font-bold text-gray-500">Loading owner insights...</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-2 lg:px-6">
        {header}
        <div className="rounded-xl border border-red-100 bg-white p-8 text-center">
          <p className="text-sm font-black text-red-600">{error}</p>
          <button type="button" onClick={load} className="mt-4 rounded-lg bg-yellow-400 px-4 py-2 text-xs font-black text-black">Try again</button>
        </div>
      </div>
    );
  }

  const { owners, billing, fleets, drivers, today, overall, monthly, topOwners } = data;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-4 py-2 lg:px-6 lg:py-2">
        {header}
        <div className="space-y-8">
          <Section title="Owners" hint="Owners who run a fleet on the platform, and how each one pays Roozgar Cab">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard icon={Users} label="Registered owners" value={num(owners.total)} onClick={() => navigate('/admin/owners')} />
              <StatCard icon={UserCheck} label="Approved owners" value={num(owners.approved)} onClick={() => navigate('/admin/owners')} />
              <StatCard icon={Clock} label="Awaiting review" value={num(owners.pending)} tone={Tone.red} onClick={() => navigate('/admin/owners')} />
              <StatCard icon={Briefcase} label="Plan revenue" value={rupees(billing.planRevenue)} tone={Tone.amber}
                hint={`${num(billing.plansSold)} plans sold, ${rupees(billing.planRevenueThisMonth)} this month`} onClick={() => navigate('/admin/owner-subscriptions')} />
              <StatCard icon={UserCheck} label="On a plan now" value={num(billing.onPlan)} hint="Fleet works, no commission" />
              <StatCard icon={Percent} label="On commission" value={num(billing.onCommission)} tone={Tone.sky} hint="Platform keeps a share of each ride" />
              <StatCard icon={Clock} label="Service stopped" value={num(billing.stopped)} tone={Tone.red} hint="Plan ended, no commission chosen" onClick={() => navigate('/admin/owner-subscriptions')} />
              <StatCard icon={Car} label="Registered fleets" value={num(fleets.total)} hint={`${num(fleets.approved)} approved, ${num(fleets.pending)} waiting`} onClick={() => navigate('/admin/fleet/drivers')} />
            </div>
          </Section>

          <Section title="Fleet drivers" hint="Drivers who work for an owner (solo drivers are not counted here)">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard icon={Monitor} label="Fleet drivers" value={num(drivers.total)} onClick={() => navigate('/admin/drivers')} />
              <StatCard icon={UserCheck} label="Approved" value={num(drivers.approved)} />
              <StatCard icon={Clock} label="Awaiting review" value={num(drivers.pending)} tone={Tone.red} onClick={() => navigate('/admin/drivers/pending')} />
              <StatCard icon={Car} label="Online now" value={num(drivers.online)} tone={Tone.sky} hint={`${num(drivers.onTrip)} on a trip`} />
            </div>
          </Section>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-1 bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
              <p className="text-sm font-bold text-gray-900 mb-4">Today's trips</p>
              <TripsRing rides={today.rides} />
            </div>
            <div className="lg:col-span-2 space-y-4">
              <Section title="Today" hint="Completed fleet trips today (India time)">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <MoneyCard icon={IndianRupee} label="Today earnings (fares)" value={today.earnings} />
                  <MoneyCard icon={Banknote} label="Paid in cash" value={today.cash} tone={Tone.green} />
                  <MoneyCard icon={Wallet} label="Paid from wallet" value={today.wallet} tone={Tone.amber} />
                  <MoneyCard icon={CreditCard} label="Paid online" value={today.online} tone={Tone.red} />
                  <MoneyCard icon={Percent} label="Platform commission" value={today.commission} tone={Tone.slate} />
                  <MoneyCard icon={Car} label="Fleet earnings (after commission)" value={today.driverEarnings} tone={Tone.slate} />
                </div>
              </Section>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <Section title="Overall" hint="All completed fleet trips so far">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <MoneyCard icon={TrendingUp} label="Overall earnings (fares)" value={overall.earnings} tone={Tone.red} />
                  <MoneyCard icon={Banknote} label="Paid in cash" value={overall.cash} tone={Tone.amber} />
                  <MoneyCard icon={Wallet} label="Paid from wallet" value={overall.wallet} tone={Tone.green} />
                  <MoneyCard icon={CreditCard} label="Paid online" value={overall.online} tone={Tone.sky} />
                  <MoneyCard icon={Percent} label="Platform commission" value={overall.commission} tone={Tone.slate} />
                  <MoneyCard icon={Car} label="Fleet earnings (after commission)" value={overall.driverEarnings} tone={Tone.slate} />
                </div>
              </Section>
            </div>
            <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
              <p className="text-sm font-bold text-gray-900 mb-1">Fleet earnings, last 6 months</p>
              <p className="text-[11px] font-semibold text-gray-400 mb-4">Fares of completed trips by month</p>
              <MonthlyBars months={monthly || []} />
            </div>
          </div>

          <Section title="Top owners" hint="By the fares their drivers earned"
            right={<button type="button" onClick={() => navigate('/admin/owners')} className="text-[11px] font-bold text-yellow-600 hover:underline">All owners</button>}>
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 text-[11px] uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Owner</th><th className="px-4 py-3">Pays by</th><th className="px-4 py-3">Fleet</th>
                    <th className="px-4 py-3 text-right">Drivers</th><th className="px-4 py-3 text-right">Trips</th>
                    <th className="px-4 py-3 text-right">Fares</th><th className="px-4 py-3 text-right">Commission</th>
                  </tr>
                </thead>
                <tbody>
                  {(topOwners || []).length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-10 text-center text-sm font-semibold text-gray-400">No owner has fleet drivers yet.</td></tr>
                  ) : topOwners.map((owner) => (
                    <tr key={owner.id} className="border-t border-gray-100">
                      <td className="px-4 py-3"><p className="font-bold text-gray-900">{owner.name}</p><p className="text-[11px] text-gray-400">{owner.phone}</p></td>
                      <td className="px-4 py-3"><span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] font-bold text-gray-600">{owner.mode === 'commission' ? 'Commission' : 'Plan'}</span></td>
                      <td className="px-4 py-3">
                        <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${owner.serviceActive ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>{owner.serviceActive ? 'Working' : 'Stopped'}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold">{num(owner.drivers)}</td>
                      <td className="px-4 py-3 text-right font-semibold">{num(owner.rides)}</td>
                      <td className="px-4 py-3 text-right font-bold">{rupees(owner.earnings)}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-600">{rupees(owner.commission)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {data.generatedAt ? <p className="text-[10px] font-semibold text-gray-400">Updated {when(data.generatedAt)}</p> : null}
        </div>
      </div>
    </div>
  );
};

export default OwnerDashboard;
