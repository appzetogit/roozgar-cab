import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Calendar, CheckCircle2, Clock3, LoaderCircle, Navigation } from 'lucide-react';
import api from '../../../../shared/api/axiosInstance';
import { useSettings } from '../../../../shared/context/SettingsContext';

const loadRazorpayScript = () =>
  new Promise((resolve) => {
    if (window.Razorpay) { resolve(true); return; }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });

const unwrapData = (r) => r?.data?.data ?? r?.data ?? r;

const generateIntercityBookingId = () =>
  'IC-' + Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6).padEnd(6, '0');

const generateSearchNonce = () =>
  `intercity-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const IntercityConfirm = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const routePrefix = location.pathname.startsWith('/taxi/user') ? '/taxi/user' : '';
  const state = useMemo(() => location.state || {}, [location.state]);
  const { settings } = useSettings();
  const appName = settings?.general?.app_name || 'Roozgar Cab';
  const [status, setStatus] = useState('checking');
  const [error, setError] = useState('');
  const [advanceQuote, setAdvanceQuote] = useState(null);
  const [retryTick, setRetryTick] = useState(0);
  const requestStartedRef = useRef(false);
  const isScheduled = state.rideMode === 'schedule' && Boolean(state.scheduledAt);
  const isBiddingRide = String(state.bookingMode || '').trim().toLowerCase() === 'bidding';

  const vehicleTypeId = state.vehicleTypeId || state.vehicle?.vehicleTypeId || '';
  const bookingIdRef = useRef(state.bookingId || generateIntercityBookingId());
  const bookingId = bookingIdRef.current;
  const intercityPayload = {
    bookingId,
    fromCity: state.fromCity || '',
    toCity: state.toCity || '',
    tripType: state.tripType || 'One Way',
    travelDate: isScheduled ? (state.travelDate || state.date || '') : (state.date || 'Ride Now'),
    passengers: state.passengers || 1,
    distance: Number(state.distance || 0),
    vehicleName: state.vehicle?.name || state.vehicle?.id || 'Intercity Cab',
    packageId: state.vehicle?.packageId || '',
    packageTypeName: state.vehicle?.packageTypeName || 'Intercity',
  };
  const advanceBody = {
    pickup: state.pickupCoords,
    drop: state.dropCoords,
    vehicleTypeId,
    fare: Number(state.baseFare || state.fare || 0),
    service_location_id: state.service_location_id || state.serviceLocationId || undefined,
    intercity: intercityPayload,
  };

  const proceed = async (advanceId) => {
    if (!isScheduled || isBiddingRide) {
      navigate(`${routePrefix}/ride/searching`, {
        replace: true,
        state: {
          ...state,
          advanceId: advanceId || undefined,
          bookingId,
          searchNonce: state.searchNonce || generateSearchNonce(),
          vehicleTypeId,
          vehicleIconType: state.vehicleIconType || state.vehicle?.iconType || state.vehicle?.name || 'car',
          vehicleIconUrl: state.vehicleIconUrl || state.vehicle?.vehicleIconUrl || state.vehicle?.icon || '',
          paymentMethod: state.paymentMethod || 'Cash',
          serviceType: 'intercity',
          transport_type: 'intercity',
          bookingMode: isBiddingRide ? 'bidding' : (state.bookingMode || 'normal'),
          bidStepAmount: Number(state.bidStepAmount || 10),
          userMaxBidFare: Number(state.userMaxBidFare || state.fare || 0),
          intercity: intercityPayload,
        },
      });
      return;
    }

    setStatus('saving');
    try {
      await api.post('/rides', {
        pickup: state.pickupCoords,
        drop: state.dropCoords,
        pickupAddress: state.pickup,
        dropAddress: state.drop,
        fare: Number(state.baseFare || state.fare || 0),
        vehicleTypeId,
        vehicleTypeIds: vehicleTypeId ? [vehicleTypeId] : [],
        vehicleIconType: state.vehicleIconType || state.vehicle?.iconType || state.vehicle?.name || 'car',
        vehicleIconUrl: state.vehicleIconUrl || state.vehicle?.vehicleIconUrl || state.vehicle?.icon || '',
        paymentMethod: state.paymentMethod || 'Cash',
        serviceType: 'intercity',
        transport_type: 'intercity',
        bookingMode: state.bookingMode || 'normal',
        userMaxBidFare: Number(state.userMaxBidFare || state.fare || 0),
        bidStepAmount: Number(state.bidStepAmount || 10),
        scheduledAt: state.scheduledAt,
        advanceId: advanceId || undefined,
        intercity: intercityPayload,
      });
      setStatus('scheduled');
    } catch (requestError) {
      if (requestError?.status === 402 && ['ADVANCE_REQUIRED', 'ADVANCE_MISMATCH', 'ADVANCE_ALREADY_USED'].includes(requestError?.code)) {
        setError(requestError.message || 'Please pay the advance to confirm your booking.');
        setRetryTick((tick) => tick + 1);
        return;
      }
      setStatus('error');
      setError(requestError?.message || 'Could not schedule this intercity ride.');
    }
  };

  useEffect(() => {
    if (!state.pickup || !state.drop || !state.vehicle) {
      navigate(`${routePrefix}/intercity`, { replace: true });
      return undefined;
    }

    let active = true;
    setStatus('checking');
    (async () => {
      try {
        const quote = unwrapData(await api.post('/rides/outstation/advance/quote', advanceBody));
        if (!active) return;
        if (quote?.required && Number(quote.amount) > 0) {
          setAdvanceQuote(quote);
          setStatus('advance');
          return;
        }
        await proceed('');
      } catch (quoteError) {
        if (!active) return;
        setStatus('quoteError');
        setError(quoteError?.message || 'Could not check the advance for this booking.');
      }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryTick]);

  const payAdvance = async () => {
    setStatus('paying');
    setError('');
    try {
      if (!(await loadRazorpayScript())) throw new Error('Razorpay SDK failed to load');
      const order = unwrapData(await api.post('/rides/outstation/advance/order', advanceBody));
      if (!order?.keyId || !order?.orderId) throw new Error('Unable to start advance payment');
      let userInfo = {};
      try { userInfo = JSON.parse(localStorage.getItem('userInfo') || '{}'); } catch { userInfo = {}; }

      const verified = await new Promise((resolve, reject) => {
        const rzp = new window.Razorpay({
          key: order.keyId,
          amount: order.amount,
          currency: order.currency || 'INR',
          name: appName,
          description: 'Outstation booking advance',
          order_id: order.orderId,
          prefill: {
            name: userInfo?.name || '',
            email: userInfo?.email || '',
            contact: userInfo?.phone ? `+91${userInfo.phone}` : '',
          },
          modal: { ondismiss: () => reject(new Error('Advance payment was cancelled')) },
          handler: async (paymentResponse) => {
            try {
              resolve(unwrapData(await api.post('/rides/outstation/advance/verify', {
                advanceId: order.advanceId,
                razorpay_order_id: paymentResponse.razorpay_order_id,
                razorpay_payment_id: paymentResponse.razorpay_payment_id,
                razorpay_signature: paymentResponse.razorpay_signature,
              })));
            } catch (verifyError) {
              reject(new Error(verifyError?.message || 'Advance payment verification failed'));
            }
          },
          theme: { color: '#0f172a' },
        });
        rzp.on('payment.failed', (event) => {
          reject(new Error(event?.error?.description || event?.error?.reason || 'Advance payment failed'));
        });
        rzp.open();
      });

      if (verified?.status !== 'paid') throw new Error('Advance payment could not be confirmed');
      await proceed(verified.advanceId || order.advanceId);
    } catch (payError) {
      setError(payError?.message || 'Advance payment failed. Please try again.');
      setStatus('advance');
    }
  };

  const formattedSchedule = useMemo(() => {
    if (!state.scheduledAt) {
      return '';
    }
    const parsed = new Date(state.scheduledAt);
    if (Number.isNaN(parsed.getTime())) {
      return state.scheduledAt;
    }
    return parsed.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [state.scheduledAt]);

  if (['checking', 'advance', 'paying', 'quoteError'].includes(status)) {
    return (
      <div className="min-h-screen max-w-lg mx-auto flex items-center justify-center bg-slate-950 px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full rounded-[32px] border border-white/10 bg-white/5 px-6 py-8 text-center shadow-2xl"
        >
          {status === 'checking' ? (
            <div className="flex items-center justify-center gap-3 text-[12px] font-black uppercase tracking-[0.18em] text-blue-300">
              <LoaderCircle size={18} className="animate-spin" />
              Preparing your booking
            </div>
          ) : status === 'quoteError' ? (
            <>
              <h1 className="text-[22px] font-black text-white">Something went wrong</h1>
              <p className="mt-2 text-[13px] font-bold text-white/55">{error}</p>
              <button type="button" onClick={() => setRetryTick((tick) => tick + 1)} className="mt-6 h-12 w-full rounded-[18px] bg-white text-sm font-black uppercase tracking-[0.16em] text-slate-900">Retry</button>
              <button type="button" onClick={() => navigate(routePrefix || '/')} className="mt-3 h-12 w-full text-sm font-black uppercase tracking-[0.16em] text-white/60">Back to Home</button>
            </>
          ) : (
            <>
              <h1 className="text-[22px] font-black text-white">Pay Rs {advanceQuote?.amount} now to confirm your booking</h1>
              <p className="mt-3 text-[13px] font-bold text-white/70">Rest Rs {advanceQuote?.remaining} after the ride.</p>
              <p className="mt-1 text-[12px] font-bold text-white/45">Advance is refunded in full if the ride is cancelled.</p>
              <div className="mt-5 rounded-[20px] border border-white/10 bg-white/5 px-4 py-3 text-left text-[12px] font-bold text-white/70">
                {Number(advanceQuote?.tolls) > 0 && (
                  <div className="flex justify-between"><span>Fare before tolls</span><span>Rs {Number(advanceQuote.fare) - Number(advanceQuote.tolls)}</span></div>
                )}
                {Number(advanceQuote?.tolls) > 0 && (
                  <div className="mt-1 flex justify-between"><span>Toll charges on your route</span><span>Rs {advanceQuote.tolls}</span></div>
                )}
                <div className="mt-1 flex justify-between"><span>Total fare</span><span>Rs {advanceQuote?.fare}</span></div>
                <div className="mt-1 flex justify-between"><span>Advance now</span><span>Rs {advanceQuote?.amount}</span></div>
              </div>
              {error ? <p className="mt-3 text-[12px] font-bold text-rose-400">{error}</p> : null}
              <button
                type="button"
                disabled={status === 'paying'}
                onClick={payAdvance}
                className="mt-6 h-12 w-full rounded-[18px] bg-white text-sm font-black uppercase tracking-[0.16em] text-slate-900 disabled:opacity-60"
              >
                {status === 'paying' ? 'Processing...' : `Pay Rs ${advanceQuote?.amount}`}
              </button>
              <button type="button" disabled={status === 'paying'} onClick={() => navigate(-1)} className="mt-3 h-12 w-full text-sm font-black uppercase tracking-[0.16em] text-white/60">Back</button>
            </>
          )}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen max-w-lg mx-auto flex items-center justify-center bg-slate-950 px-6">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full rounded-[32px] border border-white/10 bg-white/5 px-6 py-8 text-center shadow-2xl"
      >
        <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-[22px] ${
          status === 'scheduled' ? 'bg-emerald-600/20 text-emerald-400' :
          status === 'error' ? 'bg-rose-600/20 text-rose-400' : 'bg-blue-600/20 text-blue-400'
        }`}>
          {status === 'scheduled' ? <CheckCircle2 size={26} /> : <Navigation size={26} />}
        </div>
        <h1 className="mt-5 text-[22px] font-black text-white">
          {status === 'scheduled' ? 'Intercity ride scheduled' : status === 'error' ? 'Scheduling failed' : 'Scheduling your ride'}
        </h1>
        <p className="mt-2 text-[13px] font-bold text-white/55">
          {status === 'scheduled'
            ? 'Your booking has been saved. Drivers will be notified automatically at the scheduled time.'
            : status === 'error'
              ? error
              : 'Saving your intercity booking and preparing automatic driver notification.'}
        </p>
        <div className="mt-6 rounded-[24px] border border-white/10 bg-white/5 px-4 py-4 text-left">
          <div className="flex items-center gap-3 text-white">
            <Calendar size={16} className="text-blue-300" />
            <span className="text-sm font-bold">Scheduled For</span>
          </div>
          <p className="mt-2 text-lg font-black text-white">{formattedSchedule || state.date || 'Scheduled'}</p>
          <div className="mt-4 flex items-center gap-3 text-white/65">
            <Clock3 size={15} />
            <span className="text-xs font-bold uppercase tracking-[0.16em]">{state.fromCity} to {state.toCity}</span>
          </div>
        </div>
        {status === 'saving' ? (
          <div className="mt-6 flex items-center justify-center gap-3 text-[12px] font-black uppercase tracking-[0.18em] text-blue-300">
            <LoaderCircle size={18} className="animate-spin" />
            Saving Schedule
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => navigate(routePrefix || '/')}
          className="mt-6 h-12 w-full rounded-[18px] bg-white text-sm font-black uppercase tracking-[0.16em] text-slate-900"
        >
          {status === 'error' ? 'Back to Home' : 'Done'}
        </button>
      </motion.div>
    </div>
  );
};

export default IntercityConfirm;
