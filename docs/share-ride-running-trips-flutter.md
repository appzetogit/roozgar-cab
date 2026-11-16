# Share ride: "Running shared cabs" (rider app) and "Publish trip" (driver app)

For the Flutter developers of the **rider app** and the **driver app**. Everything here is **additive**: no existing endpoint, field or
push changes meaning. An app that ignores this document keeps working exactly as before.

## What the feature is

1. A **driver** can announce a run before leaving: "Indore to Ujjain, 3 seats free" (**Publish trip**).
2. Every **rider** sees such trips, and every trip already running (made by an owner, or created when a driver accepted a first rider),
   in a list of **Running shared cabs**. Tapping a card shows the driver, the vehicle, how many seats are free and the price per seat count.
3. The rider picks seats and taps **Join this ride**. The request goes **only to that trip's driver** (not broadcast to others).
   The driver accepts or declines from the usual offer card; the rest of the ride (OTP, pickup, drop, payment) is the normal share ride.

The old flow (rider fills pickup and drop, request goes to nearby drivers) stays as the second option on the same screen.

---

## A. Rider app

### A1. Home screen: two sections
- **Running shared cabs**: `GET /users/share-rides/trips` (below).
- **Request a custom ride**: the existing form (`vehicle-options`, `quote`, `POST /users/share-rides`). Unchanged.

### A2. List the running trips
`GET /users/share-rides/trips` (rider token)

| Query | Meaning |
|---|---|
| `pickupLat`, `pickupLng` | the rider's spot. Only trips whose route passes within `radiusKm` of it are returned |
| `radiusKm` | default 25, max 100 |
| `dropLat`, `dropLng` | with a pickup: only trips this rider could actually ride (same rule as booking) |
| `vehicleTypeId` | only trips of this vehicle type |

All optional. With none, you get every open trip (newest first, at most 30). Send the rider's current location to make the list local.

```json
{ "success": true, "data": { "count": 1, "trips": [ {
  "id": "6a...", "status": "open",
  "origin": { "address": "Indore", "lat": 22.7183, "lng": 75.8553 },
  "destination": { "address": "Ujjain", "lat": 23.1765, "lng": 75.7885 },
  "routeDistanceKm": 55.1,
  "seatsTotal": 3, "seatsTaken": 1, "seatsFree": 2,
  "vehicle": { "vehicleTypeId": "6a...", "type": "car", "name": "Maruti Dzire", "number": "MP09AB1234", "color": "white" },
  "driver": { "name": "Ramesh", "photo": "https://...", "rating": 4.8, "ratingCount": 120 },
  "perSeat": 280,
  "startedAt": null, "createdAt": "..."
} ] } }
```
- `status`: `open` (waiting for riders) or `running` (someone is on board).
- `perSeat` is the price of one seat over the **whole** trip route (a "from" price). The exact price for the rider's own
  pickup and drop comes from the detail call. It can be `null` when no fare is available.
- No phone number, rider names or earnings are ever returned here.
- Trips of drivers who cannot take share rides right now (no pass, owner plan ended, switched off) and empty trips of offline drivers are not listed.

### A3. Trip details (tap on a card)
`GET /users/share-rides/trips/:tripId?pickupLat=&pickupLng=&dropLat=&dropLng=` (rider token). The pickup/drop query is optional
and defaults to the trip's start and end (full route).

```json
{ "success": true, "data": {
  "id": "6a...", "status": "running", "...": "all the list-card fields",
  "pickup": { "lat": 22.7183, "lng": 75.8553 }, "drop": { "lat": 23.1765, "lng": 75.7885 },
  "distanceKm": 55.1,
  "seatOptions": [
    { "seats": 1, "perSeat": 280, "subtotal": 280, "platformFee": 14, "total": 294 },
    { "seats": 2, "perSeat": 280, "subtotal": 560, "platformFee": 28, "total": 588 }
  ],
  "canJoin": true, "code": "", "reason": ""
} }
```
- Show the map (origin to destination), the seat grid (`seatsTaken` filled, `seatsFree` empty), the driver and vehicle, and a seat stepper
  limited to `seatOptions.length`. The price shown for the chosen count is that row's **`total`** (`subtotal` + platform fee).
- `canJoin: false` -> disable the button and show `reason`. Codes: `NO_FREE_SEATS`, `NOT_ON_ROUTE`, `PICKUP_PASSED` (the cab is already past that
  pickup), `FARE_UNAVAILABLE`.
- 404 `TRIP_NOT_AVAILABLE`: the trip ended meanwhile. Go back to the list.
- Refresh the detail when the screen opens and before the button is enabled; seats change as other riders join.

### A4. Join the trip
`POST /users/share-rides` with the **same body as today plus `tripId`**:

```json
{ "tripId": "6a...", "seats": 2 }
```
- `pickup` and `drop` (`{ lat, lng, address }`) are optional here: they default to the trip's start and end. Send them if the rider chose
  their own points on the way (they must be on the trip's route).
- `vehicleTypeId` is ignored for a trip: the trip's own vehicle sets the price. **The fare is always computed by the server.**
- Response is the normal ride object (status `searching`) with `requestedTripId` set. The rider then waits exactly like today: socket
  `share:ride:updated` and the push types below, or poll `GET /users/share-rides/:id`.

| Push `type` to the rider | Meaning |
|---|---|
| `share_accepted` | the driver accepted: show driver, vehicle and the OTP (as today) |
| `share_declined` (**new**) | the driver said no: the ride is already cancelled, show "pick another trip" |
| `share_cancelled` | now also sent when the trip itself ended before the driver answered (`cancelReason`: "This trip is no longer running") |
| `share_started`, `share_completed` | as today |

Errors of the booking call (`code` in the JSON body):

| HTTP | code | Show |
|---|---|---|
| 404 | `TRIP_NOT_AVAILABLE` | "This trip is no longer running" |
| 409 | `NO_FREE_SEATS` | seats were taken meanwhile: refresh the detail |
| 409 | `NOT_ON_ROUTE` | the chosen pickup/drop is not on this route |
| 409 | `PICKUP_PASSED` | the cab is already past the pickup |
| 409 | `RIDE_IN_PROGRESS` | the rider already has an active share ride (as today) |
| 400 | `SEATS_EXCEED_CAPACITY`, `VEHICLE_NOT_AVAILABLE` | as today |

A rider has one active share ride at a time, so while a request is waiting the Join button on every trip should be disabled
("You already have a request in progress").

---

## B. Driver app

### B1. Publish a trip (new)
`POST /drivers/share/trips` (driver token)

```json
{ "origin": { "lat": 22.7183, "lng": 75.8553, "address": "Indore" },
  "destination": { "lat": 23.1765, "lng": 75.7885, "address": "Ujjain" },
  "seatsTotal": 3 }
```
`seatsTotal` is optional (default and maximum: the vehicle's seats minus the driver's own seat). Returns `201` and the trip object, the same
shape as `GET /drivers/share/trip`, now also with `"published": true`.

Add a **"Publish trip"** button to the Share Rides home, next to what an owner already has (the owner's create-trip screen is the same form).
Only when the driver has no active share trip (`GET /drivers/share/status` -> `trip == null`).

| HTTP | code | Show |
|---|---|---|
| 403 | `SUBSCRIPTION_REQUIRED` | buy a pass (`canBuyPass`) |
| 403 | `OWNER_STOPPED`, `DISABLED_BY_OWNER`, `NOT_SHARE_VEHICLE` | the `reason` text |
| 403 | `GO_ONLINE_REQUIRED` | go online first |
| 409 | `TRIP_ALREADY_ACTIVE` | open the running trip instead |
| 409 | `RIDE_IN_PROGRESS` | finish the normal ride first |
| 409 | `NO_FREE_SEAT` | this vehicle has no seat to share |
| 400 | `ROUTE_TOO_SHORT`, `INVALID_LOCATION` | fix the points |

### B2. What changes for a published trip
- It **stays open** when its last rider is dropped (a trip made automatically by accepting a rider still closes by itself, as before).
  The driver closes it with the existing `POST /drivers/share/trips/:id/complete` or `.../cancel` (409 `RIDERS_ON_TRIP` while riders are on board).
- An empty trip with no activity for 120 minutes is closed by the server (existing `share_trip_expired` push).
- Riders see it in their list only while the driver is **online** (or has riders on board).

### B3. Requests from riders who picked this trip
They arrive as the usual `share_request` push / `share:request:new` socket event and in `GET /drivers/share/requests`, so the offer card
and voice need **no change**. Differences:
- Only this driver is offered it. Other drivers never see it.
- The request object has `requestedTripId`. Accept with the existing `POST /drivers/share/requests/:rideId/accept`.
- Reject now ends the rider's request immediately (the rider gets `share_declined`).
- New accept error: 409 `TRIP_NOT_AVAILABLE` (the trip was closed before the answer); show the same message as `EXPIRED`.
- A rider who picked the trip joins **that** trip: the driver's active trip is used automatically (a driver has one at a time).

---

## C. Not changed (nothing to do)
Vehicle options, quote, normal share request flow, OTP and pickup, completion and wallet settlement, offer card payloads, owner trips and billing,
all other services (city rides, outstation, rental, parcel).

## D. Test pass (about 10 minutes)
1. Driver A (online, with pass): Publish trip Indore to Ujjain, 3 seats. A appears in rider B's list; rider C (other city) does not see it with `pickupLat/Lng` set.
2. B opens the card: 3 seat options, price grows with seats. Join with 2 seats: only A gets the offer card. Another online driver gets nothing.
3. A accepts: B sees driver, vehicle, OTP. Card seats now show 1 free; rider C sees `seatsFree: 1`, joining with 2 seats gives `NO_FREE_SEATS`.
4. A rejects a request: the rider gets `share_declined` and can ask again.
5. A completes B's ride: the trip stays in the list. A closes it: pending requests cancel with "This trip is no longer running".
6. A normal share request (old flow) still reaches nearby drivers and works as before.

## E. Known limits
- No departure time on a trip: it is "leaving now"; it expires after 120 idle minutes.
- The driver position is only used to refuse a pickup the cab has passed; there is no live "cab is here" on the card.
- The price on the list card is for the whole route; the exact price is on the detail call and, finally, in the booked ride.
