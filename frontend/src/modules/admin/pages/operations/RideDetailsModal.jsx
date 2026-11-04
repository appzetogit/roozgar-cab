import React, { useState, useEffect, useCallback } from 'react';
import { X, Copy, Loader2, Phone, Star, MapPin, ChevronDown, RefreshCw, Navigation } from 'lucide-react';
import toast from 'react-hot-toast';
import { adminService } from '../../services/adminService';

// ---------- shared helpers (also used by the list pages) ----------
export const TONE = {
  slate: 'bg-slate-100 text-slate-700 border-slate-200',
  blue: 'bg-blue-100 text-blue-700 border-blue-200',
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  sky: 'bg-sky-100 text-sky-700 border-sky-200',
  green: 'bg-green-100 text-green-700 border-green-200',
  purple: 'bg-purple-100 text-purple-700 border-purple-200',
  red: 'bg-red-100 text-red-700 border-red-200',
  gray: 'bg-gray-100 text-gray-600 border-gray-200',
};
const DOT = {
  slate: 'bg-slate-400', blue: 'bg-blue-500', amber: 'bg-amber-500', sky: 'bg-sky-500', green: 'bg-green-500',
  purple: 'bg-purple-500', red: 'bg-red-500', gray: 'bg-gray-400', yellow: 'bg-yellow-400', success: 'bg-green-500',
  danger: 'bg-red-500', warning: 'bg-amber-500', info: 'bg-blue-500',
};

export const KIND_CHIPS = [
  { label: 'All', value: '' },
  { label: 'City', value: 'city' },
  { label: 'Airport', value: 'airport' },
  { label: 'Outstation', value: 'outstation' },
  { label: 'Rental', value: 'rental' },
];

export const KindBadge = ({ label, tone, big }) => (
  label ? (
    <span className={`inline-flex items-center rounded border font-bold whitespace-nowrap ${big ? 'px-3 py-1 text-xs' : 'px-2 py-0.5 text-[10px]'} ${TONE[tone] || TONE.slate}`}>{label}</span>
  ) : null
);

export const inr = (n) => `Rs ${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export const fmtIST = (v) => {
  const d = v ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
};

const mediaUrl = (u) => (!u ? '' : String(u).startsWith('http') ? u : `${globalThis.__LEGACY_BACKEND_ORIGIN__ || ''}${u}`);
const has = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
const pct = (c) => (c && has(c.value) ? (String(c.type).toLowerCase().includes('percent') ? `${c.value}%` : inr(c.value)) : '');
const words = (k) => String(k).replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
const gmapsDir = (a, b) => `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lng}&destination=${b.lat},${b.lng}`;
const gmapsPt = (p) => `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;

// ---------- layout bits ----------
const Card = ({ title, children, collapsible, className = '' }) => {
  const [open, setOpen] = useState(true);
  return (
    <section className={`rounded-xl border border-gray-200 bg-white ${className}`}>
      <div
        className={`flex items-center justify-between px-4 py-2.5 ${open ? 'border-b border-gray-100' : ''} ${collapsible ? 'cursor-pointer' : ''}`}
        onClick={collapsible ? () => setOpen(!open) : undefined}
      >
        <h3 className="text-[12px] font-bold uppercase tracking-wider text-gray-500">{title}</h3>
        {collapsible && <ChevronDown size={16} className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />}
      </div>
      {open && <div className="p-4 text-[13px]">{children}</div>}
    </section>
  );
};

// Label/value grid; rows with empty values are hidden.
const Facts = ({ rows }) => {
  const shown = rows.filter(([, v]) => has(v) && v !== false);
  if (!shown.length) return <p className="text-gray-400 text-xs">Nothing recorded.</p>;
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-[170px_1fr] gap-x-4 gap-y-1.5">
      {shown.map(([l, v]) => (
        <React.Fragment key={l}>
          <dt className="text-gray-500">{l}</dt>
          <dd className="font-semibold text-gray-900 break-words min-w-0">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
};

const Table = ({ head, rows, highlight }) => (
  <div className="overflow-x-auto -mx-1">
    <table className="w-full text-left text-[12px]">
      <thead>
        <tr className="text-gray-500 border-b border-gray-100">{head.map((h) => <th key={h} className="px-2 py-1.5 font-semibold whitespace-nowrap">{h}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r, i) => (
          <tr key={i} className={highlight?.(i) ? 'bg-green-50 font-semibold' : ''}>
            {r.map((c, j) => <td key={j} className="px-2 py-1.5 align-top">{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const Pill = ({ tone = 'gray', children }) => (
  <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap ${TONE[tone] || TONE.gray}`}>{children}</span>
);

const Photo = ({ url, label, at }) => (
  <div className="text-center">
    <a href={mediaUrl(url)} target="_blank" rel="noreferrer">
      <img src={mediaUrl(url)} alt={label} className="h-24 w-24 rounded-lg border border-gray-200 object-cover" />
    </a>
    {label && <p className="text-[11px] font-semibold text-gray-500 mt-1">{label}</p>}
    {at && <p className="text-[10px] text-gray-400">{fmtIST(at)}</p>}
  </div>
);

const PersonCard = ({ title, p, unassigned }) => (
  <Card title={title}>
    {!p ? (
      <p className="text-gray-400 italic">{unassigned}</p>
    ) : (
      <div className="flex gap-3">
        {p.profileImage ? <img src={mediaUrl(p.profileImage)} alt="" className="h-12 w-12 rounded-full object-cover border border-gray-200 shrink-0" /> : null}
        <div className="min-w-0 flex-1">
          <p className="font-bold text-gray-900 text-sm break-words">{p.name || 'Unnamed'}</p>
          {p.phone && <a href={`tel:${p.phone}`} className="inline-flex items-center gap-1 text-blue-600 font-semibold"><Phone size={12} />{p.phone}</a>}
          {p.email && <p className="text-gray-500 break-all">{p.email}</p>}
          {has(p.rating) && <p className="flex items-center gap-1 text-amber-600 font-semibold"><Star size={12} fill="currentColor" />{Number(p.rating).toFixed(1)}</p>}
          {p.vehicle && (
            <p className="mt-1 text-gray-700">
              {[p.vehicle.number, [p.vehicle.make, p.vehicle.model].filter(Boolean).join(' '), p.vehicle.color, p.vehicle.type].filter(Boolean).join(' - ')}
            </p>
          )}
          {p.fleetOwner && (
            <p className="mt-1 text-gray-500">Fleet owner: <span className="font-semibold text-gray-800">{p.fleetOwner.name}</span>
              {p.fleetOwner.phone && <> (<a href={`tel:${p.fleetOwner.phone}`} className="text-blue-600">{p.fleetOwner.phone}</a>)</>}
            </p>
          )}
        </div>
      </div>
    )}
  </Card>
);

const ADV = { applied: ['green', 'Paid'], refunded: ['blue', 'Refunded'], refund_failed: ['red', 'Refund failed'] };

// ---------- the modal ----------
const Body = ({ d }) => {
  const t = d.typeDetails || {};
  const r = d.route || {};
  const f = d.fare || {};
  const n = d.negotiation || {};
  const pay = d.payment || {};
  const st = d.settlement || {};
  const sn = d.snapshots || {};
  const pu = r.pickup?.point;
  const dr = r.drop?.point;
  const adv = pay.advance;
  const advBadge = adv ? ADV[adv.status] || ['gray', adv.status] : null;
  const kind = d.kind?.key;

  const typeRows = {
    outstation: [['From city', t.fromCity], ['To city', t.toCity], ['Trip type', t.tripType], ['Travel date', fmtIST(t.travelDate)], ['Return date', fmtIST(t.returnDate)], ['Passengers', t.passengers], ['Distance', has(t.distanceKm) ? `${t.distanceKm} km` : ''], ['Vehicle', t.vehicleName], ['Package', t.packageName]],
    rental: [['Package', t.packageName], ['Package price', has(t.packagePrice) ? inr(t.packagePrice) : ''], ['Included', [has(t.includedKm) ? `${t.includedKm} km` : '', has(t.includedMinutes) ? `${(t.includedMinutes / 60).toFixed(1)} hours` : ''].filter(Boolean).join(' / ')], ['Extra km rate', has(t.extraKmRate) ? `${inr(t.extraKmRate)} / km` : ''], ['Extra time rate', has(t.extraMinuteRate) ? `${inr(t.extraMinuteRate)} / min` : ''], ['Travelled', has(t.travelledKm) ? `${t.travelledKm} km` : ''], ['Time used', has(t.usedMinutes) ? `${t.usedMinutes} min` : ''], ['Extra km', has(t.extraKm) ? `${t.extraKm} km = ${inr(t.extraKmCharge)}` : ''], ['Extra time', has(t.extraMinutes) ? `${t.extraMinutes} min = ${inr(t.extraTimeCharge)}` : ''], ['Billed at', fmtIST(t.billedAt)]],
    parcel: [['Category', t.category], ['Weight', t.weight], ['Description', t.description], ['Scope', t.scope], ['Sender', [t.senderName, t.senderMobile].filter(Boolean).join(' - ')], ['Receiver', [t.receiverName, t.receiverMobile].filter(Boolean).join(' - ')], ['Instructions', t.instructions]],
    airport: [['Airport', t.airport], ['Airport fee', has(t.airportFee) ? inr(t.airportFee) : '']],
  }[kind];

  const fareRows = [
    ['Quoted fare', has(f.quoted) && inr(f.quoted)],
    f.surge && Number(f.surge.multiplier) > 1 && [`Surge (x${f.surge.multiplier}${f.surge.source ? `, ${f.surge.source}` : ''})`, ''],
    ...(f.tolls?.items || []).map((i) => [`Toll: ${i.name}${i.highway ? ` (${i.highway})` : ''}`, inr(i.amount)]),
    !f.tolls?.items?.length && Number(f.tolls?.total) > 0 && ['Tolls', inr(f.tolls.total)],
    Number(f.waitingCharge) > 0 && [`Waiting charge${f.waitingMinutes ? ` (${f.waitingMinutes} min)` : ''}`, inr(f.waitingCharge)],
    Number(f.platformFee) > 0 && ['Platform fee', inr(f.platformFee)],
    f.promo && [`Promo ${f.promo.code || ''}`, `- ${inr(f.promo.discount)}`],
    f.subscription && [`Subscription cover (${f.subscription.plan || 'plan'})`, `- ${inr(f.subscription.fareCovered)}`],
  ].filter((x) => x && x[1] !== false);

  const modeLabel = { none: 'Fixed fare, no negotiation', user_increment_only: 'Rider raised the fare', driver_bid: 'Drivers bid on the fare' }[n.mode] || n.mode;
  const offers = n.offers || [];
  const mapsUrl = pu && dr ? gmapsDir(pu, dr) : pu ? gmapsPt(pu) : '';
  const ld = r.lastDriverLocation;
  const ldPt = ld && (ld.lat !== undefined ? ld : ld.point);

  return (
    <div className="space-y-3">
      {/* 2 */}
      <div className="grid gap-3 md:grid-cols-2">
        <PersonCard title="Rider" p={d.user} unassigned="Rider not available" />
        <PersonCard title="Driver" p={d.driver} unassigned="Unassigned" />
      </div>

      {/* 3 */}
      <Card title="Route">
        <div className="space-y-2">
          <div><p className="text-[11px] font-bold text-green-600">PICKUP</p><p className="text-gray-900 font-semibold break-words">{r.pickup?.address || 'Not recorded'}</p></div>
          {(r.stops || []).map((s, i) => <div key={i}><p className="text-[11px] font-bold text-gray-500">STOP {i + 1}</p><p className="break-words">{s.address || s}</p></div>)}
          <div><p className="text-[11px] font-bold text-red-600">DROP</p><p className="text-gray-900 font-semibold break-words">{r.drop?.address || 'Not recorded'}</p></div>
          <Facts rows={[
            ['Estimated distance', has(r.estimatedDistanceKm) ? `${r.estimatedDistanceKm} km` : ''],
            ['Road distance', has(r.roadDistanceKm) ? `${r.roadDistanceKm} km` : ''],
            ['Estimated time', has(r.estimatedDurationMinutes) ? `${r.estimatedDurationMinutes} min` : ''],
          ]} />
          <div className="flex flex-wrap gap-2 pt-1">
            {mapsUrl && <a href={mapsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-black text-white text-xs font-bold"><MapPin size={13} />Open in Google Maps</a>}
            {ldPt && has(ldPt.lat) && <a href={gmapsPt(ldPt)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-gray-100 text-gray-800 text-xs font-bold"><Navigation size={13} />Driver last location</a>}
          </div>
        </div>
      </Card>

      {/* 4 */}
      {typeRows && (
        <Card title={`${d.kind?.label || 'Trip'} details`}>
          <Facts rows={typeRows} />
          {kind === 'parcel' && (
            <div className="mt-3 space-y-3">
              {t.photos?.length > 0 && <div><p className="text-[11px] font-bold text-gray-500 mb-1">Sender's parcel photos</p><div className="flex flex-wrap gap-3">{t.photos.map((u, i) => <Photo key={i} url={u} />)}</div></div>}
              {(t.pickupProof || t.deliveryProof) && (
                <div><p className="text-[11px] font-bold text-gray-500 mb-1">Handover proof</p>
                  <div className="flex flex-wrap gap-3">
                    {t.pickupProof?.url && <Photo url={t.pickupProof.url} label="Picked up" at={t.pickupProof.at} />}
                    {t.deliveryProof?.url && <Photo url={t.deliveryProof.url} label="Delivered" at={t.deliveryProof.at} />}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* 5 */}
      <Card title="Fare breakdown">
        <table className="w-full text-[13px]">
          <tbody className="divide-y divide-gray-50">
            {fareRows.map(([l, v], i) => <tr key={i}><td className="py-1.5 text-gray-600">{l}</td><td className="py-1.5 text-right font-semibold">{v}</td></tr>)}
            <tr className="border-t-2 border-gray-200"><td className="py-2 font-bold">Final fare</td><td className="py-2 text-right font-black text-base">{inr(f.final)}</td></tr>
            {Number(f.advancePaid) > 0 && (
              <>
                <tr><td className="py-1.5 text-gray-600">Advance paid (online)</td><td className="py-1.5 text-right font-semibold text-green-700">{inr(f.advancePaid)}</td></tr>
                <tr><td className="py-1.5 font-bold">Balance due after the ride</td><td className="py-1.5 text-right font-bold">{inr(f.amountDue)}</td></tr>
              </>
            )}
          </tbody>
        </table>
      </Card>

      {/* 6 */}
      <Card title="Negotiation and offers">
        <Facts rows={[
          ['Price set by', modeLabel],
          ['Drivers can counter', n.driverCounter ? (n.driverCounter.enabled ? `Yes${has(n.driverCounter.maxPercentage) ? `, up to ${n.driverCounter.maxPercentage}%` : ''}${has(n.driverCounter.step) ? `, in steps of ${inr(n.driverCounter.step)}` : ''}` : 'No') : ''],
          ['Rider ceiling', has(n.riderCeiling) ? inr(n.riderCeiling) : ''],
          ['Negotiation status', n.status],
        ]} />
        {offers.length > 0 ? (
          <div className="mt-3">
            <Table
              head={['Driver', 'Offered fare', 'Increase', 'Type', 'Status', 'Time']}
              highlight={(i) => offers[i].id && String(offers[i].id) === String(n.acceptedBidId)}
              rows={offers.map((o) => [
                <span key="d">{o.driver?.name || '-'}{o.driver?.phone ? <span className="block text-gray-400 font-normal">{o.driver.phone}</span> : null}</span>,
                inr(o.fare), has(o.increase) ? `+${inr(o.increase)}` : '', o.kind === 'counter' ? 'Counter' : 'Bid', o.status, fmtIST(o.at),
              ])}
            />
          </div>
        ) : <p className="mt-2 text-gray-400 text-xs">No driver offers.</p>}
      </Card>

      {/* 7 */}
      <Card title="Payment">
        <Facts rows={[
          ['Method', pay.methodLabel || pay.method],
          ['Collected', pay.collectedLabel],
          ['Paid', pay.paid === undefined ? '' : pay.paid ? 'Yes' : 'Not yet'],
          ['Provider', pay.collection?.provider],
          ['Record status', pay.collection?.status],
          ['Amount', has(pay.collection?.amount) ? inr(pay.collection.amount) : ''],
          ['Paid at', fmtIST(pay.collection?.paidAt)],
          ['Payment id', pay.collection?.providerPaymentId],
        ]} />
        {adv && (
          <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="flex items-center gap-2 text-[12px] font-bold mb-2">Advance <Pill tone={advBadge[0]}>{advBadge[1]}</Pill></p>
            <Facts rows={[
              ['Amount', inr(adv.amount)], ['Paid at', fmtIST(adv.paidAt)], ['Payment id', adv.paymentId],
              ['Refund id', adv.refundId], ['Refunded at', fmtIST(adv.refundedAt)], ['Refund error', adv.refundError],
              ['Refund attempts', adv.refundAttempts || ''],
            ]} />
          </div>
        )}
      </Card>

      {/* 8 */}
      <Card title="Settlement">
        <Facts rows={[
          ['Settled', st.settled === undefined ? '' : st.settled ? 'Yes' : 'Not yet'],
          ['Settled at', fmtIST(st.settledAt)],
          ['Commission', has(st.commission) ? inr(st.commission) : ''],
          ['Driver earnings', has(st.driverEarnings) ? inr(st.driverEarnings) : ''],
        ]} />
        {st.driverWallet?.length > 0 && (
          <div className="mt-3"><p className="text-[11px] font-bold text-gray-500 mb-1">Driver wallet</p>
            <Table head={['Type', 'Amount', 'Balance after', 'Note', 'Time']} rows={st.driverWallet.map((w) => [w.type, inr(w.amount), has(w.balanceAfter) ? inr(w.balanceAfter) : '', w.description, fmtIST(w.at)])} />
          </div>
        )}
        {st.ownerWallet?.length > 0 && (
          <div className="mt-3"><p className="text-[11px] font-bold text-gray-500 mb-1">Fleet owner wallet</p>
            <Table head={['Type', 'Amount', 'Balance', 'Note', 'Time']} rows={st.ownerWallet.map((w) => [w.kind || w.type, inr(w.amount), has(w.balance) ? inr(w.balance) : '', w.title, fmtIST(w.at)])} />
          </div>
        )}
      </Card>

      {/* 9 */}
      {(d.cancellation || d.feedback || d.messages?.length > 0) && (
        <Card title="Cancellation, feedback and chat">
          <div className="space-y-3">
            {d.cancellation && <Facts rows={[['Cancelled by', d.cancellation.by], ['Reason', d.cancellation.reason], ['Cancelled at', fmtIST(d.cancellation.at)]]} />}
            {d.feedback && (
              <div className="border-t border-gray-100 pt-2">
                <p className="text-[11px] font-bold text-gray-500 mb-1">Rider feedback</p>
                <p className="text-amber-500 text-base leading-none">{'★'.repeat(Math.round(d.feedback.rating || 0))}<span className="text-gray-300">{'★'.repeat(5 - Math.round(d.feedback.rating || 0))}</span></p>
                {d.feedback.comment && <p className="mt-1 text-gray-800">"{d.feedback.comment}"</p>}
                {Number(d.feedback.tip) > 0 && <p className="text-green-700 font-semibold">Tip {inr(d.feedback.tip)}</p>}
                {d.feedback.at && <p className="text-[11px] text-gray-400">{fmtIST(d.feedback.at)}</p>}
              </div>
            )}
            {d.messages?.length > 0 && (
              <div className="border-t border-gray-100 pt-2 space-y-1.5">
                <p className="text-[11px] font-bold text-gray-500">Chat</p>
                {d.messages.map((m, i) => (
                  <p key={i}><span className="font-bold capitalize">{m.from}</span>: {m.message}{m.imageUrl && <a href={mediaUrl(m.imageUrl)} target="_blank" rel="noreferrer" className="text-blue-600"> [image]</a>}
                    <span className="text-[10px] text-gray-400"> {fmtIST(m.at)}</span></p>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* 10 */}
      <Card title="History">
        {d.timeline?.length ? (
          <ol className="relative ml-2 border-l-2 border-gray-200 space-y-3">
            {d.timeline.map((e, i) => (
              <li key={i} className="pl-4 relative">
                <span className={`absolute -left-[7px] top-1 h-3 w-3 rounded-full ring-2 ring-white ${DOT[e.tone] || DOT.gray}`} />
                <p className="font-bold text-gray-900">{e.label}</p>
                {e.detail && <p className="text-gray-600 break-words">{e.detail}</p>}
                <p className="text-[11px] text-gray-400">{fmtIST(e.at)}</p>
              </li>
            ))}
          </ol>
        ) : <p className="text-gray-400 text-xs">No history recorded.</p>}
      </Card>

      {/* 11 */}
      <Card title="Snapshot at booking" collapsible>
        <p className="text-[11px] text-gray-400 mb-2">The numbers as they were when this request was booked.</p>
        <div className="space-y-3">
          {sn.pricing && (
            <Facts rows={[
              ['Driver commission', pct(sn.pricing.driverCommission)], ['Owner commission', pct(sn.pricing.ownerCommission)],
              ['Rider platform fee', has(sn.pricing.riderPlatformFee) ? inr(sn.pricing.riderPlatformFee) : ''],
              ['Pricing resolved at', fmtIST(sn.pricing.resolvedAt)],
            ]} />
          )}
          {sn.tariff && Object.keys(sn.tariff).length > 0 && (
            <div className="border-t border-gray-100 pt-2"><p className="text-[11px] font-bold text-gray-500 mb-1">Tariff used</p>
              <Facts rows={Object.entries(sn.tariff).filter(([, v]) => v === null || typeof v !== 'object').map(([k, v]) => [words(k), typeof v === 'number' && /price|fare|fee|rate|charge|amount/i.test(k) ? inr(v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v])} />
            </div>
          )}
          <div className="border-t border-gray-100 pt-2">
            <Facts rows={[
              ['Requested vehicle', [d.requestedVehicle?.name, has(d.requestedVehicle?.capacity) ? `(${d.requestedVehicle.capacity} seats)` : ''].filter(Boolean).join(' ')],
              ['Vehicle type', sn.vehicle?.type], ['Trip category', sn.tripCategory],
              ['Drivers notified', sn.dispatch?.notifiedDrivers?.length ?? sn.dispatch?.notifiedDrivers],
              ['Drivers declined', sn.dispatch?.declinedDrivers?.length ?? sn.dispatch?.declinedDrivers],
              ['Last dispatch attempt', fmtIST(sn.dispatch?.lastAttemptAt)],
            ]} />
          </div>
        </div>
      </Card>
    </div>
  );
};

const RideDetailsModal = ({ rideId, onClose }) => {
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const res = await adminService.getRideFullDetails(rideId);
      const data = res?.data?.data || res?.data || res;
      if (!data || !data.id) throw new Error('No details returned');
      setD(data);
    } catch (e) {
      setD(null);
      setErr(e?.response?.data?.message || e?.message || 'Could not load the request details');
    } finally { setLoading(false); }
  }, [rideId]);

  useEffect(() => { if (rideId) load(); }, [rideId, load]);
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  if (!rideId) return null;
  const copy = () => navigator.clipboard?.writeText(d.requestId).then(() => toast.success('Request ID copied'), () => {});

  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="h-full w-full md:max-w-3xl bg-gray-50 shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 bg-white border-b border-gray-100 px-4 py-3">
          {d ? (
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-base font-black text-gray-900 break-all">{d.requestId}</span>
                <button onClick={copy} className="p-1 text-gray-400 hover:text-gray-900" aria-label="Copy request id"><Copy size={14} /></button>
                <KindBadge big label={d.kind?.label} tone={d.kind?.tone} />
                <Pill tone={/cancel/i.test(d.status?.label) ? 'red' : /complet/i.test(d.status?.label) ? 'green' : 'blue'}>{d.status?.label}</Pill>
              </div>
              <p className="text-[12px] text-gray-500 mt-1">
                Booked {fmtIST(d.createdAt)}{d.bookingSource ? ` via ${d.bookingSource}` : ''}
                {d.scheduledAt ? <span className="font-semibold text-amber-700"> | Scheduled: {fmtIST(d.scheduledAt)}</span> : null}
              </p>
            </div>
          ) : <h2 className="text-base font-bold text-gray-900">Request Details</h2>}
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-full shrink-0" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-4">
          {loading ? (
            <div className="space-y-3 animate-pulse">
              {[1, 2, 3, 4].map((i) => <div key={i} className="h-28 rounded-xl bg-gray-200" />)}
              <p className="text-center text-xs text-gray-400 flex items-center justify-center gap-2"><Loader2 size={14} className="animate-spin" />Loading details...</p>
            </div>
          ) : err ? (
            <div className="text-center py-16">
              <p className="text-sm font-bold text-red-600">{err}</p>
              <button onClick={load} className="mt-3 inline-flex items-center gap-1 px-4 py-2 bg-black text-white text-xs font-bold rounded-lg"><RefreshCw size={13} />Retry</button>
            </div>
          ) : <Body d={d} />}
        </div>
      </div>
    </div>
  );
};

export default RideDetailsModal;

// ---------- list cells shared by Trips / Ongoing / Deliveries ----------
export const RequestCell = ({ row }) => (
  <div className="space-y-1">
    <span className="font-mono text-[13px] font-bold text-gray-900">{row.requestId || '-'}</span>
    <div className="flex items-center gap-1.5">
      <KindBadge label={row.kindLabel} tone={row.kindTone} />
      {row.vehicleName ? <span className="text-[10px] font-semibold text-gray-500">{row.vehicleName}</span> : null}
    </div>
  </div>
);

export const RouteCell = ({ row }) => {
  if (!row.pickupLabel && !row.dropLabel && !row.scheduledAt) return <span className="text-gray-300">-</span>;
  const full = `${row.pickupLabel || ''} -> ${row.dropLabel || ''}`;
  return (
    <div className="max-w-[220px] text-[11px] leading-snug" title={full}>
      {row.pickupLabel ? <p className="truncate"><span className="font-bold text-green-600">From </span>{row.pickupLabel}</p> : null}
      {row.dropLabel ? <p className="truncate"><span className="font-bold text-red-600">To </span>{row.dropLabel}</p> : null}
      {row.scheduledAt ? <p className="font-semibold text-amber-700">Scheduled: {fmtIST(row.scheduledAt)}</p> : null}
    </div>
  );
};

export const FareCell = ({ row }) => (
  <div className="space-y-1">
    {Number(row.fare) > 0 ? <p className="text-[13px] font-bold text-gray-900">{inr(row.fare)}</p> : <span className="text-gray-300">-</span>}
    <div className="flex flex-wrap gap-1">
      {Number(row.advancePaid) > 0 && <Pill tone={row.advanceStatus === 'refunded' ? 'blue' : row.advanceStatus === 'refund_failed' ? 'red' : 'green'}>Advance {inr(row.advancePaid)}</Pill>}
      {row.counterOffers && <Pill tone="purple">Offers on</Pill>}
    </div>
  </div>
);

export const StatusNote = ({ row }) => {
  const note = [row.statusLabel, row.cancelReason].filter(Boolean).join(': ');
  return note ? <p className="mt-0.5 max-w-[180px] truncate text-[10px] text-red-600" title={note}>{note}</p> : null;
};

export const KindChips = ({ value, onChange }) => (
  <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-100 px-4 py-2">
    <span className="text-[11px] font-bold text-gray-400 mr-1">Type</span>
    {KIND_CHIPS.map((c) => (
      <button key={c.label} onClick={() => onChange(c.value)}
        className={`px-3 py-1 rounded-full text-[11px] font-bold border transition-colors ${value === c.value ? 'bg-yellow-400 border-yellow-400 text-black' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
        {c.label}
      </button>
    ))}
  </div>
);
