import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone } from 'lucide-react';
import toast from 'react-hot-toast';
import DriverBottomNav from '../../shared/components/DriverBottomNav';
import { socketService } from '../../../shared/api/socket';
import {
  acceptShareRequest,
  cancelShareTrip,
  completeShareRide,
  completeShareTrip,
  getShareEarnings,
  getShareRequests,
  getShareTrip,
  releaseShareRider,
  verifySharePickup,
} from '../services/registrationService';

// Body of a { success, data, message } reply, however the axios view wraps it.
const unwrap = (res) => {
  const d = res?.data;
  return d && typeof d === 'object' && 'data' in d ? d.data : d;
};
const errMsg = (e) => e?.response?.data?.message || e?.message || 'Something went wrong';
const rs = (n) => `Rs ${Number(n || 0).toLocaleString('en-IN')}`;
const SOURCE_TITLE = { trip: 'Riders on your route', ride: 'Riders along your current ride', idle: 'Riders near you' };

const Btn = ({ tone = 'dark', className = '', ...p }) => (
  <button
    type="button"
    {...p}
    className={`rounded-xl px-4 py-2.5 text-xs font-black uppercase tracking-wider active:scale-95 disabled:opacity-50 ${
      tone === 'dark' ? 'bg-slate-950 text-white' : 'border border-slate-200 bg-white text-slate-700'
    } ${className}`}
  />
);

const Route = ({ ride }) => (
  <div className="text-[13px] font-semibold text-slate-800">
    <p>{ride.pickup?.address || 'Pickup'}</p>
    <p className="text-slate-400">to</p>
    <p>{ride.drop?.address || 'Drop'}</p>
  </div>
);

const ShareRides = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState('requests');
  const [reqs, setReqs] = useState(null);
  const [trip, setTrip] = useState(null);
  const [earn, setEarn] = useState(null);
  const [busy, setBusy] = useState('');
  const [otps, setOtps] = useState({});
  const [collect, setCollect] = useState(null); // ride being dropped
  const [via, setVia] = useState('cash');
  const [settled, setSettled] = useState(null);

  const load = useCallback(async () => {
    const [r, t, e] = await Promise.allSettled([getShareRequests(), getShareTrip(), getShareEarnings()]);
    if (r.status === 'fulfilled') setReqs(unwrap(r.value));
    if (t.status === 'fulfilled') {
      const v = unwrap(t.value);
      setTrip(v && Array.isArray(v.riders) ? v : null);
    }
    if (e.status === 'fulfilled') setEarn(unwrap(e.value));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 8000);
    socketService.on('share:request:new', load);
    socketService.on('share:ride:updated', load);
    return () => {
      clearInterval(timer);
      socketService.off('share:request:new', load);
      socketService.off('share:ride:updated', load);
    };
  }, [load]);

  const run = async (key, fn, okMsg) => {
    if (busy) return null;
    setBusy(key);
    try {
      const res = await fn();
      if (okMsg) toast.success(okMsg);
      await load();
      return res;
    } catch (e) {
      toast.error(errMsg(e));
      return null;
    } finally {
      setBusy('');
    }
  };

  const confirmRun = (msg, key, fn, ok) => window.confirm(msg) && run(key, fn, ok);

  const drop = async () => {
    const res = await run('complete', () => completeShareRide(collect.id, via), 'Ride completed');
    if (res) {
      setSettled(unwrap(res)?.settlement || {});
      setCollect(null);
    }
  };

  const reason = reqs && reqs.eligible === false ? reqs.reason : '';

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <div className="mx-auto max-w-md px-4 pt-10">
        <h1 className="text-xl font-black text-slate-900">Share Rides</h1>
        <div className="mt-4 grid grid-cols-3 gap-1 rounded-2xl bg-slate-200 p-1">
          {[['requests', 'Requests'], ['trip', 'My trip'], ['earnings', 'Earnings']].map(([k, l]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`rounded-xl py-2 text-[11px] font-black uppercase ${tab === k ? 'bg-white text-slate-900 shadow' : 'text-slate-500'}`}
            >
              {l}
            </button>
          ))}
        </div>

        {tab === 'requests' && (
          <div className="mt-4 space-y-3">
            {reason ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-black text-amber-900">{reason}</p>
                {/pass/i.test(reason) && (
                  <Btn className="mt-3" onClick={() => navigate('/taxi/driver/wallet')}>
                    Get a pass
                  </Btn>
                )}
              </div>
            ) : !reqs ? (
              <p className="text-sm text-slate-500">Loading...</p>
            ) : (
              <>
                <p className="text-sm font-black text-slate-700">
                  {SOURCE_TITLE[reqs.source] || 'Riders near you'} - {reqs.seatsFree} seat(s) free
                </p>
                {!reqs.requests?.length && <p className="text-sm text-slate-500">No requests right now. This refreshes by itself.</p>}
                {(reqs.requests || []).map((r) => (
                  <div key={r.id} className="rounded-2xl bg-white p-4 shadow-sm">
                    <Route ride={r} />
                    <p className="mt-2 text-xs font-bold text-slate-500">
                      {r.seats} seat(s) - {rs(r.fare)}
                    </p>
                    {r.fit?.pickupOffKm != null && r.fit?.dropOffKm != null && (
                      <p className="text-[11px] text-slate-400">
                        {r.fit.pickupOffKm} km / {r.fit.dropOffKm} km off your route
                      </p>
                    )}
                    <Btn
                      className="mt-3 w-full"
                      disabled={Boolean(busy)}
                      onClick={async () => {
                        if (await run(`acc${r.id}`, () => acceptShareRequest(r.id), 'Added to your ride')) setTab('trip');
                      }}
                    >
                      Add to my ride
                    </Btn>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {tab === 'trip' && (
          <div className="mt-4 space-y-3">
            {!trip ? (
              <p className="text-sm text-slate-500">No share trip yet. Add a request to start one.</p>
            ) : (
              <>
                <div className="rounded-2xl bg-slate-950 p-4 text-white">
                  <p className="text-[13px] font-bold">{trip.origin?.address || 'Start'}</p>
                  <p className="text-[11px] text-white/50">to</p>
                  <p className="text-[13px] font-bold">{trip.destination?.address || 'Destination'}</p>
                  <p className="mt-2 text-xs font-black uppercase">
                    Seats {trip.seatsTaken}/{trip.seatsTotal}
                  </p>
                </div>
                {trip.riders.map((r) => (
                  <div key={r.id} className="rounded-2xl bg-white p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-black text-slate-900">{r.passenger?.name || 'Rider'}</p>
                      {r.passenger?.phone && (
                        <a href={`tel:${r.passenger.phone}`} className="flex items-center gap-1 text-xs font-black text-blue-600">
                          <Phone size={14} /> {r.passenger.phone}
                        </a>
                      )}
                    </div>
                    <div className="mt-2"><Route ride={r} /></div>
                    <p className="mt-2 text-xs font-bold text-slate-500">
                      {r.seats} seat(s) - {rs(r.fare)} - {r.status}
                    </p>
                    {r.status === 'accepted' && (
                      <div className="mt-3 space-y-2">
                        <div className="flex gap-2">
                          <input
                            inputMode="numeric"
                            maxLength={4}
                            placeholder="Rider OTP"
                            value={otps[r.id] || ''}
                            onChange={(e) => setOtps({ ...otps, [r.id]: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                            className="w-28 rounded-xl border border-slate-200 px-3 text-center text-lg font-black tracking-widest"
                          />
                          <Btn
                            className="flex-1"
                            disabled={Boolean(busy) || (otps[r.id] || '').length !== 4}
                            onClick={() => run(`pk${r.id}`, () => verifySharePickup(r.id, otps[r.id]), 'Ride started')}
                          >
                            Start ride
                          </Btn>
                        </div>
                        <Btn
                          tone="light"
                          className="w-full"
                          disabled={Boolean(busy)}
                          onClick={() => confirmRun('Hand this rider back?', `rel${r.id}`, () => releaseShareRider(r.id), 'Rider handed back')}
                        >
                          Hand back
                        </Btn>
                      </div>
                    )}
                    {r.status === 'ongoing' && (
                      <Btn className="mt-3 w-full" disabled={Boolean(busy)} onClick={() => { setVia('cash'); setCollect(r); }}>
                        Drop &amp; collect
                      </Btn>
                    )}
                  </div>
                ))}
                {!trip.riders.length && <p className="text-sm text-slate-500">No riders on this trip.</p>}
                <div className="grid grid-cols-2 gap-2">
                  <Btn
                    disabled={Boolean(busy)}
                    onClick={() => confirmRun('Close this trip?', 'close', () => completeShareTrip(trip.id), 'Trip closed')}
                  >
                    Close trip
                  </Btn>
                  <Btn
                    tone="light"
                    disabled={Boolean(busy)}
                    onClick={() => confirmRun('Cancel this trip?', 'cancel', () => cancelShareTrip(trip.id), 'Trip cancelled')}
                  >
                    Cancel trip
                  </Btn>
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'earnings' && (
          <div className="mt-4 space-y-3">
            {!earn ? (
              <p className="text-sm text-slate-500">Loading...</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 text-center">
                  {[
                    ['Rides', earn.rides],
                    ['Gross', rs(earn.gross)],
                    ['Platform fee', rs(earn.platformFee)],
                    ['Commission waived', rs(earn.commissionWaived)],
                  ].map(([l, v]) => (
                    <div key={l} className="rounded-2xl bg-white p-3 shadow-sm">
                      <p className="text-base font-black text-slate-900">{v}</p>
                      <p className="text-[10px] font-bold uppercase text-slate-400">{l}</p>
                    </div>
                  ))}
                </div>
                <div className="rounded-2xl bg-emerald-600 p-4 text-center text-white">
                  <p className="text-2xl font-black">{rs(earn.driverEarnings)}</p>
                  <p className="text-[10px] font-bold uppercase">Your earnings</p>
                </div>
                {(earn.recent || []).map((r) => (
                  <div key={r.id} className="rounded-2xl bg-white p-3 shadow-sm">
                    <Route ride={r} />
                    <p className="mt-1 text-xs font-bold text-slate-500">
                      Fare {rs(r.fare)} - You earned {rs(r.settlement?.driverEarnings)}
                    </p>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {collect && (
        <div className="fixed inset-0 z-[60] flex items-end bg-black/50" onClick={() => !busy && setCollect(null)}>
          <div className="mx-auto w-full max-w-md rounded-t-3xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-xs font-bold uppercase text-slate-400">Collect from rider</p>
            <p className="text-3xl font-black text-slate-900">{rs(collect.fare)}</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {['cash', 'upi'].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVia(v)}
                  className={`rounded-xl border-2 py-3 text-sm font-black uppercase ${via === v ? 'border-slate-950 bg-slate-950 text-white' : 'border-slate-200'}`}
                >
                  {v}
                </button>
              ))}
            </div>
            <Btn className="mt-4 w-full" disabled={Boolean(busy)} onClick={drop}>
              Confirm collected
            </Btn>
          </div>
        </div>
      )}

      {settled && (
        <div className="fixed inset-0 z-[60] flex items-end bg-black/50">
          <div className="mx-auto w-full max-w-md rounded-t-3xl bg-white p-5">
            <p className="text-lg font-black text-slate-900">Ride completed</p>
            {settled.driverEarnings == null ? (
              <p className="mt-2 text-sm text-slate-500">Settlement is being processed.</p>
            ) : (
              <div className="mt-3 space-y-1 text-sm font-semibold text-slate-600">
                <p className="flex justify-between"><span>Platform fee</span><span>{rs(settled.platformFee)}</span></p>
                <p className="flex justify-between"><span>Commission</span><span>{rs(settled.commission)}</span></p>
                {settled.commissionWaived > 0 && (
                  <p className="flex justify-between text-emerald-600">
                    <span>Waived by your pass</span><span>{rs(settled.commissionWaived)}</span>
                  </p>
                )}
                <p className="flex justify-between border-t pt-2 text-base font-black text-slate-900">
                  <span>Your earning</span><span>{rs(settled.driverEarnings)}</span>
                </p>
              </div>
            )}
            <Btn className="mt-4 w-full" onClick={() => setSettled(null)}>Done</Btn>
          </div>
        </div>
      )}
      <DriverBottomNav />
    </div>
  );
};

export default ShareRides;
