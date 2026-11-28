import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Loader2, RefreshCw, Search, MapPin, Star, Phone, UserCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { adminService } from '../../services/adminService';

// "Assign Driver": the free drivers of the zone the rider booked in, for one booking that is still waiting for a driver.
// The server decides who is listed (same zone, online, not on a ride, enrolled in the booked vehicle, able to take a ride),
// so the list is the truth; this only shows it and sends the chosen driver back.

const unwrap = (response) => response?.data?.data || response?.data || response || {};
const messageOf = (error) => error?.response?.data?.message || error?.message || 'Something went wrong';

const AssignDriverModal = ({ rideId, requestId = '', kindLabel = '', onClose, onAssigned }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState({ drivers: [], zone: null, pickupAddress: '', dropAddress: '', note: '' });
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const body = unwrap(await adminService.getAssignableDrivers(rideId));
      setData({ drivers: body.drivers || [], zone: body.zone || null, pickupAddress: body.pickupAddress || '', dropAddress: body.dropAddress || '', note: body.note || '' });
      setSelected((current) => ((body.drivers || []).some((driver) => driver.id === current) ? current : ''));
    } catch (err) {
      setData({ drivers: [], zone: null, pickupAddress: '', dropAddress: '', note: '' });
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [rideId]);

  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return data.drivers;
    return data.drivers.filter((driver) => [driver.name, driver.phone, driver.vehicleNumber, driver.vehicleName].some((value) => String(value || '').toLowerCase().includes(text)));
  }, [data.drivers, query]);

  const assign = async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const body = unwrap(await adminService.assignDriver(rideId, selected));
      toast.success(`${body?.driver?.name || 'The driver'} is assigned. The rider and the driver were told.`);
      onAssigned?.(body);
      onClose();
    } catch (err) {
      toast.error(messageOf(err));
      load(); // the driver may have gone busy or offline meanwhile: show who is free now
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label="Assign driver">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-extrabold text-gray-900">Assign driver</h2>
            <p className="mt-0.5 truncate text-[11px] font-semibold text-gray-500">
              {requestId || `REQ_${String(rideId).slice(-12).toUpperCase()}`}{kindLabel ? ` · ${kindLabel}` : ''}
            </p>
            {(data.pickupAddress || data.dropAddress) && (
              <p className="mt-1 line-clamp-2 break-words text-[11px] leading-snug text-gray-500">
                <MapPin size={11} className="mr-0.5 inline text-green-600" />{data.pickupAddress || 'Pickup'}
                <span className="mx-1 text-gray-300">to</span>{data.dropAddress || 'Drop'}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-900" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="flex items-center justify-between gap-2 px-5 pt-3">
          <p className="text-[11px] font-bold text-gray-600">
            {data.zone?.name ? <>Zone: <span className="text-gray-900">{data.zone.name}</span> · </> : null}
            {loading ? 'Loading drivers...' : `${data.drivers.length} free driver${data.drivers.length === 1 ? '' : 's'}`}
          </p>
          <button type="button" onClick={load} disabled={loading} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold text-gray-600 hover:bg-gray-100 disabled:opacity-40">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        {data.drivers.length > 4 && (
          <div className="relative px-5 pt-2">
            <Search size={13} className="absolute left-8 top-1/2 mt-1 -translate-y-1/2 text-gray-400" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, phone or vehicle number"
              className="h-9 w-full rounded-lg border border-gray-200 bg-gray-50 pl-8 pr-3 text-xs outline-none focus:border-yellow-400" />
          </div>
        )}

        <div className="min-h-[160px] flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="flex h-32 items-center justify-center text-gray-400"><Loader2 className="animate-spin" size={22} /></div>
          ) : error ? (
            <div className="py-8 text-center">
              <p className="text-sm font-bold text-red-600">{error}</p>
              <button type="button" onClick={load} className="mt-3 rounded-lg bg-black px-4 py-2 text-xs font-bold text-white">Try again</button>
            </div>
          ) : shown.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm font-bold text-gray-900">{data.drivers.length ? 'No driver matches your search' : 'No free driver for this booking right now'}</p>
              <p className="mx-auto mt-1 max-w-xs text-[11px] leading-snug text-gray-500">
                {data.note || 'Only drivers of this zone who are online, not on a ride and enrolled in the booked vehicle are listed. Try again in a moment.'}
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {shown.map((driver) => {
                const active = selected === driver.id;
                return (
                  <li key={driver.id}>
                    <button type="button" onClick={() => setSelected(driver.id)} aria-pressed={active}
                      className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${active ? 'border-yellow-400 bg-yellow-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-extrabold ${active ? 'bg-yellow-400 text-black' : 'bg-gray-100 text-gray-600'}`}>
                        {active ? <UserCheck size={16} /> : String(driver.name || '?').charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-bold text-gray-900">{driver.name || 'Driver'}</span>
                          {driver.fleet ? <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[9px] font-bold text-indigo-700">Fleet</span> : null}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-gray-500">
                          {[driver.vehicleNumber, driver.vehicleName || driver.vehicleType].filter(Boolean).join(' · ')}
                        </span>
                        <span className="mt-0.5 flex items-center gap-3 text-[11px] text-gray-500">
                          {driver.phone ? <span className="inline-flex items-center gap-1"><Phone size={10} />{driver.phone}</span> : null}
                          {Number(driver.rating) > 0 ? <span className="inline-flex items-center gap-1"><Star size={10} className="text-amber-500" />{Number(driver.rating).toFixed(1)}</span> : null}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-[13px] font-extrabold text-gray-900">{driver.distanceKm === null || driver.distanceKm === undefined ? '-' : `${driver.distanceKm} km`}</span>
                        <span className="block text-[10px] text-gray-400">from pickup</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button type="button" onClick={onClose} className="h-9 rounded-lg border border-gray-200 px-4 text-xs font-bold text-gray-700 hover:bg-gray-50">Cancel</button>
          <button type="button" onClick={assign} disabled={!selected || saving}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-black px-4 text-xs font-bold text-white hover:bg-gray-900 disabled:cursor-not-allowed disabled:opacity-40">
            {saving ? <Loader2 size={13} className="animate-spin" /> : null} Assign this driver
          </button>
        </div>
      </div>
    </div>
  );
};

export default AssignDriverModal;
