import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { GoogleMap, MarkerF, PolylineF, TrafficLayer } from '@react-google-maps/api';
import {
  Search, Car, AlertTriangle, Clock, Map as MapIcon, X, Maximize, Minimize, Navigation,
  ArrowLeft, RefreshCw, Phone, ShieldAlert, Users, Activity, Radio, Layers,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useBaseGoogleMapsLoader, HAS_VALID_GOOGLE_MAPS_KEY } from '../../utils/googleMaps';
import { adminService } from '../../services/adminService';

const INDIA_CENTER = { lat: 22.7196, lng: 75.8577 };
const REFRESH_MS = 6000;

const mapOptions = {
  disableDefaultUI: true,
  zoomControl: true,
  streetViewControl: false,
  mapTypeControl: false,
  fullscreenControl: false,
  styles: [
    { elementType: 'geometry', stylers: [{ color: '#f5f5f5' }] },
    { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#616161' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#dadada' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#c9c9c9' }] },
  ],
};

const hasPoint = (p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)) && p.lat !== null && p.lng !== null;
const ago = (value) => {
  if (!value) return 'unknown';
  const s = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};
const money = (n) => `Rs ${Number(n || 0).toLocaleString('en-IN')}`;
const statusWords = (r) => {
  if (r.status === 'searching') return r.scheduled ? 'Scheduled' : 'Searching for driver';
  if (r.status === 'ongoing' || r.liveStatus === 'started') return 'Trip started';
  if (r.liveStatus === 'arrived') return 'Driver arrived';
  if (r.liveStatus === 'arriving') return 'Driver on the way';
  return 'Driver assigned';
};

const btnClass = 'flex items-center justify-center gap-2 px-3 py-2 text-xs font-bold rounded-lg transition-colors border shadow-sm';
const btnPrimary = `${btnClass} bg-yellow-400 text-black border-yellow-500 hover:bg-yellow-500`;
const btnSecondary = `${btnClass} bg-white text-slate-800 border-slate-200 hover:bg-slate-50`;
const selectClass = 'w-full bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-black outline-none focus:border-yellow-400';

const driverIcon = (d, selected) => {
  const g = window.google.maps;
  const color = d.isOnRide ? '#ca8a04' : '#16a34a';
  const base = { fillColor: color, fillOpacity: 1, strokeColor: selected ? '#0f172a' : '#ffffff', strokeWeight: selected ? 3 : 1.5 };
  return d.heading === null
    ? { ...base, path: g.SymbolPath.CIRCLE, scale: 8 }
    : { ...base, path: g.SymbolPath.FORWARD_CLOSED_ARROW, scale: 6, rotation: d.heading };
};
const pinIcon = (color, scale = 7) => ({
  path: window.google.maps.SymbolPath.CIRCLE, fillColor: color, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2, scale,
});

const GodsEye = () => {
  const navigate = useNavigate();
  const { isLoaded, loadError } = useBaseGoogleMapsLoader();
  const [map, setMap] = useState(null);
  const fittedRef = useRef(false);

  const [live, setLive] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [lastSync, setLastSync] = useState(null);
  const [paused, setPaused] = useState(false);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [vehicleFilter, setVehicleFilter] = useState('all');
  const [layers, setLayers] = useState({ drivers: true, rides: true, alerts: true, traffic: false });
  const [tab, setTab] = useState('drivers');
  const [selected, setSelected] = useState(null); // { type, id }
  const [fullscreen, setFullscreen] = useState(false);
  const [route, setRoute] = useState(null); // { id, path }

  const seq = useRef(0);
  const fetchLive = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await adminService.getGeoLive();
      if (mine !== seq.current) return;
      setLive(res?.data ?? null);
      setError('');
      setLastSync(new Date());
    } catch (e) {
      if (mine !== seq.current) return;
      // keep showing the last good snapshot, but say it is stale
      setError(e?.response?.data?.message || e?.message || 'Request failed');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  // Poll every few seconds; stop while the tab is hidden or the admin pauses.
  useEffect(() => {
    if (paused) return undefined;
    let timer;
    let stopped = false;
    const tick = async () => {
      if (!document.hidden) await fetchLive();
      if (!stopped) timer = setTimeout(tick, REFRESH_MS);
    };
    const onVisible = () => { if (!document.hidden) { clearTimeout(timer); tick(); } };
    tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [paused, fetchLive]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  };

  const drivers = live?.drivers || [];
  const rides = live?.rides || [];
  const alerts = live?.alerts || [];
  const counts = live?.counts || {};
  const driverById = useMemo(() => new Map(drivers.map((d) => [d.id, d])), [drivers]);
  const rideById = useMemo(() => new Map(rides.map((r) => [r.id, r])), [rides]);

  const q = search.trim().toLowerCase();
  const filteredDrivers = useMemo(() => drivers.filter((d) => {
    if (statusFilter === 'idle' && d.isOnRide) return false;
    if (statusFilter === 'busy' && !d.isOnRide) return false;
    if (vehicleFilter !== 'all' && !String(d.vehicle?.type || '').toLowerCase().includes(vehicleFilter)) return false;
    if (!q) return true;
    return [d.name, d.phone, d.vehicle?.number, d.vehicle?.label].some((v) => String(v || '').toLowerCase().includes(q));
  }), [drivers, statusFilter, vehicleFilter, q]);
  const filteredRides = useMemo(() => rides.filter((r) => {
    if (!q) return true;
    const driver = driverById.get(r.driverId);
    return [r.id, r.rider?.name, r.rider?.phone, r.pickup?.address, r.drop?.address, driver?.name, driver?.phone]
      .some((v) => String(v || '').toLowerCase().includes(q));
  }), [rides, q, driverById]);

  const sel = useMemo(() => {
    if (!selected) return null;
    const map_ = selected.type === 'driver' ? driverById : selected.type === 'ride' ? rideById : new Map(alerts.map((a) => [a.id, a]));
    const item = map_.get(selected.id);
    return item ? { type: selected.type, item } : null;
  }, [selected, driverById, rideById, alerts]);

  const selectedRide = sel?.type === 'ride' ? sel.item : sel?.type === 'driver' ? rideById.get(sel.item.rideId) : null;
  const rideKey = selectedRide && hasPoint(selectedRide.pickup) && hasPoint(selectedRide.drop) ? selectedRide.id : null;

  // Road route of the selected active ride (falls back to a straight line if Directions is unavailable).
  useEffect(() => {
    setRoute(null);
    if (!rideKey || !isLoaded || !window.google) return undefined;
    const ride = rideById.get(rideKey);
    const straight = [ride.pickup, ride.drop].map((p) => ({ lat: p.lat, lng: p.lng }));
    let cancelled = false;
    new window.google.maps.DirectionsService().route(
      { origin: straight[0], destination: straight[1], travelMode: 'DRIVING' },
      (result, status) => {
        if (cancelled) return;
        setRoute({ id: rideKey, path: status === 'OK' ? result.routes[0].overview_path : straight });
      },
    );
    return () => { cancelled = true; };
    // rideById intentionally omitted: the route only depends on which ride is selected
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rideKey, isLoaded]);

  const focus = useCallback((point) => {
    if (map && hasPoint(point)) { map.panTo({ lat: point.lat, lng: point.lng }); if (map.getZoom() < 14) map.setZoom(14); }
  }, [map]);
  const pick = (type, item, point) => { setSelected({ type, id: item.id }); focus(point || item); };

  const fitAll = useCallback(() => {
    if (!map || !window.google) return;
    const pts = [...filteredDrivers, ...alerts, ...filteredRides.map((r) => r.pickup)].filter(hasPoint);
    if (!pts.length) return;
    const b = new window.google.maps.LatLngBounds();
    pts.forEach((p) => b.extend({ lat: p.lat, lng: p.lng }));
    map.fitBounds(b, 60);
  }, [map, filteredDrivers, filteredRides, alerts]);
  useEffect(() => {
    if (map && live && !fittedRef.current) { fittedRef.current = true; fitAll(); }
  }, [map, live, fitAll]);

  const mapReady = HAS_VALID_GOOGLE_MAPS_KEY && isLoaded && !loadError;
  const tabBtn = (id, label, n) => (
    <button key={id} onClick={() => setTab(id)} className={`flex-1 px-2 py-2 text-[11px] font-bold border-b-2 ${tab === id ? 'border-yellow-400 text-black' : 'border-transparent text-gray-500'}`}>
      {label} <span className="text-gray-400">({n})</span>
    </button>
  );
  const kpi = (label, value, tone = 'text-black') => (
    <div className="flex flex-col items-end" key={label}>
      <span className="text-[9px] font-bold text-gray-500 uppercase whitespace-nowrap">{label}</span>
      <span className={`text-xs font-black ${tone}`}>{value ?? 0}</span>
    </div>
  );
  const row = (k, v) => v ? (
    <div className="flex justify-between gap-3 text-xs"><span className="text-gray-500">{k}</span><span className="font-bold text-black text-right break-words min-w-0">{v}</span></div>
  ) : null;

  return (
    <div className={`flex flex-col min-h-screen lg:h-screen bg-gray-50 font-sans overflow-x-hidden ${fullscreen ? 'fixed inset-0 z-50 h-screen' : ''}`}>
      {/* Header + counts */}
      <div className="bg-white border-b border-gray-200 px-3 py-2 flex flex-wrap items-center justify-between gap-2 shadow-sm z-10 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {!fullscreen && (
            <button onClick={() => navigate('/admin/dashboard')} aria-label="Back" className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg"><ArrowLeft size={18} /></button>
          )}
          <div className="min-w-0">
            <h1 className="text-base font-bold text-gray-900">God's Eye - Live Operations</h1>
            <p className="text-xs font-semibold text-gray-500 flex items-center gap-1">
              <Radio size={12} className={error ? 'text-red-500' : paused ? 'text-gray-400' : 'text-green-500 animate-pulse'} />
              {paused ? 'Paused' : error ? 'Connection problem' : 'Live'}{lastSync && ` - updated ${lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          {kpi('Online', counts.onlineDrivers)}
          {kpi('Idle', counts.idleDrivers, 'text-green-600')}
          {kpi('On trip', counts.onTripDrivers, 'text-yellow-600')}
          {kpi('Searching', counts.searchingRides, 'text-blue-600')}
          {kpi('Pending req.', counts.pendingRequests, 'text-blue-600')}
          {kpi('Scheduled', counts.scheduledRides)}
          {kpi('SOS', counts.openAlerts, counts.openAlerts > 0 ? 'text-red-500 animate-pulse' : 'text-black')}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border-b border-red-200 px-3 py-1.5 text-xs text-red-700 font-semibold flex items-center gap-2 flex-shrink-0">
          <AlertTriangle size={14} /> {live ? 'Live data is stale: ' : 'Could not load live data: '}{error}
          <button onClick={fetchLive} className="ml-auto underline">Retry</button>
        </div>
      )}

      <div className="flex flex-col lg:flex-row flex-1 lg:overflow-hidden relative min-h-0">
        {/* Filters + lists */}
        <div className="w-full lg:w-72 bg-white border-b lg:border-b-0 lg:border-r border-gray-200 flex flex-col z-10 flex-shrink-0 lg:min-h-0">
          <div className="p-3 space-y-2 border-b border-gray-100">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text" placeholder="Search driver, phone, vehicle, rider, ride id" value={search} onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-8 pr-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs focus:border-yellow-400 outline-none text-black font-medium"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectClass} aria-label="Driver status">
                <option value="all">All drivers</option><option value="idle">Idle</option><option value="busy">On trip</option>
              </select>
              <select value={vehicleFilter} onChange={(e) => setVehicleFilter(e.target.value)} className={selectClass} aria-label="Vehicle">
                <option value="all">All vehicles</option><option value="car">Car</option><option value="bike">Bike</option><option value="auto">Auto</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[['drivers', 'Drivers'], ['rides', 'Rides'], ['alerts', 'SOS'], ['traffic', 'Traffic']].map(([k, label]) => (
                <button key={k} onClick={() => setLayers((l) => ({ ...l, [k]: !l[k] }))}
                  className={`px-2 py-1 rounded-md text-[10px] font-bold border ${layers[k] ? 'bg-yellow-400 border-yellow-500 text-black' : 'bg-white border-gray-200 text-gray-500'}`}>
                  {label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button onClick={fetchLive} className={`${btnPrimary} flex-1`}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh</button>
              <button onClick={() => setPaused((p) => !p)} className={`${btnSecondary} flex-1`}>{paused ? 'Resume' : 'Pause'}</button>
            </div>
          </div>

          <div className="flex border-b border-gray-100">
            {tabBtn('drivers', 'Drivers', filteredDrivers.length)}
            {tabBtn('rides', 'Rides', filteredRides.length)}
            {tabBtn('alerts', 'SOS', alerts.length)}
          </div>
          <div className="overflow-y-auto max-h-64 lg:max-h-none lg:flex-1 divide-y divide-gray-50">
            {loading && !live && <p className="p-4 text-xs text-gray-400">Loading live data...</p>}
            {tab === 'drivers' && filteredDrivers.map((d) => (
              <button key={d.id} onClick={() => pick('driver', d)} className={`w-full text-left px-3 py-2 hover:bg-yellow-50 ${selected?.id === d.id ? 'bg-yellow-50' : ''}`}>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${d.isOnRide ? 'bg-yellow-600' : 'bg-green-500'}`} />
                  <span className="text-xs font-bold text-black truncate">{d.name || 'Driver'}</span>
                  <span className="ml-auto text-[10px] text-gray-400 whitespace-nowrap">{ago(d.updatedAt)}</span>
                </div>
                <p className="text-[10px] text-gray-500 truncate pl-4">{d.isOnRide ? 'On trip' : 'Idle'} - {d.vehicle?.number || d.phone}</p>
              </button>
            ))}
            {tab === 'rides' && filteredRides.map((r) => (
              <button key={r.id} onClick={() => pick('ride', r, r.pickup)} className={`w-full text-left px-3 py-2 hover:bg-yellow-50 ${selected?.id === r.id ? 'bg-yellow-50' : ''}`}>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${r.status === 'searching' ? 'bg-blue-500' : 'bg-yellow-600'}`} />
                  <span className="text-xs font-bold text-black truncate">{r.kindLabel} - {statusWords(r)}</span>
                  <span className="ml-auto text-[10px] font-bold">{money(r.fare)}</span>
                </div>
                <p className="text-[10px] text-gray-500 truncate pl-4">{r.pickup?.address || 'Pickup not mapped'}</p>
              </button>
            ))}
            {tab === 'alerts' && alerts.map((a) => (
              <button key={a.id} onClick={() => pick('alert', a)} className={`w-full text-left px-3 py-2 hover:bg-red-50 ${selected?.id === a.id ? 'bg-red-50' : ''}`}>
                <div className="flex items-center gap-2">
                  <ShieldAlert size={14} className="text-red-500 flex-shrink-0" />
                  <span className="text-xs font-bold text-black truncate">{a.triggeredBy === 'driver' ? a.driverName : a.riderName || 'SOS alert'}</span>
                  <span className="ml-auto text-[10px] text-gray-400">{ago(a.createdAt)}</span>
                </div>
              </button>
            ))}
            {live && ((tab === 'drivers' && !filteredDrivers.length) || (tab === 'rides' && !filteredRides.length) || (tab === 'alerts' && !alerts.length)) && (
              <p className="p-4 text-xs text-gray-400">{tab === 'drivers' ? 'No online drivers match. Drivers appear here only while online and sending GPS.' : tab === 'rides' ? 'No active rides.' : 'No open SOS alerts.'}</p>
            )}
          </div>
        </div>

        {/* Map */}
        <div className="flex-1 relative bg-gray-200 min-h-[55vh] lg:min-h-0">
          <div className="absolute top-3 right-3 z-10 flex flex-col gap-2">
            <button onClick={toggleFullscreen} aria-label="Fullscreen" className="p-2 bg-white text-gray-600 rounded-lg shadow-md">{fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}</button>
            <button onClick={fitAll} aria-label="Fit all" className="p-2 bg-white text-gray-600 rounded-lg shadow-md"><Layers size={16} /></button>
          </div>
          {mapReady ? (
            <GoogleMap
              mapContainerStyle={{ width: '100%', height: '100%', minHeight: '55vh' }}
              center={INDIA_CENTER} zoom={5} options={mapOptions} onLoad={setMap} onUnmount={() => setMap(null)}
              onClick={() => setSelected(null)}
            >
              {layers.traffic && <TrafficLayer />}
              {layers.drivers && filteredDrivers.map((d) => (
                <MarkerF key={d.id} position={{ lat: d.lat, lng: d.lng }} icon={driverIcon(d, selected?.id === d.id)} onClick={() => pick('driver', d)} title={d.name} zIndex={selected?.id === d.id ? 999 : 10} />
              ))}
              {layers.rides && filteredRides.filter((r) => hasPoint(r.pickup)).map((r) => (
                <MarkerF key={`p-${r.id}`} position={{ lat: r.pickup.lat, lng: r.pickup.lng }} icon={pinIcon(r.status === 'searching' ? '#2563eb' : '#7c3aed', selected?.id === r.id ? 9 : 6)} onClick={() => pick('ride', r, r.pickup)} title="Pickup" />
              ))}
              {layers.rides && selectedRide && hasPoint(selectedRide.drop) && (
                <MarkerF position={{ lat: selectedRide.drop.lat, lng: selectedRide.drop.lng }} icon={pinIcon('#0f172a', 7)} title="Drop" />
              )}
              {route && route.id === rideKey && <PolylineF path={route.path} options={{ strokeColor: '#2563eb', strokeWeight: 4, strokeOpacity: 0.8 }} />}
              {layers.alerts && alerts.filter(hasPoint).map((a) => (
                <MarkerF key={`a-${a.id}`} position={{ lat: a.lat, lng: a.lng }} icon={pinIcon('#dc2626', 11)} onClick={() => pick('alert', a)} title="SOS" zIndex={1000} />
              ))}
            </GoogleMap>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-50 px-4 text-center gap-2">
              <MapIcon size={40} className="text-gray-300" />
              <p className="text-xs font-black text-gray-500 uppercase tracking-wider">
                {loadError ? 'Google Maps failed to load' : !HAS_VALID_GOOGLE_MAPS_KEY ? 'Google Maps key not configured' : 'Loading map...'}
              </p>
              <p className="text-xs text-gray-400">Live drivers, rides and SOS alerts are still listed on the left and update automatically.</p>
            </div>
          )}
          {live && !loading && drivers.length === 0 && rides.length === 0 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 bg-white/95 px-4 py-2 rounded-xl shadow border border-gray-200 text-xs font-semibold text-gray-600 flex items-center gap-2">
              <Car size={14} /> No online drivers or active rides right now
            </div>
          )}
        </div>

        {/* Details */}
        {sel && (
          <div className="w-full lg:w-80 bg-white border-t lg:border-t-0 lg:border-l border-gray-200 flex flex-col z-20 flex-shrink-0 lg:min-h-0 lg:overflow-y-auto">
            <div className={`px-3 py-2 flex items-center justify-between ${sel.type === 'alert' ? 'bg-red-500 text-white' : 'bg-yellow-400 text-black'}`}>
              <h2 className="text-xs font-black uppercase tracking-wider">{sel.type === 'driver' ? 'Driver' : sel.type === 'ride' ? 'Ride' : 'SOS alert'}</h2>
              <button onClick={() => setSelected(null)} aria-label="Close" className="p-1 rounded-md hover:bg-black/10"><X size={16} /></button>
            </div>
            <div className="p-3 space-y-3">
              {sel.type === 'driver' && (
                <>
                  <div>
                    <h3 className="text-base font-black text-black">{sel.item.name || 'Driver'}</h3>
                    {sel.item.phone && <a href={`tel:${sel.item.phone}`} className="text-xs text-blue-600 font-semibold inline-flex items-center gap-1"><Phone size={12} />{sel.item.phone}</a>}
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2.5 space-y-1.5 border border-gray-100">
                    {row('Status', sel.item.isOnRide ? 'On trip' : 'Online, idle')}
                    {row('Vehicle', sel.item.vehicle?.label || sel.item.vehicle?.type)}
                    {row('Number plate', sel.item.vehicle?.number)}
                    {row('Last GPS', ago(sel.item.updatedAt))}
                    {row('Heading', sel.item.heading !== null ? `${Math.round(sel.item.heading)} deg` : '')}
                  </div>
                </>
              )}
              {selectedRide && (
                <div className="bg-yellow-50 rounded-lg p-2.5 space-y-1.5 border border-yellow-100">
                  <h4 className="text-[10px] font-bold text-yellow-700 uppercase">{sel.type === 'driver' ? 'Current ride' : 'Ride'}</h4>
                  {row('Kind', selectedRide.kindLabel)}
                  {row('Status', statusWords(selectedRide))}
                  {row('Rider', selectedRide.rider ? `${selectedRide.rider.name} ${selectedRide.rider.phone}` : '')}
                  {sel.type === 'ride' && row('Driver', driverById.get(selectedRide.driverId) ? `${driverById.get(selectedRide.driverId).name} ${driverById.get(selectedRide.driverId).phone}` : selectedRide.driverId ? 'Driver offline / no GPS' : 'Not assigned yet')}
                  {row('Pickup', selectedRide.pickup?.address)}
                  {row('Drop', selectedRide.drop?.address)}
                  {row('Fare', money(selectedRide.fare))}
                  {row('Requested', ago(selectedRide.createdAt))}
                  {row('Ride id', selectedRide.id)}
                  {!hasPoint(selectedRide.pickup) && <p className="text-[10px] text-gray-500">This booking has no map location (for example a website enquiry).</p>}
                </div>
              )}
              {sel.type === 'alert' && (
                <div className="bg-red-50 rounded-lg p-2.5 space-y-1.5 border border-red-100">
                  {row('Raised by', sel.item.triggeredBy)}
                  {row('Rider', `${sel.item.riderName} ${sel.item.riderPhone}`.trim())}
                  {row('Driver', `${sel.item.driverName} ${sel.item.driverPhone}`.trim())}
                  {row('Trip', sel.item.tripCode)}
                  {row('Raised', ago(sel.item.createdAt))}
                  {sel.item.rideId && rideById.get(sel.item.rideId) && (
                    <button onClick={() => pick('ride', rideById.get(sel.item.rideId), rideById.get(sel.item.rideId).pickup)} className={`${btnSecondary} w-full`}>Show ride</button>
                  )}
                  <button onClick={() => navigate('/admin/safety')} className={`${btnSecondary} w-full`}>Open safety alerts</button>
                </div>
              )}
              {sel.type !== 'alert' && selectedRide?.id && (
                <button onClick={() => navigate('/admin/ongoing')} className={`${btnSecondary} w-full`}><Activity size={13} /> Open ongoing rides</button>
              )}
              {sel.type === 'driver' && <button onClick={() => focus(sel.item)} className={`${btnPrimary} w-full`}><Navigation size={13} /> Locate on map</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default GodsEye;
