import React, { useEffect, useState } from 'react';
import api from '../../../shared/api/axiosInstance';

const fmtMinutes = (minutes) => {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
};

// Hourly rental terms / final bill. Renders nothing for a normal ride. Pass
// `initial` when the ride is already in hand, or `rideId` to load it.
const RentalCard = ({ rideId, initial = null, refreshKey = '' }) => {
  const [rental, setRental] = useState(initial?.packagePriceId ? initial : null);

  useEffect(() => {
    if (!rideId) return undefined;
    let active = true;
    api.get(`/rides/${rideId}`)
      .then((response) => {
        const payload = response?.data?.data || response?.data || response;
        if (active && payload?.rental?.packagePriceId) setRental(payload.rental);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [rideId, refreshKey]);

  if (!rental) return null;
  const settled = Boolean(rental.settledAt);

  return (
    <div className="rounded-[18px] border border-amber-100 bg-amber-50/70 px-4 py-3">
      <p className="text-[9px] font-black uppercase tracking-[0.22em] text-amber-700/70">Hourly Rental</p>
      <p className="mt-1 text-[13px] font-black text-slate-900">{rental.packageName}</p>
      <p className="mt-1 text-[11px] font-bold text-slate-600">
        Includes {rental.includedKm} km / {fmtMinutes(rental.includedMinutes)}
      </p>
      <p className="mt-1 text-[10px] font-bold text-slate-500">
        Extra: Rs {rental.extraKmRate}/km · Rs {rental.extraMinuteRate}/min
      </p>
      {settled ? (
        <div className="mt-3 space-y-1 border-t border-amber-100 pt-3 text-[12px] font-bold text-slate-700">
          <div className="flex justify-between"><span>Package</span><span>Rs {rental.packagePrice}</span></div>
          <div className="flex justify-between">
            <span>Extra {rental.extraKm} km ({rental.travelledKm} km driven)</span>
            <span>Rs {rental.extraKmCharge}</span>
          </div>
          <div className="flex justify-between">
            <span>Extra {fmtMinutes(rental.extraMinutes)} ({fmtMinutes(rental.usedMinutes)} used)</span>
            <span>Rs {rental.extraTimeCharge}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default RentalCard;
