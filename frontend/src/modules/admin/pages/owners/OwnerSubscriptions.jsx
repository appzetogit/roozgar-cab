import React, { useState, useEffect, useCallback } from 'react';
import { ChevronRight, Plus, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { adminService } from '../../services/adminService';

const TABS = ['Owners', 'Plans', 'Payments', 'Commission'];
const th = 'px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider';
const td = 'px-4 py-4 text-sm text-gray-600';
const inp = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-gray-50 outline-none focus:border-yellow-400 focus:bg-white';
const lbl = 'block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5';
const btn = 'px-3 py-2 text-sm text-black font-semibold bg-yellow-400 rounded-lg shadow-sm hover:bg-yellow-500 transition-colors';
const fmt = (d) => (d ? new Date(d).toLocaleDateString() : '-');
const Badge = ({ ok, children }) => (
  <span className={`inline-flex px-2.5 py-0.5 rounded text-xs font-medium ${ok ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{children}</span>
);
const Empty = ({ loading, cols, n }) => (
  <tr><td colSpan={cols} className="py-12 text-center text-sm text-gray-400">
    {loading ? <Loader2 className="w-6 h-6 mx-auto text-indigo-600 animate-spin" /> : n === 0 ? 'Nothing found.' : null}
  </td></tr>
);

// run an API call, toast the outcome, report success
const run = async (fn, okMsg) => {
  try {
    const res = await fn();
    if (res.success === false) throw new Error(res.message);
    toast.success(okMsg);
    return true;
  } catch (e) {
    toast.error(e.message || 'Action failed');
    return false;
  }
};

const OwnersTab = ({ plans }) => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [grant, setGrant] = useState(null); // {ownerId, planId, amount, days}
  const load = useCallback(async () => {
    setLoading(true);
    try { setRows((await adminService.getOwnerSubOwners()).data?.results || []); } catch (e) { toast.error(e.message || 'Failed to load'); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const submitGrant = async () => {
    const body = { ownerId: grant.ownerId, planId: grant.planId };
    if (grant.amount !== '') body.amount = Number(grant.amount);
    if (grant.days !== '') body.days = Number(grant.days);
    if (await run(() => adminService.grantOwnerSubPlan(body), 'Plan granted')) { setGrant(null); load(); }
  };
  const setMode = async (o) => {
    const mode = o.mode === 'commission' ? 'subscription' : 'commission';
    if (await run(() => adminService.setOwnerBillingMode(o.id, mode), `Mode set to ${mode}`)) load();
  };

  return (
    <>
      {grant && (
        <div className="p-4 border-b border-gray-100 grid grid-cols-1 sm:grid-cols-4 gap-4 items-end">
          <div><label className={lbl}>Plan</label>
            <select className={inp} value={grant.planId} onChange={(e) => setGrant({ ...grant, planId: e.target.value })}>
              <option value="">Select plan</option>
              {plans.filter((p) => p.active).map((p) => <option key={p._id} value={p._id}>{p.name} (Rs {p.amount}, {p.duration}d)</option>)}
            </select></div>
          <div><label className={lbl}>Amount Rs (optional, default 0)</label>
            <input type="number" min="0" className={inp} value={grant.amount} onChange={(e) => setGrant({ ...grant, amount: e.target.value })} /></div>
          <div><label className={lbl}>Days (optional)</label>
            <input type="number" min="1" className={inp} value={grant.days} onChange={(e) => setGrant({ ...grant, days: e.target.value })} /></div>
          <div className="flex gap-2">
            <button disabled={!grant.planId} onClick={submitGrant} className={`${btn} disabled:opacity-50`}>Grant</button>
            <button onClick={() => setGrant(null)} className="px-3 py-2 text-sm border border-gray-200 rounded-lg text-gray-600">Cancel</button>
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="bg-gray-50 border-b border-gray-100">
            {['Owner', 'Phone', 'Mode', 'Service', 'Plan / Expiry', 'Drivers', 'Wallet', 'Action'].map((h) => <th key={h} className={th}>{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-gray-50">
            {(loading || !rows.length) && <Empty loading={loading} cols={8} n={rows.length} />}
            {rows.map((o) => (
              <tr key={o.id} className="hover:bg-gray-50/50">
                <td className={`${td} font-medium text-gray-900`}>{o.name || '-'}</td>
                <td className={td}>{o.phone || '-'}</td>
                <td className={td}><Badge ok={o.mode === 'subscription'}>{o.mode}</Badge></td>
                <td className={td}><Badge ok={o.serviceActive}>{o.serviceActive ? 'Active' : 'Stopped'}</Badge></td>
                <td className={td}>{o.planName ? `${o.planName} - ${fmt(o.expiresAt)}` : '-'}</td>
                <td className={td}>{o.drivers ?? 0}</td>
                <td className={td}>Rs {o.walletBalance ?? 0}</td>
                <td className={`${td} whitespace-nowrap`}>
                  <button onClick={() => setGrant({ ownerId: o.id, planId: '', amount: '', days: '' })} className="text-indigo-600 hover:underline mr-3">Grant plan</button>
                  <button onClick={() => setMode(o)} className="text-indigo-600 hover:underline">
                    Set {o.mode === 'commission' ? 'subscription' : 'commission'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};

const blank = { name: '', amount: '', duration: '', description: '', how_it_works: '', active: true };

const PlansTab = ({ plans, loading, reload }) => {
  const [form, setForm] = useState(null); // blank or existing plan
  const save = async () => {
    const body = { ...form, amount: Number(form.amount), duration: Number(form.duration) };
    delete body._id;
    const call = form._id ? () => adminService.updateOwnerSubPlan(form._id, body) : () => adminService.createOwnerSubPlan(body);
    if (await run(call, 'Plan saved')) { setForm(null); reload(); }
  };
  const remove = async (p) => {
    if (window.confirm(`Delete plan "${p.name}"?`) && await run(() => adminService.deleteOwnerSubPlan(p._id), 'Plan deleted')) reload();
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <div className="p-4 flex justify-end border-b border-gray-100">
        <button onClick={() => setForm(blank)} className={`${btn} flex items-center gap-1.5`}><Plus size={16} /> Add Plan</button>
      </div>
      {form && (
        <div className="p-4 border-b border-gray-100 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><label className={lbl}>Name</label><input className={inp} value={form.name} onChange={set('name')} /></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className={lbl}>Amount (Rs)</label><input type="number" min="0" className={inp} value={form.amount} onChange={set('amount')} /></div>
            <div><label className={lbl}>Duration (days)</label><input type="number" min="1" className={inp} value={form.duration} onChange={set('duration')} /></div>
          </div>
          <div><label className={lbl}>Description</label><textarea rows={2} className={inp} value={form.description} onChange={set('description')} /></div>
          <div><label className={lbl}>How it works</label><textarea rows={2} className={inp} value={form.how_it_works} onChange={set('how_it_works')} /></div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={!!form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active
          </label>
          <div className="flex gap-2 sm:justify-end">
            <button disabled={!form.name || !form.amount || !form.duration} onClick={save} className={`${btn} disabled:opacity-50`}>Save</button>
            <button onClick={() => setForm(null)} className="px-3 py-2 text-sm border border-gray-200 rounded-lg text-gray-600">Cancel</button>
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="bg-gray-50 border-b border-gray-100">
            {['Name', 'Amount', 'Duration', 'Status', 'Action'].map((h) => <th key={h} className={th}>{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-gray-50">
            {(loading || !plans.length) && <Empty loading={loading} cols={5} n={plans.length} />}
            {plans.map((p) => (
              <tr key={p._id} className="hover:bg-gray-50/50">
                <td className={`${td} font-medium text-gray-900`}>{p.name}</td>
                <td className={td}>Rs {p.amount}</td>
                <td className={td}>{p.duration} days</td>
                <td className={td}><Badge ok={p.active}>{p.active ? 'Active' : 'Inactive'}</Badge></td>
                <td className={td}>
                  <button onClick={() => setForm(p)} className="text-indigo-600 hover:underline mr-3">Edit</button>
                  <button onClick={() => remove(p)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};

const PaymentsTab = () => {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ results: [], total: 0, limit: 20, collected: 0 });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    adminService.getOwnerSubPayments({ page, limit: 20, status })
      .then((r) => setData((d) => ({ ...d, ...(r.data || {}) })))
      .catch((e) => toast.error(e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [status, page]);
  const pages = Math.max(1, Math.ceil(data.total / (data.limit || 20)));

  return (
    <>
      <div className="p-4 flex items-center justify-between gap-4 border-b border-gray-100">
        <select className={`${inp} !w-40`} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All</option><option value="active">Active</option><option value="expired">Expired</option>
        </select>
        <span className="text-sm text-gray-600">Total collected: <b>Rs {data.collected ?? 0}</b></span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="bg-gray-50 border-b border-gray-100">
            {['Owner', 'Plan', 'Amount', 'Method', 'Paid', 'Expires', 'Status', 'Trips covered'].map((h) => <th key={h} className={th}>{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-gray-50">
            {(loading || !data.results.length) && <Empty loading={loading} cols={8} n={data.results.length} />}
            {!loading && data.results.map((p) => (
              <tr key={p.id} className="hover:bg-gray-50/50">
                <td className={`${td} font-medium text-gray-900`}>{p.ownerName} <span className="text-gray-400 font-normal">{p.ownerPhone}</span></td>
                <td className={td}>{p.planName}</td>
                <td className={td}>Rs {p.amount}</td>
                <td className={td}>{p.paymentMethod}</td>
                <td className={td}>{fmt(p.paidAt)}</td>
                <td className={td}>{fmt(p.expiresAt)}</td>
                <td className={td}><Badge ok={p.active}>{p.active ? 'Active' : 'Expired'}</Badge></td>
                <td className={td}>{p.tripsCovered ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-400">
        <span>{data.total} entries</span>
        <div className="flex gap-1">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-3 py-1.5 border border-gray-200 rounded disabled:opacity-50">Prev</button>
          <button disabled={page >= pages} onClick={() => setPage(page + 1)} className="px-3 py-1.5 border border-gray-200 rounded disabled:opacity-50">Next</button>
        </div>
      </div>
    </>
  );
};

// One place to see and set the commission taken on fleet rides for an owner on commission.
const CommissionTab = () => {
  const [summary, setSummary] = useState(null);
  const [type, setType] = useState('percentage');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try { setSummary((await adminService.getOwnerCommission()).data || null); } catch (e) { toast.error(e.message || 'Failed to load commission'); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const apply = async () => {
    if (value === '' || Number(value) < 0 || (type === 'percentage' && Number(value) > 100)) { toast.error('Enter a valid commission'); return; }
    if (!window.confirm(`Set the owner commission to ${value}${type === 'percentage' ? '%' : ' Rs per ride'} on ALL price rows, rental packages and vehicle types?`)) return;
    setSaving(true);
    if (await run(() => adminService.setOwnerCommission({ type, value: Number(value) }), 'Owner commission updated')) await load();
    setSaving(false);
  };
  const line = (r) => `${r.type === 'percentage' ? `${r.value}%` : `Rs ${r.value} per ride`} on ${r.rows} row${r.rows === 1 ? '' : 's'}`;
  const block = (title, list) => (
    <div>
      <p className={lbl}>{title}</p>
      {list?.length ? list.map((r, i) => <p key={i} className="text-sm text-gray-700">{line(r)}</p>) : <p className="text-sm text-gray-400">None</p>}
    </div>
  );
  return (
    <div className="p-6 space-y-6">
      <p className="text-sm text-gray-500">
        Charged on every ride of a fleet driver when the owner runs on <b>commission</b>. An owner on a plan pays no commission.
        Set it for everything here, or change a single route/vehicle under Price Management (Admin Commission From Owner).
      </p>
      <div className="grid md:grid-cols-3 gap-6">
        {block('Price rows', summary?.prices)}
        {block('Rental packages', summary?.packages)}
        {block('Vehicle types', summary?.vehicleTypes)}
      </div>
      <div className="flex flex-wrap items-end gap-3 max-w-xl">
        <div className="w-40"><label className={lbl}>Type</label>
          <select className={inp} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="percentage">Percentage of fare</option><option value="fixed">Fixed per ride</option>
          </select></div>
        <div className="w-32"><label className={lbl}>{type === 'percentage' ? 'Percent' : 'Rupees'}</label>
          <input className={inp} type="number" min="0" value={value} onChange={(e) => setValue(e.target.value)} /></div>
        <button className={btn} disabled={saving} onClick={apply}>{saving ? 'Saving...' : 'Apply to all'}</button>
      </div>
    </div>
  );
};

const OwnerSubscriptions = () => {
  const [tab, setTab] = useState('Owners');
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const loadPlans = useCallback(async () => {
    setLoading(true);
    try { setPlans((await adminService.getOwnerSubPlans()).data?.results || []); } catch (e) { toast.error(e.message || 'Failed to load plans'); }
    setLoading(false);
  }, []);
  useEffect(() => { loadPlans(); }, [loadPlans]);

  return (
    <div className="min-h-screen bg-gray-50 p-6 lg:p-8">
      <div className="mb-6">
        <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-2">
          <span>Owners</span><ChevronRight size={12} /><span className="text-gray-700">Subscription</span>
        </div>
        <h1 className="text-xl text-gray-900 font-bold">Owner Subscriptions</h1>
      </div>
      <div className="flex gap-2 mb-4">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-semibold rounded-lg border ${tab === t ? 'bg-yellow-400 border-yellow-400 text-black' : 'bg-white border-gray-200 text-gray-600'}`}>{t}</button>
        ))}
      </div>
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {tab === 'Owners' && <OwnersTab plans={plans} />}
        {tab === 'Plans' && <PlansTab plans={plans} loading={loading} reload={loadPlans} />}
        {tab === 'Payments' && <PaymentsTab />}
        {tab === 'Commission' && <CommissionTab />}
      </div>
    </div>
  );
};

export default OwnerSubscriptions;
