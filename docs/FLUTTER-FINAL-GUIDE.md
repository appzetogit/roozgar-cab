# Roozgar Cab: everything new in the backend, and what Flutter has to change (final guide)

One page for the Flutter developers of the **rider app** and the **driver app** (the owner role lives inside the driver app). Each section
says what the feature is, what to change in the apps, and which document has the endpoints, JSON and error codes. Everything below is
**live on https://roozgarcab.com/api/v1** unless marked "after deploy". The web apps already use all of it: the web screens are a working reference.

Detail documents (same folder): `share-ride-flutter.md`, `owner-billing-flutter.md`, `driver-counter-offer-and-outstation-advance-flutter.md`,
`share-rental-offer-push.md`, `server-fare-quote-flutter.md`, `driver-multi-vehicle.md`, `share-ride-running-trips-flutter.md`, `outstation-multi-day-flutter.md`.

---

## 0. Checklist (what to build, in one list)

| # | Area | App | Change |
|---|---|---|---|
| 1 | Owner plan / commission | Driver app (owner) | New "Plan & billing" screen, red "service stopped" banner, wallet activity |
| 2 | Owner billing | Driver app (fleet driver) | Hide the daily-pass screen, show the server's 403 message, handle push `owner_subscription_expired` |
| 3 | Share ride | Both | Stable `code`s, vehicle choice, seats rule, new push/socket events, history |
| 4 | Offer card + voice | Driver app (native) | Data-only pushes `share_request`, `share_request_closed`, rental fields |
| 5 | Driver counter-offer | Driver + rider | Counter chips on the offer, "Driver offers" list for the rider |
| 6 | Outstation advance | Rider (+ driver display) | Pay the advance before booking, show balance due, refund state |
| 7 | Server fare quote | Rider | Show `POST /rides/quote` total instead of a local formula |
| 8 | Parcel | Rider | Show `POST /deliveries/quote`, handle 400 "not available here" |
| 9 | Hourly rental | Rider + driver | Package list, booking, driver toggle |
| 10 | Cancellation fee | Rider | Show the fee before cancelling (outstation/rental/city) |
| 11 | Login | Both | Nothing (OTP is server side); two demo numbers use 1234 |
| 12 | Outstation multi-day | Rider + driver | Days stepper on a round trip, send `days`/`returnDate`, show the extra-day bill; driver offer shows `tripDays` (see `outstation-multi-day-flutter.md`) |

---

## 1. Owner plan or commission (driver app, owner role)
An owner's fleet works on a **plan** (no commission, no pass per driver) or on **commission**. When a plan ends the owner and all their drivers get no
rides until they renew or switch to commission. Ride money for a fleet driver goes to the **owner wallet**, not the driver wallet.
**Do:** screen "Plan & billing" (status banner, Plan/Commission switch with a confirm dialog, plan cards with Buy from wallet or Razorpay,
history, wallet activity), plus a red banner on the owner home when `serviceActive == false`. Endpoints: `GET /drivers/owner/billing`,
`POST /drivers/owner/billing/subscribe`, `POST .../razorpay/order|verify`, `PUT .../mode`, `GET .../history`, `GET /drivers/owner/wallet/history`.
Detail: `owner-billing-flutter.md` (sections 1 to 5).

## 2. Fleet drivers (driver app)
Fleet drivers (`owner_id` set on `GET /drivers/me`) **never buy a pass**: hide that screen. `GET /drivers/me` now has `ownerServiceActive` and
`ownerServiceReason`. Going online / accepting returns **403** with the owner's message while the owner's service is stopped; the push
`owner_subscription_expired` means the server already set the driver offline. Detail: `owner-billing-flutter.md` section 6.

## 3. Share ride (both apps)
- **Codes:** every share error has a stable `code` (`SUBSCRIPTION_REQUIRED`, `OWNER_STOPPED`, `NOT_SHARE_VEHICLE`, `REQUEST_TAKEN`, `NO_FREE_SEATS`, `VEHICLE_MISMATCH`, `WRONG_OTP`, ...). `GET /drivers/share/status` returns `code` and `canBuyPass`.
- **Rider chooses the vehicle:** `POST /users/share-rides/vehicle-options` (cards with `maxSeats`, `perSeat`, `nearbyDrivers`, `available`), then `vehicleTypeId` in quote and create. Seats are capped by the vehicle (`400 SEATS_EXCEED_CAPACITY`).
- **Every vehicle except bikes** can run share rides (autos too).
- **Matching rule:** a driver with a route is offered only the riders on that route (corridor about 15% of the route, 1.5 to 4 km, no riders going past the destination); a request is never offered to a driver with fewer free seats than it needs.
- **Trip lifecycle:** an empty driver-made trip closes by itself when the last rider is dropped; an idle empty trip expires after 120 minutes (`share_trip_expired`).
- **Owner actions notify the driver:** `share_trip_assigned`, `share_trip_cancelled`, `share_enabled_changed`; socket `share:trip:updated`, `share:status:changed`.
- **History:** `GET /drivers/share/rides?status=finished&page=1&limit=20`.
- **Fleet share money** settles to the **owner** wallet (plan: no commission; commission mode: the owner commission).
- **Running shared cabs (new):** riders can browse trips that are already running or published ("Indore to Ujjain, 2 of 3 seats free"), open one, see seats and the price,
  and join it; only that trip's driver is asked. Drivers get a **Publish trip** button. Endpoints: `GET /users/share-rides/trips`, `GET /users/share-rides/trips/:id`,
  `POST /users/share-rides` with `tripId`, `POST /drivers/share/trips`. Detail: `share-ride-running-trips-flutter.md`.
Detail: `share-ride-flutter.md` plus the notification list in `share-rental-offer-push.md`.

## 4. Full-screen offer card with voice (driver app, native)
The voice is on-device text to speech. The server sends **data-only, high-priority** FCM pushes (all values strings):
- `share_request`: `shareRideId`, `shareTripId`, `riderName`, `seats`, `fare`, `pickupAddress`, `dropAddress`, `pickupDistanceKm`, `expiresInSeconds`.
  Addresses are real text (a placeholder becomes "the pickup point"). Repeats keep the same `shareRideId`: do not restart the voice.
- `share_request_closed` (`shareRideId`): stop the card and the voice (taken by another driver, rider cancelled, expired, owner stopped).
- Answer from the card with the driver token only: `POST /drivers/share/requests/:id/accept|reject` (safe to repeat); errors carry `details.cardCode`
  (`ALREADY_HANDLED`, `EXPIRED`, `SEATS_EXCEED_CAPACITY`, `OWNER_STOPPED`).
- **Rental offers** are normal `ride_request` pushes with `serviceType: "rental"`, `packageHours`, `packageKm`, `fare`, and an **empty `dropAddress`**
  (do not read a drop aloud). The socket offer keeps `serviceType: "hourly_rental"` plus the same two fields.
Detail: `share-rental-offer-push.md`.

## 5. Driver counter-offer (driver + rider)
A driver may answer a ride offer with a **higher price**; the rider picks one offer (the ride then runs at that price). Admin controls it (on/off, percent above the fare,
step). **Driver:** offer payloads carry `counter: { enabled, options[], minFare, maxFare, stepAmount }`; show chips from `options`, send
`POST /drivers/ride-offers/:rideId/bid { bidFare }`. **Rider:** `GET /rides/:id/bids` (cheapest first) + socket `rideBidUpdated`, accept with
`POST /rides/:id/bids/:bidId/accept`; show the list whenever `ride.driverCounter.enabled`. Errors: `COUNTER_TOO_LOW|TOO_HIGH|STEP|NOT_AVAILABLE|STALE`.
Detail: `driver-counter-offer-and-outstation-advance-flutter.md` Part A.

## 6. Outstation advance (rider; driver sees the balance)
Before an outstation booking exists the rider pays an admin-set advance online: `POST /rides/outstation/advance/quote` -> `.../order` (Razorpay) -> `.../verify`, then
`POST /rides` with `advanceId` and `intercity.packageId`. Without it the booking is refused with **402** (`ADVANCE_REQUIRED`, `ADVANCE_MISMATCH`, `ADVANCE_ALREADY_USED`).
The quote also returns the route **tolls** (`tolls`): show "Fare before tolls" and "Toll charges". After booking, ride payloads carry `advance`, `advancePaid`,
`amountDue`: the rider pays only `amountDue` after the ride; the **driver collects only `amountDue`** (also the UPI QR amount). A cancelled ride refunds the whole advance
automatically (show `advance.status`: `applied` / `refunded` / `refund_failed`). Outstation fare is flat (admin package row; round trip x1.8) plus tolls.
Detail: `driver-counter-offer-and-outstation-advance-flutter.md` Part B.

## 7. Server fare quote (rider)
**Why:** the app and the server measured different distances (the app about 9.4 km, the server route 11.2 km) so the same trip was charged differently
(XL: Rs 298 charged vs Rs 336 on the admin tariff). **Do:** call `POST /rides/quote` once pickup and drop are known, show each vehicle's `total`, and send that same
number as `fare` in `POST /rides`. The server records its own quote on every booking and flags a difference above max(Rs 5, 5%) for the admin (it does **not**
change what is charged yet; enforcing it is a product decision for later). Detail: `server-fare-quote-flutter.md`.

## 8. Parcel / delivery (rider)
Delivery vehicles now exist (Delivery Bike, Auto, Mini Truck) with prices per zone. Price with `POST /deliveries/quote { vehicleTypeId, pickup, drop }`; a **400** means "not
available here" (show its message, no price). The booking is charged that quote. Proof photos (pickup and delivery) are required by the driver app before the status changes.
Detail: `server-fare-quote-flutter.md` section 2.

## 9. Hourly rental
- **Rider:** `GET /users/hourly-rental-packages` (packages with a price per vehicle, included km/minutes, extra km and minute rates, `cancellationFee`);
  book with `POST /rides` `serviceType: "hourly_rental"`, `vehicleTypeId`, `rental: { packagePriceId }` (the fare is the admin's package price, whatever the app sends).
  Extra km and minutes are billed when the driver taps **arrived** (the clock stops there); show the package usage and the billed extras on the trip and the receipt.
- **Driver:** `GET/PUT /drivers/me/rental-preference` (`accepts`): a driver gets rentals only while it is on and the admin has not blocked it. A rental cannot be ended
  before it was started (`409`). Rentals are never negotiated (no counter-offers) and carry no surge.

## 10. Cancellation fee (rider; after deploy of the latest commit)
A rider who cancels **after a driver accepted** pays the admin's fee; before that, nothing. City: the tariff row (user fee). **Outstation and hourly rental: the package row's
`cancellation_fee`** (flat rupees; starting values Rs 200 outstation, Rs 100 rental, editable in the admin). Show the fee in the cancel dialog (rental packages already return
`cancellationFee`). An outstation advance is **always refunded in full**; the cancellation fee is charged separately from the rider wallet.

## 11. Login (OTP)
Nothing to change. OTP is server side (SMSIndiaHub). Two test numbers always log in with `1234`: **1111111111 (rider)** and **2222222222 (driver)**. Until the admin switches
`USE_DEFAULT_OTP=false`, everyone logs in with `1234` on the live server.

## 12. Outstation multi-day round trip (rider + driver)
The rider can keep the cab for several days on a round trip. Price = round trip price (base x 1.8) + the admin's price for every extra day; the server prices it, tolls on top,
advance on the whole fare. Days kept beyond the booked ones are billed when the driver ends the trip. Apps: a "Number of days" stepper, `days` and `returnDate` in the `intercity` object of
the advance quote, order and booking, the extra-day line on the receipt, and the driver offer fields `tripDays`/`returnDate`. Detail: `outstation-multi-day-flutter.md`.

---

## Test pass for Flutter (about 20 minutes)
1. Owner with no plan: banner, fleet driver gets the 403 message; buy a plan from the wallet: fleet works.
2. Share ride: choose a vehicle, request 1 seat more than allowed (error code), accept from the killed-app card, reject, rider cancel closes the card.
3. Counter-offer: two drivers offer, rider picks one, ride fare equals the offer.
4. Outstation (Indore to Ujjain): advance sheet (with tolls line), book, complete in cash: driver collects `amountDue`; cancel another: advance refunded.
5. City ride: price on the card equals `/rides/quote` total and the booked fare.
6. Parcel in Indore: price from `/deliveries/quote`; in a city without delivery vehicles: the 400 message.
7. Rental: book 1 hour, driver arrives after 90 minutes: extra minutes billed; cancel after accept: fee from the package row.

## Not in the apps yet (known limits)
- No return date, waiting charge or night allowance for outstation; the fare is flat for the quoted distance.
- Server fare is a quote, not enforced.
- The native card (killed app) only has Accept / Reject; counter chips need the opened app.
