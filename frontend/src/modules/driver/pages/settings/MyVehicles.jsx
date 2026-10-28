import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Car, CheckCircle2, Clock, ImagePlus, LoaderCircle, Plus, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import {
    activateDriverVehicle,
    cancelDriverVehicleRequest,
    getDriverVehicles,
    removeDriverVehicle,
    requestDriverVehicle,
} from '../../services/registrationService';
import { useImageUpload } from '../../../../shared/hooks/useImageUpload';

const unwrap = (response) => response?.data?.data || response?.data || response;
const emptyForm = { vehicleTypeId: '', vehicleNumber: '', vehicleColor: '', vehicleMake: '', vehicleModel: '', vehicleImage: '' };
const inputCls = 'w-full bg-transparent border-none p-0 text-[15px] font-bold text-slate-900 focus:outline-none placeholder:text-slate-300';
const boxCls = 'bg-slate-50 border border-slate-200 p-4 rounded-2xl focus-within:border-slate-400 transition-colors';

const VehicleThumb = ({ v, typeImage }) => {
    const src = v.vehicleImage || v.vehicleIconUrl || typeImage;
    return (
        <div className="h-14 w-16 overflow-hidden rounded-2xl border border-slate-100 bg-slate-50 shrink-0 flex items-center justify-center">
            {src ? <img src={src} alt={v.vehicleTypeName || 'Vehicle'} className="h-full w-full object-cover" /> : <Car size={22} className="text-slate-300" />}
        </div>
    );
};

const VehicleInfo = ({ v }) => (
    <div className="min-w-0 flex-1">
        <p className="text-[14px] font-bold text-slate-900 truncate">{v.vehicleTypeName || v.vehicleType || 'Vehicle'}{[v.vehicleMake, v.vehicleModel].filter(Boolean).length ? ` • ${[v.vehicleMake, v.vehicleModel].filter(Boolean).join(' ')}` : ''}</p>
        <p className="text-[12px] font-semibold tracking-widest text-slate-500 uppercase truncate">{v.vehicleNumber}</p>
        <p className="text-[11px] font-medium text-slate-400 truncate">{v.vehicleColor || 'Color not set'}</p>
    </div>
);

const MyVehicles = ({ vehicleTypes = [], onChanged }) => {
    const [data, setData] = useState({ vehicles: [], requests: [], canAdd: false });
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState('');
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState(emptyForm);
    const [submitting, setSubmitting] = useState(false);
    const fileRef = useRef(null);
    const { uploading, preview, handleFileChange, setPreview } = useImageUpload({
        folder: 'driver-vehicles',
        onSuccess: (url) => setForm((prev) => ({ ...prev, vehicleImage: url })),
    });

    const typeImage = (id) => {
        const t = vehicleTypes.find((x) => String(x._id || x.id) === String(id));
        return t?.image || t?.icon || t?.map_icon || '';
    };

    const refresh = useCallback(async () => {
        try {
            setData(unwrap(await getDriverVehicles()) || { vehicles: [], requests: [], canAdd: false });
        } catch (error) {
            toast.error(error.message || 'Could not load vehicles');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    // Run an action, toast on error, then reload list + parent driver profile.
    const run = async (id, fn, okMsg) => {
        setBusyId(id);
        try {
            await fn();
            if (okMsg) toast.success(okMsg);
            await refresh();
            onChanged?.();
        } catch (error) {
            toast.error(error.message || 'Something went wrong');
        } finally {
            setBusyId('');
        }
    };

    const submit = async () => {
        if (!form.vehicleTypeId) return toast.error('Select a vehicle type first');
        if (!form.vehicleNumber.trim() || !form.vehicleColor.trim()) return toast.error('Vehicle number and color are required');
        setSubmitting(true);
        try {
            const payload = Object.fromEntries(Object.entries(form).filter(([, val]) => String(val).trim()));
            await requestDriverVehicle(payload);
            toast.success('Vehicle sent to admin for approval');
            setShowForm(false);
            setForm(emptyForm);
            setPreview(null);
            await refresh();
        } catch (error) {
            toast.error(error.message || 'Could not add vehicle');
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) return <div className="flex justify-center py-6 text-slate-400"><LoaderCircle size={22} className="animate-spin" /></div>;

    return (
        <section className="space-y-4">
            <div className="px-1">
                <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">My Vehicles</h3>
                <p className="text-[12px] font-medium text-slate-500 mt-1 leading-relaxed">
                    You receive ride requests only for your active vehicle. Switch vehicle to get other bookings.
                </p>
            </div>

            {(data.vehicles || []).map((v) => (
                <div key={v.id} className={`bg-white rounded-3xl p-4 shadow-sm border ${v.isActive ? 'border-emerald-300' : 'border-slate-100'}`}>
                    <div className="flex items-center gap-3">
                        <VehicleThumb v={v} typeImage={typeImage(v.vehicleTypeId)} />
                        <VehicleInfo v={v} />
                        {v.isActive && (
                            <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-600 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full shrink-0">
                                <CheckCircle2 size={12} /> Active
                            </span>
                        )}
                    </div>
                    {!v.isActive && (
                        <div className="flex items-center gap-2 mt-3">
                            <button
                                disabled={!!busyId}
                                onClick={() => run(v.id, () => activateDriverVehicle(v.id), `Now receiving ${v.vehicleTypeName || 'vehicle'} bookings`)}
                                className="flex-1 h-10 rounded-xl bg-slate-950 text-white text-[12px] font-bold uppercase tracking-wider disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {busyId === v.id && <LoaderCircle size={14} className="animate-spin" />} Use this vehicle
                            </button>
                            <button
                                disabled={!!busyId}
                                aria-label="Remove vehicle"
                                onClick={() => window.confirm('Remove this vehicle?') && run(v.id, () => removeDriverVehicle(v.id), 'Vehicle removed')}
                                className="h-10 w-10 rounded-xl bg-rose-50 text-rose-500 flex items-center justify-center disabled:opacity-50"
                            >
                                <Trash2 size={16} />
                            </button>
                        </div>
                    )}
                </div>
            ))}

            {(data.requests || []).map((r) => (
                <div key={r.id} className={`rounded-3xl p-4 border ${r.status === 'rejected' ? 'bg-rose-50/60 border-rose-100' : 'bg-amber-50/50 border-amber-100'}`}>
                    <div className="flex items-center gap-3">
                        <VehicleThumb v={r} typeImage={typeImage(r.vehicleTypeId)} />
                        <VehicleInfo v={r} />
                    </div>
                    {r.status === 'rejected' ? (
                        <p className="mt-3 text-[12px] font-semibold text-rose-600">Rejected{r.rejectionReason ? `: ${r.rejectionReason}` : ''}</p>
                    ) : (
                        <div className="flex items-center justify-between mt-3">
                            <span className="inline-flex items-center gap-1 text-amber-600 text-[10px] font-bold uppercase tracking-wider">
                                <Clock size={12} /> Waiting for admin approval
                            </span>
                            <button
                                disabled={!!busyId}
                                onClick={() => run(r.id, () => cancelDriverVehicleRequest(r.id), 'Request cancelled')}
                                className="text-[11px] font-bold text-slate-500 bg-white border border-slate-200 px-3 py-1.5 rounded-lg disabled:opacity-50"
                            >
                                Cancel
                            </button>
                        </div>
                    )}
                </div>
            ))}

            {data.canAdd && (
                <button
                    onClick={() => setShowForm(true)}
                    className="w-full h-12 rounded-2xl border-2 border-dashed border-slate-200 text-slate-600 text-[12px] font-bold uppercase tracking-wider flex items-center justify-center gap-2"
                >
                    <Plus size={16} /> Add another vehicle
                </button>
            )}

            <AnimatePresence>
                {showForm && (
                    <>
                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowForm(false)} className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[90]" />
                        <motion.div
                            initial={{ y: '100%' }}
                            animate={{ y: 0 }}
                            exit={{ y: '100%' }}
                            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
                            className="fixed bottom-0 left-0 right-0 z-[100] max-h-[88vh] overflow-y-auto bg-white rounded-t-[2.5rem] p-6 pb-10 shadow-2xl max-w-lg mx-auto space-y-5"
                        >
                            <div className="flex items-center justify-between">
                                <h2 className="text-2xl font-bold text-slate-900">Add Vehicle</h2>
                                <button onClick={() => setShowForm(false)} className="w-10 h-10 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-500"><X size={22} /></button>
                            </div>
                            <p className="text-[12px] text-slate-500">Roozgar Cab admin will review this vehicle. Nothing changes until it is approved.</p>

                            <div className="grid grid-cols-3 gap-3">
                                {vehicleTypes.map((type) => {
                                    const id = String(type._id || type.id);
                                    const selected = form.vehicleTypeId === id;
                                    const img = type.image || type.icon || type.map_icon;
                                    return (
                                        <button
                                            key={id}
                                            type="button"
                                            onClick={() => setForm((p) => ({ ...p, vehicleTypeId: id }))}
                                            className={`flex flex-col items-center justify-center gap-2 p-3 rounded-2xl min-h-[90px] border-2 ${selected ? 'bg-slate-950 border-slate-950 text-white' : 'bg-white border-slate-100 text-slate-400'}`}
                                        >
                                            {img ? <img src={img} alt="" className="h-8 w-8 object-contain" /> : <Car size={20} />}
                                            <span className="text-[10px] font-bold uppercase tracking-wider text-center">{type.name || type.vehicle_type || 'Vehicle'}</span>
                                        </button>
                                    );
                                })}
                            </div>

                            <div className={boxCls}>
                                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Plate Number</label>
                                <input value={form.vehicleNumber} onChange={(e) => setForm((p) => ({ ...p, vehicleNumber: e.target.value.toUpperCase() }))} placeholder="e.g. MH12AB1234" className={`${inputCls} uppercase`} />
                            </div>
                            <div className={boxCls}>
                                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Color</label>
                                <input value={form.vehicleColor} onChange={(e) => setForm((p) => ({ ...p, vehicleColor: e.target.value }))} placeholder="e.g. White" className={inputCls} />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className={boxCls}>
                                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Make (optional)</label>
                                    <input value={form.vehicleMake} onChange={(e) => setForm((p) => ({ ...p, vehicleMake: e.target.value }))} className={inputCls} />
                                </div>
                                <div className={boxCls}>
                                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Model (optional)</label>
                                    <input value={form.vehicleModel} onChange={(e) => setForm((p) => ({ ...p, vehicleModel: e.target.value }))} className={inputCls} />
                                </div>
                            </div>

                            <input ref={fileRef} type="file" accept="image/*" className="sr-only" onChange={handleFileChange} disabled={uploading} />
                            <button
                                type="button"
                                disabled={uploading}
                                onClick={() => fileRef.current?.click()}
                                className="w-full flex items-center gap-3 bg-slate-50 border border-slate-200 p-3 rounded-2xl text-[12px] font-bold text-slate-700 disabled:opacity-60"
                            >
                                <div className="h-14 w-16 overflow-hidden rounded-xl border border-slate-200 bg-white flex items-center justify-center shrink-0">
                                    {preview || form.vehicleImage ? <img src={preview || form.vehicleImage} alt="Vehicle" className="h-full w-full object-cover" /> : <ImagePlus size={20} className="text-slate-300" />}
                                </div>
                                {uploading ? 'Uploading...' : 'Vehicle photo (optional)'}
                            </button>

                            <button
                                onClick={submit}
                                disabled={submitting || uploading}
                                className="w-full h-14 bg-slate-950 text-white rounded-[1.5rem] flex items-center justify-center gap-3 text-[14px] font-bold uppercase tracking-widest disabled:opacity-50"
                            >
                                {submitting && <LoaderCircle size={18} className="animate-spin" />} Send for approval
                            </button>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>
        </section>
    );
};

export default MyVehicles;
