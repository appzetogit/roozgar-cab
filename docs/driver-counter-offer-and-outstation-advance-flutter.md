# Driver counter-offers and the Outstation advance, Flutter integration guide

For the Flutter developers of the **rider app** and **driver app**. Everything here is **live in the backend code** and covered by
`Backend/scripts/testBidsAndAdvance.mjs` (every amount below is asserted there). The web apps already use all of it:

| Feature | Rider web reference | Driver web reference |
|---|---|---|
| Outstation advance | `frontend/src/modules/user/pages/intercity/IntercityConfirm.jsx`, `ride/RideTracking.jsx`, `ride/RideComplete.jsx`, `ride/RideDetail.jsx` | `driver/pages/ActiveTrip.jsx`, `IncomingRideRequest.jsx` |
| Driver counter-offer | `ride/SearchingDriver.jsx` ("Driver offers") | `driver/pages/IncomingRideRequest.jsx`, `components/DriverRideRequestListener.jsx` |
| Admin | web only (Bid Ride Settings, Outstation Pricing), nothing to build in Flutter | |

Base URL `https://roozgarcab.com/api/v1`. Responses are `{ "success": true, "data": ... }` or `{ "success": false, "message": "...", "code": "...", "details": ... }`.

---

## Part A. Driver counter-offer

### A1. The idea
Until now a driver could only **Accept** a ride offer at the rider's fare (or reject it), and the rider could **raise** their own fare while waiting.
Now a driver may also **counter**: answer the offer with a **higher price**. The rider sees every driver's offer and **picks one**; the ride then
runs at that price. The rider can keep raising the fare as before. Accepting at the quoted fare still works and ends the counter-offers.

The admin controls it (Admin > Bid Ride Settings > "Driver counter-offer"): on/off, **how far above the fare** a driver may go (percent, default 20), the
**step** (Rs, default 10), and which services it applies to (city / outstation / parcel). A hourly rental is never negotiated.

### A2. What the driver may counter with
Offer payloads (socket offer and `GET /drivers/ride-offers` items) carry a `counter` block:

```json
{ "fare": 1000,
  "counter": { "enabled": true, "maxPercentage": 20, "stepAmount": 10, "minFare": 1010, "maxFare": 1200,
               "options": [1010, 1020, "...", 1200] },
  "advancePaid": 0, "amountDue": 1000 }
```
* `options` = every price the driver may counter with: `fare + k * stepAmount` while `<= fare * (1 + maxPercentage/100)`. Show them as chips.
* `counter.enabled` is `false` when counter-offers are off for this ride, or the fare is too small for one step (a Rs 30 fare cannot take a Rs 10 step within 20%).
  Then show only Accept / Reject.
* The range follows the **current fare**: when the rider raises the fare the offer is re-sent with the new `counter` block.

### A3. Sending a counter  `POST /drivers/ride-offers/:rideId/bid`  (driver token)
Body `{ "bidFare": 1050 }` -> `{ "success": true, "data": { "bid": { "id", "rideId", "driverId", "bidFare": 1050, "incrementAmount": 50, "kind": "counter", "status": "pending", ... } } }`.
The same thing is available on the driver socket as `submitRideBid { rideId, bidFare }` (reply `rideBidSubmitted`). A driver has **one offer per ride**: sending a new
price replaces the old one.

Errors (always read `code`, show `message`):

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `COUNTER_TOO_LOW` | not above the fare (or not a number) |
| 400 | `COUNTER_TOO_HIGH` | above the admin's limit |
| 400 | `COUNTER_STEP` | not a whole step from the fare |
| 409 | `COUNTER_NOT_AVAILABLE` | counter-offers are off or impossible for this fare |
| 409 | - | ride no longer open / driver offline or on a ride / scheduled-trip clash |
| 403 | - | the driver cannot take rides now (no pass, owner's plan ended, wallet blocked): the same message as accepting |

After sending show "Offer Rs X sent, waiting for the rider". Keep the card open until the rider picks someone: if another driver is picked (or the ride is
taken at the quoted fare) the normal "ride taken" / `ride_request_closed` events close it. If **this** driver is picked, they get the usual ride-assigned event.

### A4. Rider side
* `GET /rides/:rideId/bids` -> `{ ride: { fare, driverCounter: { enabled, maxPercentage, stepAmount }, ... }, bids: [ { id, bidFare, incrementAmount, kind: "counter", status, driver: { id, name, phone, profileImage, vehicleType, vehicleNumber, vehicleColor, vehicleMake, vehicleModel, rating } } ] }` (cheapest first). Only the rider of that ride sees it.
* Realtime: socket `rideBidUpdated { rideId, fare, driverCounter, bid }` when a driver sends an offer; `rideBiddingUpdated` when the fare changed (reload the list).
* Pick one: `POST /rides/:rideId/bids/:bidId/accept`. The ride is assigned to that driver and **`fare` becomes the offer** (`baseFare` keeps the quote). `409 COUNTER_STALE`
  ("no longer above your fare") means the rider raised the fare after that offer: reload the list.
* Raising the fare (`PATCH /rides/:rideId/bids/ceiling`, unchanged) **expires every offer at or below the new fare**.
* Show the list also on normal rides (any `pricingNegotiationMode`) whenever `ride.driverCounter.enabled`.

### A5. Money
Commission, platform fee, tolls and subscription all work on the **final fare** (the offer), exactly like any other fare. Nothing else changes.

---

## Part B. Outstation advance

### B1. The idea
For an outstation booking the admin sets, **on each outstation price row (one vehicle of one package)**, an **advance**: a percentage of the fare or a fixed amount
(`advanceType` = `percentage` | `fixed`, `advanceValue`; 0 = none). The rider must **pay the advance online (Razorpay) before the booking is created**.
The rest is paid **after the ride** (cash to the driver, or online as today). If the ride is **cancelled for any reason the whole advance is refunded**.

The advance is worked out **by the server** on the booking fare (the app's fare with the route's tolls corrected). The app never says how much to pay.

### B2. Booking flow (rider app)
1. Vehicle list: `GET /users/intercity-packages` now returns, per vehicle, `advanceType` and `advanceValue` (show "Advance: 20%" or "Advance: Rs 500" if you like).
2. At confirm, call **quote**: `POST /rides/outstation/advance/quote` with the booking fields:

```json
{ "pickup": [75.8577, 22.7196], "drop": [77.4126, 23.2599], "vehicleTypeId": "...", "fare": 3000,
  "service_location_id": "(optional)", "tollAmount": 0,
  "intercity": { "packageId": "<package id>", "toCity": "Bhopal", "fromCity": "Indore", "tripType": "One Way" } }
```
-> `{ "required": true, "amount": 600, "remaining": 2400, "fare": 3000, "type": "percentage", "value": 20, "packageId": "..." }`.
   `required: false` -> book as before (no advance).
3. If required, show "Pay Rs {amount} now to confirm your booking. Rest Rs {remaining} after the ride. Refunded in full if the ride is cancelled."
4. **Order**: `POST /rides/outstation/advance/order` (same body) -> `{ advanceId, keyId, orderId, amount(paise), currency, advanceAmount, remaining, fare }`. Open Razorpay checkout.
5. **Verify**: `POST /rides/outstation/advance/verify` `{ advanceId, razorpay_order_id, razorpay_payment_id, razorpay_signature }` -> `{ advanceId, status: "paid", amount }`. Safe to repeat.
6. **Book**: `POST /rides` as before **plus** `advanceId`, and `intercity.packageId` (the package the fare came from). The scheduled outstation booking is the same call with `scheduledAt`.

If you skip the advance the booking is refused: **HTTP 402** with `code`:

| `code` | Meaning |
|---|---|
| `ADVANCE_REQUIRED` | no (or unpaid) advance. `details`: `{ amount, remaining, fare, packageId }` |
| `ADVANCE_MISMATCH` | the advance does not match this booking (the fare changed). `details.amount` is the new advance: pay again |
| `ADVANCE_ALREADY_USED` | that payment was already used for a booking |

One payment books **one** ride. A paid advance that is never used for a booking is **refunded automatically after about 30 minutes**. Leaving `packageId` out does not skip
the advance (the server finds the package by vehicle, city and destination).

### B3. After booking: what the apps show
Ride payloads (`GET /rides/:id`, the active-ride payload, socket ride events, driver offers) carry:

```json
{ "fare": 3000, "advance": { "amount": 600, "status": "applied", "paidAt": "..." },
  "advancePaid": 600, "amountDue": 2400 }
```
* `advance` is `null` on rides without one; `status` is `applied`, then `refunded` (or `refund_failed` while a refund is being retried).
* `amountDue` = fare minus advance = **what is left to pay after the ride**. (If a counter-offer raises the fare, `amountDue` follows it.)
* **Rider**: tracking card and receipt show Fare / Advance paid (online) / Balance. The "pay your fare" sheet (cash ride paid online later, tip + fare, wallet) charges **only `amountDue`**.
* **Driver**: show "Advance paid online Rs 600, **collect Rs 2400**" (also on the offer card). The UPI QR the driver shows must be for `amountDue`, not the fare.
* **Cancelled ride**: "Your advance of Rs 600 will be refunded" / "refunded".

### B4. Money rules after the ride (server side, automatic)
The platform holds the advance, so at settlement (when the ride is completed, cash-like):

| | Driver wallet | Driver gets |
|---|---|---|
| Solo driver on a pass (commission waived) | `+ advance` | advance in wallet + `amountDue` in cash = the whole fare |
| Solo driver on commission, 10% | `+ advance - commission` | e.g. fare 3000, advance 600: wallet `+300`, cash 2400 |
| Commission larger than the advance (30% = 900) | `advance - commission` is **negative** | wallet `-300` (a `commission_deduction`) |
| Fleet driver | the **owner** wallet gets the same figures; the driver wallet is not touched | |
| Rider pays the balance online afterwards | credited to the driver (owner for a fleet) as before | |

Wallet rows: `type: ride_earning` (positive) or `commission_deduction` (negative), `metadata.advancePaid`. A ride **without** an advance settles exactly as before.

### B5. Refunds
* Any cancelled ride (rider, driver, nobody found, admin): the **whole** advance goes back to the original Razorpay payment. It runs within a minute; if the gateway is down it is retried for a while.
* A ride that completed keeps its advance. Nothing for the apps to call: just show the status from `advance.status`.

---

## Part C. Admin setup (web only)
* **Admin > Settings > Bid Ride**: "Driver counter-offer": on/off, highest counter above the fare (%), counter step (Rs). Services: the existing list.
* **Admin > Pricing > Outstation Pricing** (new): one entry per destination with a row per vehicle: fare, commissions, and **Advance** (percentage or fixed, 0 = none).
  Without an outstation price row the rider app has nothing to book, so create these first.

## Part D. Test checklist
1. Counter: book a city ride at Rs 1000, a driver counters Rs 1050 and another Rs 1100: the rider sees both; picks one: the ride runs at that price; the other offer card closes.
2. Rider raises the fare to Rs 1100 while a Rs 1080 offer is waiting: that offer disappears, the Rs 1120 stays.
3. A driver sends Rs 1015 (step 10), Rs 1300 (limit 20%), Rs 1000: the three errors above.
4. Outstation with a 20% advance on a Rs 3000 fare: the rider must pay Rs 600 first; without it `POST /rides` is `402 ADVANCE_REQUIRED`.
5. Complete it with cash: the driver is asked to collect Rs 2400; the driver wallet shows the advance (minus commission).
6. Cancel an outstation ride: the advance is refunded in full and the ride shows "refunded".
7. A normal city ride, a rental and a share ride behave exactly as before.

## Part E. Not covered / known limits
* A driver cannot withdraw a counter-offer (send a new price to replace it; it expires when the ride is taken).
* The native full-screen offer card (killed app) only supports Accept / Reject, not the counter chips: the driver counters from the opened app.
* The advance is computed on the booking fare, not on a later counter-offer fare; the balance moves with the fare.
* Outstation prices must exist as price rows (package rows); the rider app does not offer outstation without them.
