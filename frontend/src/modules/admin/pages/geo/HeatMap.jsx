import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Circle, GoogleMap } from '@react-google-maps/api';
import {
  ChevronRight,
  Map as MapIcon,
  RefreshCw,
  Settings2,
  ArrowLeft,
  Activity,
  Zap,
  Navigation,
  MapPinOff,
  AlertTriangle,
  Clock,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useBaseGoogleMapsLoader, HAS_VALID_GOOGLE_MAPS_KEY } from '../../utils/googleMaps';
import { adminService } from '../../services/adminService';

const INDIA_CENTER = { lat: 22.7196, lng: 75.8577 };
const MAP_CONTAINER_STYLE = { width: '100%', height: '100%' };
const CELL_DEGREES = 0.004; // ~450 m grid; demand inside a cell is summed into one circle
const TIERS = ['#facc15', '#fb923c', '#ef4444', '#b91c1c'];

const mapOptions = {
  zoomControl: true,
  streetViewControl: false,
  mapTypeControl: false,
  fullscreenControl: true,
  styles: [
    { elementType: 'geometry', stylers: [{ color: '#f9fafb' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#6b7280' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#e5e7eb' }] },
  ],
};

const LAYERS = [
  { value: 'requests', label: 'Ride requests (demand)' },
  { value: 'trips', label: 'Trips (started + completed)' },
  { value: 'completed', label: 'Completed trips' },
  { value: 'cancelled', label: 'Cancelled requests' },
  { value: 'drivers', label: 'Drivers online now' },
  { value: 'sos', label: 'SOS / safety alerts' },
];
const KINDS = [
  ['', 'All kinds'], ['city', 'City'], ['airport', 'Airport'], ['outstation', 'Outstation'], ['rental', 'Hourly rental'], ['parcel', 'Parcel'],
];
const STATUSES = [
  ['', 'Any status'], ['searching', 'Searching'], ['accepted', 'Accepted'], ['ongoing', 'Ongoing'], ['completed', 'Completed'], ['cancelled', 'Cancelled'],
];
const RANGES = [['1', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time'], ['custom', 'Custom']];

const ymd = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const asList = (res) => {
  const d = res?.data;
  return Array.isArray(d) ? d : Array.isArray(d?.results) ? d.results : [];
};
const errorText = (e) => e?.response?.data?.message || e?.message || 'Request failed';

const HeatMap = () => {
  const navigate = useNavigate();
  const mapRef = useRef(null);
  const [mapInstance, setMapInstance] = useState(null);
  const { isLoaded, loadError } = useBaseGoogleMapsLoader();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastSync, setLastSync] = useState(null);

  const [layer, setLayer] = useState('requests');
  const [range, setRange] = useState('7');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [vehicleType, setVehicleType] = useState('');
  const [zone, setZone] = useState('');
  const [opacity, setOpacity] = useState(0.7);
  const [zones, setZones] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);

  const inputClass = 'w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs text-gray-800 bg-white focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 outline-none transition-colors';
  const labelClass = 'block text-[11px] font-bold text-gray-500 mb-1';

  useEffect(() => {
    adminService.getZones().then((r) => setZones(asList(r))).catch(() => setZones([]));
    adminService.getVehicleTypes().then((r) => setVehicleTypes(asList(r))).catch(() => setVehicleTypes([]));
  }, []);

  const params = useMemo(() => {
    const p = { layer, tz_offset_min: -new Date().getTimezoneOffset() };
    const now = new Date();
    if (range === 'custom') {
      if (customFrom) p.from = customFrom;
      if (customTo) p.to = customTo;
    } else if (range !== 'all') {
      const from = new Date(now);
      from.setDate(from.getDate() - (Number(range) - 1));
      p.from = ymd(from);
    }
    if (kind) p.kind = kind;
    if (status && layer === 'requests') p.status = status;
    if (vehicleType) p.vehicle_type_id = vehicleType;
    if (zone) p.zone_id = zone;
    return p;
  }, [layer, range, customFrom, customTo, kind, status, vehicleType, zone]);

  const seq = useRef(0);
  const fetchData = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    try {
      const res = await adminService.getGeoHeatmapPoints(params);
      if (mine !== seq.current) return;
      setData(res?.data ?? null);
      setLastSync(new Date());
    } catch (e) {
      if (mine !== seq.current) return;
      setError(errorText(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const bins = useMemo(() => {
    const cells = new Map();
    (data?.points || []).forEach((p) => {
      const key = `${Math.round(p.lat / CELL_DEGREES)}:${Math.round(p.lng / CELL_DEGREES)}`;
      const c = cells.get(key) || { id: key, lat: 0, lng: 0, count: 0 };
      c.lat += p.lat * (p.weight || 1);
      c.lng += p.lng * (p.weight || 1);
      c.count += p.weight || 1;
      cells.set(key, c);
    });
    const list = [...cells.values()].map((c) => ({ id: c.id, center: { lat: c.lat / c.count, lng: c.lng / c.count }, count: c.count }));
    const max = list.reduce((m, c) => Math.max(m, c.count), 1);
    return list.map((c) => ({ ...c, ratio: c.count / max }));
  }, [data]);

  // Fit the map to the data whenever a new result arrives.
  useEffect(() => {
    const map = mapInstance;
    if (!map || !window.google || bins.length === 0) return;
    const bounds = new window.google.maps.LatLngBounds();
    bins.forEach((b) => bounds.extend(b.center));
    map.fitBounds(bounds, 40);
    if (bins.length === 1) map.setZoom(14);
  }, [bins, mapInstance]);

  const hours = data?.byHour || Array(24).fill(0);
  const maxHour = Math.max(1, ...hours);
  const peakHour = hours.indexOf(Math.max(...hours));
  const mapReady = HAS_VALID_GOOGLE_MAPS_KEY && isLoaded && !loadError;
  const panTo = (a) => {
    if (mapRef.current && Number.isFinite(a.lat)) {
      mapRef.current.panTo({ lat: a.lat, lng: a.lng });
      mapRef.current.setZoom(15);
    }
  };
  const layerLabel = LAYERS.find((l) => l.value === layer)?.label || '';

  return (
    <div className="min-h-screen bg-slate-50/50 p-3 lg:p-4 mx-auto w-full max-w-[1600px] font-sans overflow-x-hidden">
      <div className="mb-2 flex flex-col md:flex-row md:items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 mb-1">
            <span>Geofencing</span>
            <ChevronRight size={14} className="text-slate-300" />
            <span className="text-slate-600">Heat Map</span>
          </div>
          <h1 className="text-base text-slate-900 font-bold">Demand Heat Map</h1>
          <p className="text-[11px] text-slate-500">Where riders ask for rides, so you know where to place drivers and apply surge.</p>
        </div>
        <button
          onClick={() => navigate('/admin/dashboard')}
          className="inline-flex w-fit items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-bold text-slate-600 shadow-sm border border-slate-200 transition hover:bg-slate-50"
        >
          <ArrowLeft size={16} /> Back to Dashboard
        </button>
      </div>

      {error && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle size={16} /> <span className="font-semibold">Could not load heat map data: {error}</span>
          <button onClick={fetchData} className="ml-auto rounded-md bg-white px-3 py-1 font-bold border border-red-200">Retry</button>
        </div>
      )}
      {data?.truncated && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Showing the most recent 20,000 points of {data.total}. Narrow the date range for a complete picture.
        </div>
      )}

      <div className="space-y-3">
        {/* Filters */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-100 flex items-center gap-2 bg-slate-50/50">
            <div className="w-8 h-8 bg-white border border-slate-200 rounded-lg flex items-center justify-center text-slate-600"><Settings2 size={16} /></div>
            <div>
              <h3 className="text-xs font-black text-slate-900">Layer & filters</h3>
              <p className="text-[10px] text-slate-500 font-medium">Updates automatically when you change a value</p>
            </div>
          </div>
          <div className="p-2 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
            <div className="col-span-2 md:col-span-2">
              <label className={labelClass}>Layer</label>
              <select value={layer} onChange={(e) => setLayer(e.target.value)} className={inputClass}>
                {LAYERS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass}>Period</label>
              <select value={range} onChange={(e) => setRange(e.target.value)} className={inputClass} disabled={layer === 'drivers'}>
                {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            {range === 'custom' && layer !== 'drivers' && (
              <>
                <div><label className={labelClass}>From</label><input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className={inputClass} /></div>
                <div><label className={labelClass}>To</label><input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className={inputClass} /></div>
              </>
            )}
            <div>
              <label className={labelClass}>Ride kind</label>
              <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass} disabled={layer === 'drivers' || layer === 'sos'}>
                {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass}>Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass} disabled={layer !== 'requests'}>
                {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass}>Vehicle</label>
              <select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} className={inputClass} disabled={layer === 'sos'}>
                <option value="">All vehicles</option>
                {vehicleTypes.map((vt) => <option key={vt._id} value={vt._id}>{vt.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass}>Zone / city</label>
              <select value={zone} onChange={(e) => setZone(e.target.value)} className={inputClass} disabled={layer === 'sos'}>
                <option value="">All zones</option>
                {zones.map((z) => <option key={z._id} value={z._id}>{z.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass}>Opacity {Math.round(opacity * 100)}%</label>
              <input type="range" min="0.2" max="1" step="0.05" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="w-full accent-slate-800" />
            </div>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            [Navigation, 'Hotspots', `${bins.length}`],
            [Activity, layerLabel.split(' (')[0], `${data?.total ?? 0}`],
            [Clock, 'Peak hour', data && data.mapped > 0 ? `${String(peakHour).padStart(2, '0')}:00` : '-'],
            [Zap, 'Sync', loading ? 'Syncing...' : lastSync ? lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Pending'],
          ].map(([Icon, title, value]) => (
            <div key={title} className="bg-white rounded-lg border border-slate-200 p-3 flex items-center gap-3 shadow-sm min-w-0">
              <div className="w-8 h-8 bg-slate-50 flex items-center justify-center rounded-md text-slate-400 flex-shrink-0"><Icon size={16} className={title === 'Sync' && loading ? 'text-yellow-500 animate-pulse' : ''} /></div>
              <div className="min-w-0">
                <p className="text-[9px] font-bold text-slate-400 tracking-wider mb-0.5 truncate">{title}</p>
                <p className="text-base font-black text-slate-900 leading-none truncate">{value}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Map */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-1.5 shadow-sm">
            <div className="rounded-xl overflow-hidden relative h-[380px] lg:h-[520px]">
              {mapReady ? (
                <GoogleMap
                  mapContainerStyle={MAP_CONTAINER_STYLE}
                  center={INDIA_CENTER}
                  zoom={11}
                  options={mapOptions}
                  onLoad={(m) => { mapRef.current = m; setMapInstance(m); }}
                  onUnmount={() => { mapRef.current = null; setMapInstance(null); }}
                >
                  {bins.map((b) => {
                    const tier = TIERS[Math.min(TIERS.length - 1, Math.floor(b.ratio * TIERS.length))];
                    return (
                      <Circle
                        key={b.id}
                        center={b.center}
                        radius={180 + 320 * Math.sqrt(b.ratio)}
                        options={{ fillColor: tier, fillOpacity: opacity * (0.35 + 0.5 * b.ratio), strokeColor: tier, strokeOpacity: 0.5, strokeWeight: 1, clickable: false }}
                      />
                    );
                  })}
                </GoogleMap>
              ) : (
                <div className="h-full flex flex-col items-center justify-center bg-slate-50 gap-2 px-4 text-center">
                  <div className="w-14 h-14 bg-white rounded-2xl flex items-center justify-center shadow-sm text-yellow-500"><MapIcon size={28} /></div>
                  <p className="text-[11px] font-black text-slate-500 tracking-wider">
                    {loadError ? 'GOOGLE MAPS FAILED TO LOAD' : !HAS_VALID_GOOGLE_MAPS_KEY ? 'GOOGLE MAPS KEY NOT CONFIGURED' : 'LOADING MAP...'}
                  </p>
                  <p className="text-[11px] text-slate-400">The area ranking on the right still works.</p>
                </div>
              )}
              {loading && (
                <div className="absolute top-3 left-3 flex items-center gap-2 rounded-lg bg-white/95 px-3 py-1.5 text-xs font-bold text-slate-600 shadow border border-slate-200">
                  <RefreshCw size={14} className="animate-spin text-yellow-500" /> Loading...
                </div>
              )}
              {!loading && !error && data && bins.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/60 pointer-events-none px-4">
                  <div className="bg-white px-6 py-4 rounded-2xl shadow-lg border border-slate-100 flex flex-col items-center text-center max-w-sm">
                    <MapPinOff size={24} className="text-slate-400 mb-2" />
                    <h3 className="text-base font-bold text-slate-900 mb-1">No activity found</h3>
                    <p className="text-xs text-slate-500">
                      Nothing matches these filters{data.total > 0 ? ` (${data.total} rows have no usable location)` : ''}. Try a longer period.
                    </p>
                  </div>
                </div>
              )}
              <button onClick={fetchData} disabled={loading} aria-label="Refresh" className="absolute top-3 right-14 w-9 h-9 bg-white rounded-lg shadow flex items-center justify-center text-slate-600 border border-slate-200 disabled:opacity-50">
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              </button>
              <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-lg bg-white/95 px-2 py-1 text-[10px] font-bold text-slate-600 shadow border border-slate-200">
                Low {TIERS.map((c) => <span key={c} className="inline-block w-4 h-2 rounded-sm" style={{ background: c }} />)} High
              </div>
            </div>
          </div>

          {/* Side panel */}
          <div className="space-y-3 min-w-0">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3">
              <h3 className="text-xs font-black text-slate-900 mb-2">Top areas</h3>
              {(data?.byArea || []).length === 0 ? (
                <p className="text-xs text-slate-400">{loading ? 'Loading...' : 'No areas to rank.'}</p>
              ) : (
                <ol className="space-y-1">
                  {data.byArea.map((a, i) => (
                    <li key={`${a.lat}:${a.lng}`}>
                      <button onClick={() => panTo(a)} className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-50">
                        <span className="w-5 text-[10px] font-black text-slate-400">{i + 1}</span>
                        <span className="flex-1 min-w-0 truncate text-xs font-semibold text-slate-700">{a.label}</span>
                        <span className="text-xs font-black text-slate-900">{a.count}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3">
              <h3 className="text-xs font-black text-slate-900 mb-2">Requests by hour of day</h3>
              <div className="flex items-end gap-[3px] h-24">
                {hours.map((n, h) => (
                  <div key={h} className="flex-1 flex flex-col justify-end h-full" title={`${String(h).padStart(2, '0')}:00 - ${n}`}>
                    <div className={`${h === peakHour && n > 0 ? 'bg-red-500' : 'bg-yellow-400'} rounded-t-sm`} style={{ height: `${(n / maxHour) * 100}%`, minHeight: n > 0 ? 2 : 0 }} />
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-[9px] font-bold text-slate-400 mt-1"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HeatMap;
