# Share Ride (Car Pooling), provider-run

Admin does **not** manage or price this. Owners and drivers run it; the rider asks for a seat; the admin
panel only *shows* what is happening. Built on its own collections and routes so no existing ride,
dispatch, wallet or subscription flow changes.

This replaces the old admin-managed fixed-route pooling for riders (that code and its data stay, hidden
from the menus and the rider tile).

## Actors and what each can do

| Actor | Can |
|---|---|
| **Rider (user)** | Ask for 1-4 seats from A to B, see the fare first, track the driver, share an OTP at pickup, cancel before pickup |
| **Independent driver** | See share requests that lie on the route of the ride/trip they are already on (or near them if idle), **add a request to their trip**, verify pickup with the rider's OTP, collect fare and complete, close the trip. Needs an active subscription pass |
| **Owner** | See all fleet share trips, riders and earnings; create a trip for a fleet driver; switch share rides on/off per fleet driver |
| **Admin** | Read-only monitor: live trips, riders, totals, anything stuck. No settings, no pricing, no approvals |

## Lifecycle

```
Rider request  -> searching  (expires in 20 min)
Driver adds it -> accepted   (seat claimed on the driver's ShareTrip, OTP shown to rider)
OTP at pickup  -> ongoing
Driver drops   -> completed  (fare collected cash/UPI by the driver, earnings settled)
```
Rider can cancel while `searching` or `accepted`. A driver can release an `accepted` rider (goes back to
`searching`). Trip: `open` (no one on board) -> `running` -> `completed` / `cancelled`.

One active trip per driver and one active share ride per rider (enforced by unique partial indexes).

Housekeeping happens lazily when things are read (there is no background job): an unanswered request
expires after 20 min; an `accepted` ride older than 6 h or an `ongoing` one older than 12 h is cancelled by
the system and its seat freed, so a vanished driver cannot lock a rider out. A trip a driver started just
by tapping "add" is retired as soon as its last rider leaves (owner-made trips are never auto-closed).

Privacy: before a driver accepts, the request shows only the rider's first name; the phone number appears
after accepting. The rider's OTP is shown only to the rider.

A driver with nothing running must be online to accept; a driver already on a trip or a normal ride may accept.
Quote calls are rate limited (60 per 5 min per IP, they use a billed routing service) and request creation
(10 per 10 min per rider), using the app's existing limiters.

## Matching ("add to my ride")

A request fits a trip when the rider's pickup **and** drop lie within **4 km** of the straight line
origin -> destination of the trip and the drop comes after the pickup along it.

The line comes from, in order: the driver's open/running ShareTrip; the driver's current normal ride
(accepted/ongoing, pickup -> drop); else the driver is idle and sees requests within 6 km of them.
Accepting creates the trip automatically (from the current normal ride, or from the driver's location
to the rider's drop). Seats: vehicle capacity - 1 (driver), minus 1 more when a normal ride is on board.

`isOnRide` and dispatch are **not touched**: a driver on a share trip can still be offered a normal ride
and may decline it.

## Money

* **Fare**, always computed on the server from the existing admin tariff (set-price) at the pickup point,
  for the cheapest car-class vehicle: `perSeat = (base + max(0, km - freeKm) x perKm) x (1 - 30%)`,
  `subtotal = perSeat x seats`, plus the tariff's rider platform fee (percentage of subtotal, or fixed once
  per ride). Distance is the routed distance (Google/OSRM), or straight line x 1.3 if routing fails.
  The 30% sharing discount is a constant in `shareRideFare.js` (`SHARE_DISCOUNT_PERCENT`), **not** an admin
  setting.
* **Payment**: the driver collects cash/UPI at drop (same as the normal ride collection). No online payment.
* **Settlement** (on completion, once, no transaction needed, safe on the standalone Mongo):
  * platform fee: always goes to Roozgar Cab (same as normal rides);
  * trip commission: **waived** when the driver has an active subscription pass covering that moment
    (and the admin "waive commission" switch is on); otherwise the same set-price commission as a normal ride;
  * `driverEarnings = fare - platformFee - commission`;
  * the driver's wallet is debited `platformFee + commission` (cash rides), exactly like a cash normal ride;
    the pass counters (`tripsCovered`, `commissionWaived`) are updated;
  * for a fleet driver the earnings count as the **owner's** earnings in the owner view (same rule the owner
    dashboard already uses for normal rides).
* A failed wallet write leaves `settlement.walletStatus = 'pending'`; the admin monitor lists those.

## API

All JSON, `{ success, data, message }`. Base `/api/v1`.

### Rider (user token)
| Call | Body / query | Returns |
|---|---|---|
| `POST /users/share-rides/quote` | `{ pickup:{lat,lng,address}, drop:{lat,lng,address}, seats }` | `{ available, reason?, distanceKm, seats, perSeat, subtotal, platformFee, total, discountPercent }` |
| `POST /users/share-rides` | same as quote | the ShareRide (fare recomputed by the server) |
| `GET  /users/share-rides` | `?status=active\|history` | list |
| `GET  /users/share-rides/:id` | | ShareRide with `trip`, `driver`, `vehicle`, `otp` |
| `POST /users/share-rides/:id/cancel` | `{ reason? }` | ShareRide |

### Driver (driver token)
| Call | Purpose |
|---|---|
| `GET  /drivers/share/status` | `{ eligible, reason?, trip, seatsFree, hasNormalRide, enabled }` |
| `GET  /drivers/share/requests` | open requests on my route/near me, each with `fit` info and `fare` |
| `POST /drivers/share/requests/:rideId/accept` | `{ tripId? }` add to my trip (creates it if needed) |
| `POST /drivers/share/rides/:rideId/pickup` | `{ otp }` rider on board |
| `POST /drivers/share/rides/:rideId/complete` | `{ collectedVia: 'cash'\|'upi' }` settles and returns the earnings breakdown |
| `POST /drivers/share/rides/:rideId/release` | hand an accepted rider back |
| `GET  /drivers/share/trip` | my current trip with its riders |
| `POST /drivers/share/trips/:id/complete` | close trip (no riders pending) |
| `POST /drivers/share/trips/:id/cancel` | cancel trip (no riders pending) |
| `GET  /drivers/share/earnings` | `?from&to` totals + recent rides |

### Owner (owner token)
| Call | Purpose |
|---|---|
| `GET  /drivers/fleet/share/overview` | totals: trips, riders, gross, platform fee, earnings, by driver |
| `GET  /drivers/fleet/share/trips` | fleet trips (`?status`) |
| `GET  /drivers/fleet/share/rides` | fleet share rides (`?status&page`) |
| `POST /drivers/fleet/share/trips` | `{ driverId, origin:{lat,lng,address}, destination:{...}, seatsTotal? }` |
| `POST /drivers/fleet/share/trips/:id/cancel` | cancel a fleet trip (no riders pending) |
| `PATCH /drivers/fleet/share/drivers/:driverId` | `{ enabled }` per fleet driver |

### Admin (admin token, read-only)
`GET /admin/share-rides/overview`, `GET /admin/share-rides/trips`, `GET /admin/share-rides/rides`
(`?status&search&page&limit`).

## Realtime

Socket events (driver room): `share:request:new`, `share:ride:updated`. Rider room: `share:ride:updated`.
Push is also sent for a new request (to drivers it fits) and for accept/pickup/complete (to the rider).
Apps may also poll the list endpoints every 8-10 s.

## Not built (on purpose)

Online payment for share rides, rider rating, in-trip chat, scheduled (future-time) share rides,
automatic backfill of old unsettled normal rides.

## Tests

* `Backend/scripts/testShareRide.mjs`: the rules (matching, fare, seats, races, OTP, settlement, owner, admin).
* `Backend/scripts/testShareRideHttp.mjs`: the real express app and auth (paths, roles, response shape,
  read-only admin, rate limit).

Both need a throwaway Mongo (see their headers). `Backend/scripts/setupShareRide.mjs` is the one-off live
setup (module icon/cover from images already on the server; `--pause-legacy` pauses the old demo pooling data).

## After deploying

deploy.sh runs `scripts/ensureIndexes.js`, which creates the indexes this module needs (production has
autoIndex off): the geo index on `ShareRide.pickup.location` and the two unique partial indexes.
