import React, { useEffect, useState } from 'react';
import { ChevronRight, Search, Share2 } from 'lucide-react';
import { adminService } from '../../services/adminService';

const inr = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const TABS = [{ key: 'trips', label: 'Trips' }, { key: 'rides', label: 'Rides' }];
const TRIP_STATUS = ['', 'active', 'open', 'running', 'completed', 'cancelled'];
const RIDE_STATUS = ['', 'active', 'searching', 'accepted', 'ongoing', 'completed', 'cancelled'];
const TRIP_HEAD = ['Driver', 'Vehicle', 'Route', 'Seats', 'Status', 'Riders completed', 'Gross', 'Created'];
const RIDE_HEAD = ['Passenger', 'Driver', 'Vehicle', 'Route', 'Seats', 'Fare', 'Status', 'Collected via', 'Settlement', 'Date'];
const BADGE = {
  completed: 'bg-green-50 text-green-700 border-green-200',
  cancelled: 'bg-red-50 text-red-700 border-red-200',
  searching: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  open: 'bg-yellow-50 text-yellow-700 border-yellow-200',
};
const badge = (s) => BADGE[s] || 'bg-blue-50 text-blue-700 border-blue-200';
const route = (a, b) => `${a?.address || '-'} → ${b?.address || '-'}`;
const formatDate = (v) => {
  const d = v ? new Date(v) : null;
  return !d || Number.isNaN(d.getTime()) ? 'N/A' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const Card = ({ label, value, sub, alert }) => (
  <div className={`rounded-lg border p-3 ${alert ? 'bg-red-50 border-red-300' : 'bg-white border-gray-200'}`}>
    <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</p>
    <p className={`text-lg font-bold mt-1 ${alert ? 'text-red-600' : 'text-gray-900'}`}>{value}</p>
    {sub ? <p className="text-[10px] text-gray-500">{sub}</p> : null}
  </div>
);

const ShareRides = () => {
  const [overview, setOverview] = useState(null);
  const [tab, setTab] = useState('trips');
  const [status, setStatus] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [paginator, setPaginator] = useState({ current_page: 1, last_page: 1, total: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    adminService.getShareRideOverview()
      .then((r) => { if (r?.success) setOverview(r.data); })
      .catch((e) => setError(e?.message || 'Unable to load overview'));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchTerm.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [searchTerm]);

  useEffect(() => {
    let live = true;
    setIsLoading(true);
    setError('');
    const params = { page, limit: 30 };
    if (status) params.status = status;
    const call = tab === 'trips'
      ? adminService.getShareRideTrips(params)
      : adminService.getShareRideRides({ ...params, ...(search ? { search } : {}) });
    call
      .then((r) => {
        if (!live) return;
        if (r?.success) {
          setRows(r.data?.results || []);
          setPaginator(r.data?.paginator || { current_page: 1, last_page: 1, total: 0 });
        } else setError(r?.message || 'Unable to load share rides');
      })
      .catch((e) => { if (live) setError(e?.message || 'Unable to load share rides'); })
      .finally(() => { if (live) setIsLoading(false); });
    return () => { live = false; };
  }, [tab, status, search, page]);

  const t = overview?.totals || {};
  const pending = overview?.walletPending || 0;
  const head = tab === 'trips' ? TRIP_HEAD : RIDE_HEAD;

  return (
    <div className="min-h-screen bg-[#F8FAFC] p-3 lg:p-4 font-sans text-gray-900 space-y-4">
      <div>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500 mb-0.5">
          <span>Share Rides</span><ChevronRight size={10} /><span className="text-gray-700 font-medium">Monitor</span>
        </div>
        <h1 className="text-base font-bold text-gray-900">Share Rides</h1>
        <p className="text-xs text-gray-500">Share Ride is run by drivers and owners. Admin view only.</p>
      </div>

      {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">{error}</div> : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label="Live trips" value={overview?.activeTrips ?? '-'} />
        <Card label="Riders searching" value={overview?.searching ?? '-'} />
        <Card label="Riders on board" value={overview?.onBoard ?? '-'} />
        <Card label="Needs attention" value={pending} sub="wallet settlement pending" alert={pending > 0} />
        <Card label="Rides completed" value={t.rides ?? '-'} sub={`${overview?.today?.rides ?? 0} today`} />
        <Card label="Gross" value={inr(t.gross)} />
        <Card label="Platform fee earned" value={inr(t.platformFee)} />
        <Card label="Commission waived (passes)" value={inr(t.commissionWaived)} />
        <Card label="Driver / owner earnings" value={inr(t.driverEarnings)} />
        <Card label="Cancelled" value={overview?.cancelled ?? '-'} />
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-3">
        <div className="flex flex-col md:flex-row items-center justify-between gap-3">
          <div className="flex gap-1.5">
            {TABS.map((x) => (
              <button key={x.key} type="button" onClick={() => { setTab(x.key); setStatus(''); setPage(1); }}
                className={`px-3 py-1 rounded-md text-xs font-semibold border ${tab === x.key ? 'bg-black text-white border-black' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                {x.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 w-full md:w-auto">
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}
              className="px-2 py-1.5 border border-gray-200 rounded-md text-xs capitalize bg-white">
              {(tab === 'trips' ? TRIP_STATUS : RIDE_STATUS).map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
            </select>
            {tab === 'rides' ? (
              <div className="relative w-full md:w-80">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                <input type="text" placeholder="Passenger, driver, mobile or vehicle number" value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-9 pr-3 py-1.5 border border-gray-200 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400" />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse whitespace-nowrap">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100 text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                {head.map((h) => <th key={h} className="px-3 py-2">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-xs text-gray-700">
              {isLoading ? (
                <tr><td colSpan={head.length} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-4 border-gray-100 border-t-black rounded-full animate-spin" />
                    <p className="text-[12px] font-black text-gray-400 uppercase tracking-widest">Loading...</p>
                  </div>
                </td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={head.length} className="px-4 py-12 text-center">
                  <Share2 size={32} className="text-gray-300 mx-auto mb-2" />
                  <p className="text-sm font-bold text-gray-900">No {tab} found</p>
                </td></tr>
              ) : tab === 'trips' ? rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2"><p className="font-medium">{r.driver?.name || 'Unknown'}</p><p className="text-[10px] text-gray-500">{r.driver?.phone || ''}</p></td>
                  <td className="px-3 py-2 font-mono">{r.vehicle?.number || 'N/A'}</td>
                  <td className="px-3 py-2 max-w-[260px] truncate" title={route(r.origin, r.destination)}>{route(r.origin, r.destination)}</td>
                  <td className="px-3 py-2">{r.seatsTaken}/{r.seatsTotal}</td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold capitalize ${badge(r.status)}`}>{r.status}</span></td>
                  <td className="px-3 py-2">{r.stats?.ridersCompleted || 0}</td>
                  <td className="px-3 py-2">{inr(r.stats?.gross)}</td>
                  <td className="px-3 py-2 text-[10px] text-gray-500">{formatDate(r.createdAt)}</td>
                </tr>
              )) : rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2"><p className="font-medium">{r.passenger?.name || 'Unknown'}</p><p className="text-[10px] text-gray-500">{r.passenger?.phone || ''}</p></td>
                  <td className="px-3 py-2"><p className="font-medium">{r.driver?.name || '-'}</p><p className="text-[10px] text-gray-500">{r.driver?.phone || ''}</p></td>
                  <td className="px-3 py-2 font-mono">{r.vehicle?.number || '-'}</td>
                  <td className="px-3 py-2 max-w-[260px] truncate" title={route(r.pickup, r.drop)}>{route(r.pickup, r.drop)}</td>
                  <td className="px-3 py-2">{r.seats}</td>
                  <td className="px-3 py-2">{inr(r.fare)}</td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold capitalize ${badge(r.status)}`}>{r.status}</span></td>
                  <td className="px-3 py-2 uppercase">{r.collectedVia || '-'}</td>
                  <td className="px-3 py-2 text-[10px]">
                    {r.status === 'completed' ? (
                      <>
                        <p>Fee {inr(r.settlement?.platformFee)} · Comm {inr(r.settlement?.commission)} · Waived {inr(r.settlement?.commissionWaived)}</p>
                        <p className="font-semibold">Earning {inr(r.settlement?.driverEarnings)}</p>
                        {r.settlement?.walletStatus === 'pending' ? (
                          <span className="px-1.5 py-0.5 rounded-full border bg-red-50 text-red-700 border-red-200 font-semibold">Wallet pending</span>
                        ) : null}
                      </>
                    ) : '-'}
                  </td>
                  <td className="px-3 py-2 text-[10px] text-gray-500">{formatDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="p-3 bg-gray-50/50 border-t border-gray-100 flex items-center justify-between">
          <p className="text-[11px] text-gray-500">{paginator.total} {tab} · page {paginator.current_page} of {paginator.last_page || 1}</p>
          <div className="flex gap-2">
            <button type="button" disabled={page <= 1 || isLoading} onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1.5 border border-gray-200 rounded-md text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">Previous</button>
            <button type="button" disabled={page >= (paginator.last_page || 1) || isLoading} onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1.5 border border-gray-200 rounded-md text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">Next</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ShareRides;
