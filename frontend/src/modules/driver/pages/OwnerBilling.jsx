import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2 } from 'lucide-react';
import DriverBottomNav from '../../shared/components/DriverBottomNav';
import {
  createOwnerPlanRazorpayOrder,
  getOwnerBilling,
  getOwnerBillingHistory,
  getOwnerWalletHistory,
  setOwnerBillingMode,
  subscribeOwnerPlan,
  verifyOwnerPlanRazorpay,
} from '../services/registrationService';

const money = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const unwrap = (res) => res?.data?.data ?? res?.data ?? res;
const errMsg = (e, fallback) => e?.response?.data?.message || e?.message || fallback;
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const range = (r) => (r ? (r.min === r.max ? `${r.min}` : `${r.min} - ${r.max}`) : '');

const loadRazorpay = () =>
  new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });

const OwnerBilling = () => {
  const [billing, setBilling] = useState(null);
  const [history, setHistory] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [confirmMode, setConfirmMode] = useState('');

  const load = useCallback(async () => {
    try {
      const [b, h, w] = await Promise.all([getOwnerBilling(), getOwnerBillingHistory(), getOwnerWalletHistory().catch(() => null)]);
      setBilling(unwrap(b));
      setHistory(unwrap(h) || []);
      setLedger(unwrap(w)?.results || []);
    } catch (e) {
      toast.error(errMsg(e, 'Unable to load plan & billing'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const buy = async (plan) => {
    setBusy(plan.id);
    try {
      const wallet = Number(billing?.walletBalance || 0);
      const canWallet = (billing?.paymentMethods || []).includes('wallet') && wallet >= plan.amount;
      if (canWallet) {
        await subscribeOwnerPlan(plan.id, 'wallet');
        toast.success('Plan activated');
        await load();
        return;
      }
      if (!(await loadRazorpay())) throw new Error('Razorpay failed to load. Check your connection.');
      const order = unwrap(await createOwnerPlanRazorpayOrder(plan.id));
      await new Promise((resolve, reject) => {
        const rzp = new window.Razorpay({
          key: order.keyId,
          amount: order.amount,
          currency: order.currency || 'INR',
          name: 'Roozgar Cab',
          description: order.planName || plan.name,
          order_id: order.orderId,
          handler: async (r) => {
            try {
              await verifyOwnerPlanRazorpay({
                razorpay_order_id: r.razorpay_order_id,
                razorpay_payment_id: r.razorpay_payment_id,
                razorpay_signature: r.razorpay_signature,
              });
              resolve();
            } catch (e) { reject(e); }
          },
          modal: { ondismiss: () => reject(new Error('Payment cancelled')) },
          theme: { color: '#F5A623' },
        });
        rzp.on('payment.failed', (ev) => reject(new Error(ev?.error?.description || 'Payment failed')));
        rzp.open();
      });
      toast.success('Plan activated');
      await load();
    } catch (e) {
      toast.error(errMsg(e, 'Could not buy plan'));
    } finally {
      setBusy('');
    }
  };

  const switchMode = async () => {
    setBusy('mode');
    try {
      setBilling(unwrap(await setOwnerBillingMode(confirmMode)));
      toast.success('Billing mode updated');
      setConfirmMode('');
    } catch (e) {
      toast.error(errMsg(e, 'Could not switch mode'));
    } finally {
      setBusy('');
    }
  };

  if (loading) {
    return <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center"><Loader2 size={32} className="animate-spin text-slate-400" /></div>;
  }

  const mode = billing?.mode;
  const pct = range(billing?.commission?.percentage);
  const fixed = range(billing?.commission?.fixedPerRide);
  const commissionText = [pct && `${pct}%`, fixed && `₹${fixed} per ride`].filter(Boolean).join(' + ') || 'the admin-set commission';
  const expiry = billing?.subscription?.expiresAt || billing?.currentCycle?.expiresAt;

  return (
    <div className="min-h-screen bg-[#f8f9fb] pb-32">
      <div className="mx-auto max-w-lg px-5 pt-10 space-y-5">
        <h1 className="text-[24px] font-black text-slate-950">Plan &amp; billing</h1>

        <div className={`rounded-3xl px-5 py-4 text-[13px] font-black ${billing?.serviceActive ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
          {billing?.serviceActive
            ? `Fleet working${mode === 'subscription' ? ` until ${day(expiry)}` : ' (commission mode)'}`
            : `Service stopped — renew or switch to commission${billing?.reason ? `. ${billing.reason}` : ''}`}
        </div>

        <section className="rounded-3xl bg-white p-5 shadow-sm space-y-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Current mode</p>
          <div className="grid grid-cols-2 gap-2">
            {['subscription', 'commission'].map((m) => (
              <button
                key={m}
                type="button"
                disabled={mode === m}
                onClick={() => setConfirmMode(m)}
                className={`rounded-2xl py-3 text-[12px] font-black ${mode === m ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}`}
              >
                {m === 'subscription' ? 'Plan' : 'Commission'}
              </button>
            ))}
          </div>
          <p className="text-[12px] font-semibold text-slate-500">Platform commission: {commissionText}. Wallet: {money(billing?.walletBalance)}</p>
        </section>

        <section className="space-y-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Plans</p>
          {(billing?.plans || []).map((p) => (
            <div key={p.id} className="rounded-3xl bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[15px] font-black text-slate-900">{p.name}</p>
                  <p className="text-[11px] font-bold text-slate-400">{p.durationDays} days</p>
                </div>
                <p className="text-[20px] font-black text-slate-900">{money(p.amount)}</p>
              </div>
              {p.description ? <p className="mt-2 text-[12px] font-semibold text-slate-500">{p.description}</p> : null}
              {p.howItWorks ? <p className="mt-1 text-[11px] font-semibold text-slate-400">{p.howItWorks}</p> : null}
              <button
                type="button"
                disabled={!!busy}
                onClick={() => buy(p)}
                className="mt-3 w-full rounded-2xl bg-emerald-500 py-3 text-[12px] font-black text-white disabled:opacity-60"
              >
                {busy === p.id ? 'Processing...' : Number(billing?.walletBalance || 0) >= p.amount ? 'Buy from wallet' : 'Buy online'}
              </button>
            </div>
          ))}
        </section>

        <section className="space-y-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Purchase history</p>
          {history.length === 0 ? <p className="text-[12px] font-bold text-slate-400">No purchases yet.</p> : history.map((h) => (
            <div key={h.id} className="rounded-2xl bg-white p-4 shadow-sm text-[12px] font-semibold text-slate-600">
              <div className="flex justify-between font-black text-slate-900"><span>{h.planName}</span><span>{money(h.amount)}</span></div>
              <p>{day(h.startsAt)} to {day(h.expiresAt)} • {h.paymentMethod}</p>
              <p>Paid {day(h.paidAt)} • {h.tripsCovered ?? 0} trips{h.commissionWaived ? ` • commission waived ${money(h.commissionWaived)}` : ''}</p>
            </div>
          ))}
        </section>

        <section className="space-y-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Wallet activity</p>
          {ledger.length === 0 ? <p className="text-[12px] font-bold text-slate-400">No wallet activity yet.</p> : ledger.map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm text-[12px] font-semibold text-slate-600">
              <div>
                <p className="font-black text-slate-900">{t.title}</p>
                <p>{day(t.createdAt)} • balance {money(t.balance)}</p>
              </div>
              <p className={`text-[14px] font-black ${t.kind === 'credit' ? 'text-emerald-600' : 'text-rose-600'}`}>{t.kind === 'credit' ? '+' : '-'}{money(t.amount)}</p>
            </div>
          ))}
        </section>
      </div>

      {confirmMode ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 px-6">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 space-y-4">
            <h2 className="text-[16px] font-black text-slate-900">Switch to {confirmMode === 'subscription' ? 'Plan' : 'Commission'}?</h2>
            <p className="text-[13px] font-semibold text-slate-600">
              {confirmMode === 'subscription'
                ? 'Your whole fleet works for the plan duration with no commission and no pass per driver. When the plan ends, you and all your drivers get no rides until you renew or switch back.'
                : `The platform keeps ${commissionText} on each fleet ride. Online rides credit your wallet the rest; cash rides debit the commission from your wallet.`}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setConfirmMode('')} className="rounded-2xl bg-slate-100 py-3 text-[12px] font-black text-slate-600">Cancel</button>
              <button type="button" disabled={busy === 'mode'} onClick={switchMode} className="rounded-2xl bg-slate-900 py-3 text-[12px] font-black text-white disabled:opacity-60">
                {busy === 'mode' ? 'Switching...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <DriverBottomNav />
    </div>
  );
};

export default OwnerBilling;
