import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Phone, LoaderCircle, CheckCircle2, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { userService } from '../../services/userService';
import { socketService } from '../../../../shared/api/socket';

const payloadOf = (r) => r?.data?.data ?? r?.data ?? r;
const errorOf = (e) => e?.response?.data?.message || e?.message || 'Something went wrong';
const money = (n) => `₹${Math.round(Number(n) || 0)}`;
const POLL_MS = 8000;

const timeLeft = (expiresAt, now) => {
  const s = Math.max(0, Math.floor((new Date(expiresAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const ShareRideTrack = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [ride, setRide] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      setRide(payloadOf(await userService.getShareRide(id)));
    } catch (e) {
      toast.error(errorOf(e));
    }
  }, [id]);

  useEffect(() => {
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    // Optional push: only attaches if the app already has a rider socket open.
    socketService.on('share:ride:updated', load);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      socketService.off('share:ride:updated', load);
    };
  }, [load]);

  const cancel = async () => {
    setCancelling(true);
    try {
      setRide(payloadOf(await userService.cancelShareRide(id, { reason: 'Cancelled by rider' })));
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setCancelling(false);
    }
  };

  const goHome = () => navigate('/taxi/user/share-ride', { replace: true });
  const status = ride?.status;
  const card = 'rounded-3xl bg-white border border-slate-100 p-5 shadow-sm';

  return (
    <div className="min-h-screen bg-[#F3F4F6] max-w-lg mx-auto font-sans pb-10">
      <header className="bg-white px-5 pt-10 pb-4 sticky top-0 z-20 border-b border-slate-100 flex items-center gap-3">
        <motion.button whileTap={{ scale: 0.9 }} onClick={goHome}
          className="w-9 h-9 rounded-[12px] border border-slate-100 bg-white flex items-center justify-center shadow-sm shrink-0">
          <ArrowLeft size={18} className="text-slate-900" strokeWidth={2.5} />
        </motion.button>
        <h1 className="text-lg font-black text-slate-900">Share ride</h1>
      </header>

      <main className="px-5 pt-5 space-y-4">
        {!ride && <div className="flex justify-center py-16"><LoaderCircle className="animate-spin text-slate-400" /></div>}

        {status === 'searching' && (
          <div className={`${card} text-center space-y-3`}>
            <motion.div animate={{ scale: [1, 1.15, 1], opacity: [1, 0.6, 1] }} transition={{ repeat: Infinity, duration: 1.6 }}
              className="mx-auto w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center">
              <LoaderCircle className="animate-spin text-emerald-600" size={30} />
            </motion.div>
            <h2 className="text-xl font-black text-slate-900">Finding a driver</h2>
            <p className="text-sm text-slate-500">Drivers going your way will see your request. Request expires in <b>{timeLeft(ride.expiresAt, now)}</b>.</p>
          </div>
        )}

        {status === 'accepted' && (
          <div className={`${card} text-center space-y-2`}>
            <p className="text-sm font-bold text-slate-500">Share this OTP with your driver at pickup</p>
            <p className="text-5xl font-black tracking-[0.3em] text-slate-900 pl-[0.3em]">{ride.otp}</p>
          </div>
        )}

        {(status === 'accepted' || status === 'ongoing') && ride.driver && (
          <div className={`${card} flex items-center justify-between gap-3`}>
            <div className="min-w-0">
              <p className="text-base font-black text-slate-900 truncate">{ride.driver.name}</p>
              <p className="text-sm text-slate-500">
                {[ride.vehicle?.number, ride.vehicle?.color, ride.vehicle?.name].filter(Boolean).join(' · ')}
              </p>
            </div>
            {ride.driver.phone && (
              <a href={`tel:${ride.driver.phone}`} aria-label="Call driver" className="w-11 h-11 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0">
                <Phone size={18} />
              </a>
            )}
          </div>
        )}

        {status === 'ongoing' && (
          <div className={`${card} text-center`}>
            <h2 className="text-xl font-black text-slate-900">Trip in progress</h2>
            <p className="mt-1 text-sm text-slate-500">Pay the driver in cash or UPI</p>
          </div>
        )}

        {status === 'completed' && (
          <div className={`${card} text-center space-y-2`}>
            <CheckCircle2 className="mx-auto text-emerald-500" size={48} />
            <h2 className="text-xl font-black text-slate-900">Thank you for riding!</h2>
            <p className="text-sm text-slate-500">Fare paid: <b>{money(ride.fare)}</b>{ride.collectedVia ? ` (${ride.collectedVia})` : ''}</p>
          </div>
        )}

        {(status === 'cancelled' || status === 'expired') && (
          <div className={`${card} text-center space-y-2`}>
            <XCircle className="mx-auto text-slate-400" size={48} />
            <h2 className="text-xl font-black text-slate-900">{status === 'expired' ? 'No driver found' : 'Ride cancelled'}</h2>
            <p className="text-sm text-slate-500">
              {status === 'expired' ? 'Nobody picked up your request in time.' : (ride.cancelReason || 'This share ride was cancelled.')}
            </p>
          </div>
        )}

        {ride && (
          <div className={`${card} space-y-3 text-sm`}>
            <div><p className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-slate-400">Pickup</p><p className="font-bold text-slate-900">{ride.pickup?.address}</p></div>
            <div><p className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-slate-400">Drop</p><p className="font-bold text-slate-900">{ride.drop?.address}</p></div>
            <div className="flex justify-between border-t border-slate-100 pt-3">
              <span className="text-slate-500">{ride.seats} seat{ride.seats > 1 ? 's' : ''}</span>
              <b className="text-base">{money(ride.fare)}</b>
            </div>
          </div>
        )}

        {(status === 'searching' || status === 'accepted') && (
          <button disabled={cancelling} onClick={cancel} className="w-full rounded-2xl border border-rose-200 bg-white py-3.5 text-sm font-black text-rose-500 disabled:opacity-50">
            {cancelling ? 'Cancelling...' : 'Cancel ride'}
          </button>
        )}
        {['completed', 'cancelled', 'expired'].includes(status) && (
          <button onClick={goHome} className="w-full rounded-2xl bg-slate-900 py-4 text-sm font-black text-white">
            {status === 'completed' ? 'Back to share rides' : 'Request again'}
          </button>
        )}
      </main>
    </div>
  );
};

export default ShareRideTrack;
