import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, MapPin, Share2 } from 'lucide-react';
import DriverBottomNav from '../../shared/components/DriverBottomNav';
import { useAppGoogleMapsLoader } from '../../admin/utils/googleMaps';
import {
  cancelOwnerShareTrip,
  createOwnerShareTrip,
  getOwnerShareOverview,
  getOwnerShareRides,
  getOwnerShareTrips,
  setOwnerShareDriver,
} from '../services/registrationService';

const money = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const unwrap = (res) => res?.data?.data ?? res?.data ?? res;
const errMsg = (e, fallback) => e?.response?.data?.message || e?.message || fallback;
const RIDE_FILTERS = ['', 'active', 'completed', 'cancelled'];
const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const tone = (s) => (s === 'completed' ? 'bg-emerald-50 text-emerald-600' : s === 'cancelled' ? 'bg-rose-50 text-rose-600' : 'bg-amber-50 text-amber-600');

const Stat = ({ label, value, hot }) => (
  <div className={`rounded-2xl p-4 ${hot ? 'bg-gradient-to-br from-emerald-500 to-teal-500 text-white' : 'bg-white border border-slate-100'}`}>
    <p className={`text-[9px] font-black uppercase tracking-widest ${hot ? 'text-white/70' : 'text-slate-400'}`}>{label}</p>
    <p className="mt-1 text-xl font-black">{value}</p>
  </div>
);

const Section = ({ title, children }) => (
  <section className="space-y-3">
    <h2 className="text-[11px] font-black uppercase tracking-widest text-slate-500">{title}</h2>
    {children}
  </section>
);

// Address search -> lat/lng via Google Places; lat/lng stay editable as a fallback.
const PlacePicker = ({ label, value, onChange }) => {
  const { isLoaded } = useAppGoogleMapsLoader();
  const [options, setOptions] = useState([]);
  const timer = useRef(null);

  const search = (text) => {
    onChange({ ...value, address: text, lat: '', lng: '' });
    clearTimeout(timer.current);
    if (!isLoaded || !window.google?.maps?.places || text.trim().length < 3) { setOptions([]); return; }
    timer.current = setTimeout(() => {
      new window.google.maps.places.AutocompleteService().getPlacePredictions(
        { input: text, componentRestrictions: { country: 'in' } },
        (list) => setOptions(list || []),
      );
    }, 300);
  };

  const pick = (p) => {
    setOptions([]);
    new window.google.maps.places.PlacesService(document.createElement('div')).getDetails(
      { placeId: p.place_id, fields: ['geometry'] },
      (place) => {
        const loc = place?.geometry?.location;
        if (!loc) { toast.error('Could not read that place, try another'); return; }
        onChange({ address: p.description, lat: String(loc.lat()), lng: String(loc.lng()) });
      },
    );
  };

  return (
    <div className="space-y-1.5">
      <label className="text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</label>
      <input
        value={value.address}
        onChange={(e) => search(e.target.value)}
        placeholder="Search address"
        className="w-full rounded-xl bg-slate-50 px-3 py-2.5 text-[13px] font-bold text-slate-900 focus:outline-none"
      />
      {options.length ? (
        <div className="rounded-xl border border-slate-100 bg-white shadow-lg overflow-hidden">
          {options.slice(0, 5).map((o) => (
            <button key={o.place_id} type="button" onClick={() => pick(o)} className="flex w-full items-start gap-2 px-3 py-2 text-left text-[12px] font-semibold text-slate-700 hover:bg-slate-50">
              <MapPin size={13} className="mt-0.5 shrink-0 text-slate-400" /> {o.description}
            </button>
          ))}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <input value={value.lat} onChange={(e) => onChange({ ...value, lat: e.target.value })} placeholder="Latitude" inputMode="decimal" className="rounded-xl bg-slate-50 px-3 py-2 text-[12px] font-bold focus:outline-none" />
        <input value={value.lng} onChange={(e) => onChange({ ...value, lng: e.target.value })} placeholder="Longitude" inputMode="decimal" className="rounded-xl bg-slate-50 px-3 py-2 text-[12px] font-bold focus:outline-none" />
      </div>
    </div>
  );
};

const emptyPlace = { address: '', lat: '', lng: '' };
const toPlace = (p) => ({ address: p.address.trim(), lat: Number(p.lat), lng: Number(p.lng) });
const validPlace = (p) => p.address.trim() && p.lat !== '' && p.lng !== '' && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));

const OwnerShareRides = () => {
  const [overview, setOverview] = useState(null);
  const [trips, setTrips] = useState([]);
  const [rides, setRides] = useState({ results: [], paginator: { current_page: 1, last_page: 1, total: 0 } });
  const [rideStatus, setRideStatus] = useState('');
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ driverId: '', origin: emptyPlace, destination: emptyPlace, seatsTotal: '' });

  const loadTop = useCallback(async () => {
    try {
      const [o, t] = await Promise.all([getOwnerShareOverview(), getOwnerShareTrips('active')]);
      setOverview(unwrap(o));
      setTrips(unwrap(t) || []);
      setError('');
    } catch (e) {
      setError(errMsg(e, 'Unable to load Share Ride'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadRides = useCallback(async () => {
    try {
      const params = { page };
      if (rideStatus) params.status = rideStatus;
      setRides(unwrap(await getOwnerShareRides(params)));
    } catch (e) {
      toast.error(errMsg(e, 'Unable to load rides'));
    }
  }, [page, rideStatus]);

  useEffect(() => { loadTop(); }, [loadTop]);
  useEffect(() => { loadRides(); }, [loadRides]);

  const toggleDriver = async (driver) => {
    const next = !driver.shareEnabled;
    const patch = (v) => setOverview((o) => ({ ...o, drivers: o.drivers.map((d) => (d.id === driver.id ? { ...d, shareEnabled: v } : d)) }));
    patch(next);
    try {
      await setOwnerShareDriver(driver.id, next);
    } catch (e) {
      patch(!next);
      toast.error(errMsg(e, 'Could not update driver'));
    }
  };

  const createTrip = async (e) => {
    e.preventDefault();
    if (!form.driverId) return toast.error('Choose a driver');
    if (!validPlace(form.origin) || !validPlace(form.destination)) return toast.error('Pick origin and destination from the search list');
    setBusy(true);
    try {
      const payload = { driverId: form.driverId, origin: toPlace(form.origin), destination: toPlace(form.destination) };
      if (form.seatsTotal) payload.seatsTotal = Number(form.seatsTotal);
      await createOwnerShareTrip(payload);
      toast.success('Trip created');
      setForm({ driverId: '', origin: emptyPlace, destination: emptyPlace, seatsTotal: '' });
      loadTop();
    } catch (err) {
      toast.error(errMsg(err, 'Could not create trip'));
    } finally {
      setBusy(false);
    }
  };

  const cancelTrip = async (trip) => {
    if (!window.confirm('Cancel this trip?')) return;
    try {
      await cancelOwnerShareTrip(trip.id);
      toast.success('Trip cancelled');
      loadTop();
    } catch (err) {
      toast.error(errMsg(err, 'Could not cancel trip'));
    }
  };

  const totals = overview?.totals || {};
  const drivers = overview?.drivers || [];
  const carDrivers = drivers.filter((d) => d.vehicleType === 'car');
  const pg = rides.paginator || {};

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <div className="mx-auto max-w-lg space-y-6 p-4">
        <header className="flex items-center gap-3 pt-2">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-slate-900 text-white"><Share2 size={20} /></div>
          <div>
            <h1 className="text-lg font-black text-slate-900">Share Ride</h1>
            <p className="text-[11px] font-bold text-slate-400">Your fleet's car pooling</p>
          </div>
        </header>

        {error ? <div className="rounded-xl bg-rose-50 p-3 text-xs font-bold text-rose-600">{error}</div> : null}
        {isLoading ? <div className="flex justify-center py-10"><Loader2 className="animate-spin text-slate-400" /></div> : null}

        {overview ? (
          <>
            <Section title="Overview">
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Your earnings" value={money(totals.ownerEarnings)} hot />
                <Stat label="Rides completed" value={totals.rides || 0} />
                <Stat label="Gross" value={money(totals.gross)} />
                <Stat label="Platform fee" value={money(totals.platformFee)} />
                <Stat label="Active trips" value={overview.activeTrips || 0} />
                <Stat label="Riders on board" value={overview.ridersOnBoard || 0} />
              </div>
            </Section>

            <Section title="Fleet drivers">
              <div className="space-y-2">
                {drivers.length === 0 ? <p className="text-xs font-bold text-slate-400">No drivers in your fleet yet.</p> : null}
                {drivers.map((d) => (
                  <div key={d.id} className="rounded-2xl border border-slate-100 bg-white p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 truncate text-[13px] font-black text-slate-900">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${d.isOnline ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                          {d.name}
                        </p>
                        <p className="text-[11px] font-bold text-slate-400">{d.vehicleNumber || 'No vehicle'}</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={d.shareEnabled}
                        aria-label={`Share rides for ${d.name}`}
                        onClick={() => toggleDriver(d)}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${d.shareEnabled ? 'bg-emerald-500' : 'bg-slate-300'}`}
                      >
                        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${d.shareEnabled ? 'left-[22px]' : 'left-0.5'}`} />
                      </button>
                    </div>
                    <p className="mt-2 text-[11px] font-bold text-slate-500">
                      {d.rides} rides · gross {money(d.gross)} · earnings {money(d.earnings)}
                    </p>
                    {d.vehicleType !== 'car' ? <p className="mt-1 text-[11px] font-bold text-amber-600">Only car drivers can take share rides.</p> : null}
                  </div>
                ))}
              </div>
            </Section>

            <Section title="Create a trip for a driver">
              <form onSubmit={createTrip} className="space-y-3 rounded-2xl border border-slate-100 bg-white p-4">
                <p className="text-[11px] font-bold text-slate-500">Riders on that route are then offered to this driver automatically.</p>
                <select value={form.driverId} onChange={(e) => setForm({ ...form, driverId: e.target.value })} className="w-full rounded-xl bg-slate-50 px-3 py-2.5 text-[13px] font-bold text-slate-900 focus:outline-none">
                  <option value="">Choose a car driver</option>
                  {carDrivers.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.vehicleNumber || 'no vehicle'}</option>)}
                </select>
                <PlacePicker label="Origin" value={form.origin} onChange={(origin) => setForm((f) => ({ ...f, origin }))} />
                <PlacePicker label="Destination" value={form.destination} onChange={(destination) => setForm((f) => ({ ...f, destination }))} />
                <input type="number" min="1" max="8" value={form.seatsTotal} onChange={(e) => setForm({ ...form, seatsTotal: e.target.value })} placeholder="Seats (optional)" className="w-full rounded-xl bg-slate-50 px-3 py-2.5 text-[13px] font-bold focus:outline-none" />
                <button type="submit" disabled={busy} className="w-full rounded-xl bg-slate-900 py-3 text-[12px] font-black uppercase tracking-widest text-white disabled:opacity-50">
                  {busy ? 'Creating...' : 'Create trip'}
                </button>
              </form>
            </Section>

            <Section title="Active trips">
              {trips.length === 0 ? <p className="text-xs font-bold text-slate-400">No active trips.</p> : null}
              {trips.map((t) => (
                <div key={t.id} className="rounded-2xl border border-slate-100 bg-white p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[13px] font-black text-slate-900">{t.driver?.name || 'Driver'} · {t.vehicle?.number || ''}</p>
                      <p className="mt-1 text-[11px] font-bold text-slate-500">{t.origin?.address} → {t.destination?.address}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black capitalize ${tone(t.status)}`}>{t.status}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <p className="text-[11px] font-bold text-slate-500">Seats {t.seatsTaken}/{t.seatsTotal}</p>
                    <button type="button" onClick={() => cancelTrip(t)} className="rounded-lg bg-rose-50 px-3 py-1.5 text-[11px] font-black text-rose-600">Cancel</button>
                  </div>
                </div>
              ))}
            </Section>
          </>
        ) : null}

        <Section title="Rides">
          <div className="flex gap-1.5">
            {RIDE_FILTERS.map((s) => (
              <button key={s} type="button" onClick={() => { setRideStatus(s); setPage(1); }} className={`rounded-lg px-3 py-1.5 text-[11px] font-black capitalize ${rideStatus === s ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 border border-slate-100'}`}>
                {s || 'All'}
              </button>
            ))}
          </div>
          {(rides.results || []).length === 0 ? <p className="text-xs font-bold text-slate-400">No rides found.</p> : null}
          {(rides.results || []).map((r) => (
            <div key={r.id} className="rounded-2xl border border-slate-100 bg-white p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-black text-slate-900">{r.passenger?.name || 'Rider'} · {r.seats} seat{r.seats === 1 ? '' : 's'}</p>
                  <p className="text-[11px] font-bold text-slate-400">Driver {r.driver?.name || '-'} · {when(r.createdAt)}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black capitalize ${tone(r.status)}`}>{r.status}</span>
              </div>
              <p className="mt-1 text-[11px] font-bold text-slate-500">{r.pickup?.address} → {r.drop?.address}</p>
              <p className="mt-1 text-[12px] font-black text-slate-900">Fare {money(r.fare)}</p>
              {r.status === 'completed' ? (
                <p className="mt-1 text-[11px] font-bold text-slate-500">
                  Platform fee {money(r.settlement?.platformFee)} · {Number(r.settlement?.commissionWaived) > 0 ? `commission waived (${money(r.settlement.commissionWaived)})` : `commission ${money(r.settlement?.commission)}`} · earning {money(r.settlement?.driverEarnings)}
                </p>
              ) : null}
            </div>
          ))}
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-bold text-slate-400">Page {pg.current_page || 1} of {pg.last_page || 1}</p>
            <div className="flex gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-black text-slate-600 disabled:opacity-40">Previous</button>
              <button type="button" disabled={page >= (pg.last_page || 1)} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-black text-slate-600 disabled:opacity-40">Next</button>
            </div>
          </div>
        </Section>
      </div>
      <DriverBottomNav />
    </div>
  );
};

export default OwnerShareRides;
