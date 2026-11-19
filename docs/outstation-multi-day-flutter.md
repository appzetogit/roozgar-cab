# Outstation multi-day round trip (rider app and driver app)

For the Flutter developers. **Additive**: a booking of 1 day (every outstation booking today, one way or round trip) is priced,
booked and settled exactly as before. An app that does not send `days` keeps working unchanged.

## What the feature is
On an outstation **round trip** the rider can keep the cab for several days ("Indore to Ujjain, 3 days, back on 12 Dec").
The admin sets, on each outstation price row (one vehicle of one destination), the **price of each extra day**.

```
fare of D days (before tolls) = round(basePrice x 1.8)  +  (D - 1) x extraDayPrice
```
- `basePrice x 1.8` is what a same-day round trip already costs (D = 1).
- Example, base Rs 3000, extra day Rs 2000: 1 day 5400, 2 days 7400, 3 days 9400.
- Tolls (both ways, once) are added on top by the server, as for every outstation ride.
- `extraDayPrice == 0` on a row means **multi-day is not offered for that vehicle** (the server refuses it).
- A one way trip is always 1 day (`days` is ignored). The maximum is 30 days.
- The advance (admin's % or fixed amount) is taken on the **whole** multi-day fare, paid online before booking, refunded in full on cancel, as today.

---

## A. Rider app

### A1. Package list (what you already call)
`GET /users/intercity-packages` -> every vehicle now also has **`extraDayPrice`** (number, 0 = no multi-day).

### A2. Screen change
When the rider picks **Round Trip**, show a **"Number of days"** stepper (1 to 30, default 1).
- `returnDate` = travel date + (days - 1), sent as `YYYY-MM-DD`. Show "You keep the cab until 12 Dec".
- Vehicle card price = the formula above. If `days > 1` and the vehicle's `extraDayPrice == 0`, show "Not available for N days" and do not let the rider continue with it.
- The web app does exactly this (`frontend/.../intercity/IntercityVehicle.jsx`): a reference.

### A3. Advance quote, order, booking: send `days`
Add two fields to the `intercity` object of **all three calls** (`POST /rides/outstation/advance/quote`, `.../order`, and `POST /rides`):

```json
"intercity": { "packageId": "...", "fromCity": "Indore", "toCity": "Ujjain",
               "tripType": "Round Trip", "days": 3, "returnDate": "2026-12-12", "...": "as today" }
```
- For `days > 1` the **server prices the trip itself** from the row and ignores the `fare` the app sends. Show the server's number: the quote answers
  `fare` (total with tolls), `tolls`, `amount` (the advance), `remaining`, and the new **`days`** and **`extraDayPrice`**. "Fare before tolls" = `fare - tolls`.
- Send the same `fare` the app calculated; if it differs from the server's, the server's wins and the advance still matches (no `ADVANCE_MISMATCH`).
- New error: **400 `MULTI_DAY_NOT_AVAILABLE`** ("Multi-day trips are not available for this vehicle"): the vehicle has no extra day price, or the package id is missing. Ask the rider to pick another vehicle or 1 day.

### A4. During and after the trip
The ride object (`GET /rides/:id`, socket updates) carries in `intercity`:

| Field | Meaning |
|---|---|
| `days` | days the rider booked (1 for every normal ride) |
| `extraDayPrice` | price of one extra day, kept from booking time |
| `actualDays`, `extraDays`, `extraDayCharge` | filled **when the driver ends the trip** (status `arrived`): days really used, days beyond the booked ones, rupees added |
| `daysSettledAt` | set once the above are final |

If the rider keeps the cab beyond the booked days (a day = a calendar day in India: started on the 10th, 3 days booked, ended on the 13th = 1 extra day),
the **fare grows by `extraDays x extraDayPrice`** at that moment. `fare` and `amountDue` (= fare minus the advance paid) in the same payload are the final amounts: show them on the
trip-end screen and the receipt ("3 days booked + 1 extra day: Rs 2000"). Refresh the ride when the status becomes `arrived`.

---

## B. Driver app

### B1. Offer card
A multi-day outstation offer is a normal `ride_request` push (and `ride:request` socket event). New **string** fields, only when the trip has 2 or more days:

| Field | Example |
|---|---|
| `tripDays` | `"3"` |
| `returnDate` | `"2026-12-12"` (can be empty) |

Show "3 day trip, back on 12 Dec" on the card and read it aloud with the rest. `fare` is the total the rider will pay for all days (with tolls). The socket offer has the same
numbers in `intercity.days`, `intercity.returnDate`.

### B2. Ride screen
Show the number of days and the return date on the trip screen. The ride stays `ongoing` for all the days; the driver ends it only when the cab is back.
When the driver ends the trip (**arrived**), re-read the ride: if the rider kept the cab longer, `fare` and `amountDue` have increased. **Collect `amountDue`** (also the UPI QR amount).

### B3. Driver earning (same rules as every outstation ride)
- Commission = the admin's % on the fare **without tolls** (percentage and values are on the price row: solo driver, or the fleet owner's own %).
- Tolls and anything the driver paid are not charged commission. A daily pass or an owner's plan waives the commission as before.
- The advance is held by the platform: the driver (or owner) wallet is credited `advance - commission`, and the driver collects the rest in cash.
- Example, 3 days, Rs 9400 + Rs 400 tolls = Rs 9800, advance 20% = Rs 1960, commission 10% of 9400 = Rs 940: wallet +1020, cash to collect Rs 7840, driver total Rs 8860.
  If the rider keeps a 4th day: fare 11800, commission 1140, cash to collect Rs 9840.

---

## C. Admin (already done in the web admin)
Admin > Pricing > Outstation Pricing > each vehicle row has **"Price of each extra day (Rs)"**. 0 = multi-day not offered. The same row's cancellation fee, advance and commission apply.
Starting values have been set for the existing rows (placeholder: 1.5 x that vehicle's cheapest outstation price); the admin should change them to the real day rates.

## D. Not changed
City rides, hourly rental, parcel, share ride, one way outstation, 1-day round trip, cancellation (accept-before: free + advance refunded; after: the row's fee + advance refunded).

## E. Test pass (about 10 minutes)
1. Round trip, 3 days, Dzire: card shows `round(base x 1.8) + 2 x extraDayPrice`; the advance sheet shows the server total with tolls; `fare` sent by the app can be anything.
2. Vehicle with `extraDayPrice 0`: "Not available for 3 days", and a direct booking gets 400 `MULTI_DAY_NOT_AVAILABLE`.
3. One way with `days: 5`: priced as a normal one way.
4. Driver app: the offer shows "3 day trip"; accept, OTP, start, end on the 3rd calendar day: no extra charge, collect `amountDue`.
5. End on the 4th calendar day: `intercity.extraDays = 1`, fare and `amountDue` increased by `extraDayPrice`.
6. Cancel before and after a driver accepts: advance refunded in full; the row's cancellation fee only after accept.

## F. Known limits
- A day is a calendar day (India time), not 24 hours. The trip is billed for days kept **beyond** the booked ones; ending earlier does not refund booked days.
- No per-day km limit and no driver night allowance yet (the fare is flat per day).
- The rider cannot change the days after booking.
