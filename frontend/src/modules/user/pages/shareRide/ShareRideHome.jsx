import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, MapPin, Navigation, Minus, Plus, LoaderCircle, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { userService } from '../../services/userService';

const payloadOf = (r) => r?.data?.data ?? r?.data ?? r;
const errorOf = (e) => e?.response?.data?.message || e?.message || 'Something went wrong';
const money = (n) => `₹${Math.round(Number(n) || 0)}`;
const STATUS_STYLE = {
  completed: 'bg-emerald-50 text-emerald-600',
  cancelled: 'bg-slate-100 text-slate-500',
  expired: 'bg-slate-100 text-slate-500',
};

const ShareRideHome = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state || {};
  const [seats, setSeats] = useState(Number(state.seats) || 1);
  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState([]);

  // SelectLocation hands coords back as [lng, lat].
  const pickup = state.pickup && state.pickupCoords
    ? { address: state.pickup, lng: state.pickupCoords[0], lat: state.pickupCoords[1] }
    : null;
  const drop = state.drop && state.dropCoords
    ? { address: state.drop, lng: state.dropCoords[0], lat: state.dropCoords[1] }
    : null;

  useEffect(() => {
    let alive = true;
    userService.getMyShareRides({ status: 'active' })
      .then((r) => {
        const active = [].concat(payloadOf(r) || [])[0];
        if (alive && active?.id) navigate(`/taxi/user/share-ride/${active.id}`, { replace: true });
      })
      .catch(() => {});
    userService.getMyShareRides({ status: 'history' })
      .then((r) => alive && setHistory([].concat(payloadOf(r) || [])))
      .catch(() => {});
    return () => { alive = false; };
  }, [navigate]);

  const pickupKey = pickup ? `${pickup.lat},${pickup.lng}` : '';
  const dropKey = drop ? `${drop.lat},${drop.lng}` : '';
  useEffect(() => {
    if (!pickupKey || !dropKey) { setQuote(null); return undefined; }
    let alive = true;
    setQuoting(true);
    userService.quoteShareRide({ pickup, drop, seats })
      .then((r) => alive && setQuote(payloadOf(r)))
      .catch((e) => alive && setQuote({ available: false, reason: errorOf(e) }))
      .finally(() => alive && setQuoting(false));
    return () => { alive = false; };
    // pickup/drop objects are derived from the keys
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickupKey, dropKey, seats]);

  const pick = (activeInput) => navigate('/taxi/user/ride/select-location', {
    state: {
      flow: 'parcel',
      returnTo: '/taxi/user/share-ride',
      openMapPicker: true,
      activeInput,
      editPickup: activeInput === 'pickup',
      pickup: state.pickup,
      drop: state.drop,
      pickupCoords: state.pickupCoords,
      dropCoords: state.dropCoords,
      seats,
    },
  });

  const request = async () => {
    setSubmitting(true);
    try {
      const ride = payloadOf(await userService.createShareRide({ pickup, drop, seats }));
      navigate(`/taxi/user/share-ride/${ride.id}`, { replace: true });
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setSubmitting(false);
    }
  };

  const row = (label, place, input, tone) => (
    <button onClick={() => pick(input)} className="w-full flex items-center gap-3 rounded-2xl bg-white border border-slate-100 px-4 py-3.5 text-left shadow-sm active:scale-[0.99]">
      <span className={`w-9 h-9 rounded-xl flex items-center justify-center ${tone}`}>
        {input === 'pickup' ? <Navigation size={16} /> : <MapPin size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-extrabold uppercase tracking-[0.2em] text-slate-400">{label}</span>
        <span className={`block truncate text-sm font-bold ${place ? 'text-slate-900' : 'text-slate-400'}`}>{place?.address || `Choose ${label.toLowerCase()} location`}</span>
      </span>
    </button>
  );

  return (
    <div className="min-h-screen bg-[#F3F4F6] max-w-lg mx-auto font-sans pb-28">
      <header className="bg-white px-5 pt-10 pb-4 sticky top-0 z-20 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <motion.button whileTap={{ scale: 0.9 }} onClick={() => navigate('/taxi/user')}
            className="w-9 h-9 rounded-[12px] border border-slate-100 bg-white flex items-center justify-center shadow-sm shrink-0">
            <ArrowLeft size={18} className="text-slate-900" strokeWidth={2.5} />
          </motion.button>
          <div>
            <p className="text-[9px] font-extrabold uppercase tracking-[0.26em] text-emerald-600">Share Ride</p>
            <h1 className="text-lg font-black text-slate-900 leading-tight">Share a cab, pay less</h1>
          </div>
        </div>
      </header>

      <main className="px-5 pt-5 space-y-3">
        {row('Pickup', pickup, 'pickup', 'bg-emerald-50 text-emerald-600')}
        {row('Drop', drop, 'drop', 'bg-rose-50 text-rose-500')}

        <div className="flex items-center justify-between rounded-2xl bg-white border border-slate-100 px-4 py-3 shadow-sm">
          <span className="flex items-center gap-2 text-sm font-bold text-slate-900"><Users size={16} className="text-slate-400" /> Seats</span>
          <span className="flex items-center gap-4">
            <button disabled={seats <= 1} onClick={() => setSeats(seats - 1)} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center disabled:opacity-40"><Minus size={14} /></button>
            <span className="w-4 text-center text-base font-black">{seats}</span>
            <button disabled={seats >= 4} onClick={() => setSeats(seats + 1)} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center disabled:opacity-40"><Plus size={14} /></button>
          </span>
        </div>

        {quoting && <div className="flex justify-center py-4"><LoaderCircle className="animate-spin text-slate-400" /></div>}
        {!quoting && quote?.available === false && (
          <div className="rounded-2xl bg-amber-50 border border-amber-100 px-4 py-3 text-sm font-bold text-amber-700">{quote.reason || 'Share ride is not available for this trip.'}</div>
        )}
        {!quoting && quote?.available && (
          <div className="rounded-2xl bg-white border border-slate-100 p-4 shadow-sm space-y-2 text-sm">
            <div className="inline-block rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-extrabold text-emerald-600">{quote.discountPercent}% sharing discount</div>
            <div className="flex justify-between"><span className="text-slate-500">Per seat</span><b>{money(quote.perSeat)}</b></div>
            <div className="flex justify-between"><span className="text-slate-500">Platform fee</span><b>{money(quote.platformFee)}</b></div>
            <div className="flex justify-between"><span className="text-slate-500">Distance</span><b>{Number(quote.distanceKm).toFixed(1)} km</b></div>
            <div className="flex justify-between border-t border-slate-100 pt-2 text-base"><span className="font-black">Total ({quote.seats} seat{quote.seats > 1 ? 's' : ''})</span><b className="font-black">{money(quote.total)}</b></div>
            <p className="text-[11px] text-slate-400">You pay the driver in cash or UPI at drop.</p>
          </div>
        )}

        <div className="pt-4">
          <h2 className="text-xs font-extrabold uppercase tracking-[0.2em] text-slate-400 mb-2">My share rides</h2>
          {history.length === 0 && <p className="text-sm text-slate-400">No share rides yet.</p>}
          <div className="space-y-2">
            {history.map((ride) => (
              <button key={ride.id} onClick={() => navigate(`/taxi/user/share-ride/${ride.id}`)} className="w-full flex items-center justify-between gap-3 rounded-2xl bg-white border border-slate-100 px-4 py-3 text-left shadow-sm">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold text-slate-900">{ride.drop?.address}</span>
                  <span className="block text-[11px] text-slate-400">{new Date(ride.createdAt).toLocaleDateString()} · {ride.seats} seat{ride.seats > 1 ? 's' : ''}</span>
                </span>
                <span className="text-right shrink-0">
                  <b className="block text-sm">{money(ride.fare)}</b>
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-extrabold capitalize ${STATUS_STYLE[ride.status] || 'bg-slate-100 text-slate-500'}`}>{ride.status}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </main>

      <div className="fixed bottom-0 inset-x-0 max-w-lg mx-auto bg-white border-t border-slate-100 px-5 py-4">
        <button disabled={!quote?.available || quoting || submitting} onClick={request}
          className="w-full rounded-2xl bg-slate-900 py-4 text-sm font-black text-white disabled:opacity-40">
          {submitting ? 'Requesting...' : 'Request share ride'}
        </button>
      </div>
    </div>
  );
};

export default ShareRideHome;
