# Share Ride and Hourly Rental: full-screen offer card + voice (backend contract, implemented)

The voice is on-device text-to-speech. The backend only sends a **data-only, high-priority FCM push** (no `notification`
block) so a killed or locked phone wakes into the native card. All values are strings.

## Share Ride

**Offer** (`type: "share_request"`): sent to each driver separately (distance differs per driver), and the same fields on the
socket event `share:request:new`.

```json
{ "type": "share_request", "rideId": "<id>", "shareRideId": "<id>", "shareTripId": "<driver's open trip id or empty>",
  "riderName": "Amit", "seats": "2", "fare": "180", "pickupAddress": "Sector 62, Noida", "dropAddress": "Connaught Place, Delhi",
  "pickupDistanceKm": "1.2", "expiresInSeconds": "30", "title": "Share ride request", "body": "2 seats on your way, Rs 180" }
```

* `rideId` and `shareRideId` are the same id (kept for older app builds). A re-sent wave for the same request keeps the id.
* Addresses are never empty or "Selected on map": a placeholder becomes "the pickup point" / "the drop point".
* `expiresInSeconds` = `SHARE_OFFER_SECONDS` (default 30) or the time the request has left, whichever is smaller.
* `pickupDistanceKm` is empty when the driver has no GPS fix.

**Closed** (`type: "share_request_closed"`, `shareRideId`, `rideId`; socket `share:request:closed`): sent to every driver that got the
offer when the request is accepted by another driver (not the one who accepted), cancelled by the rider, expired, or when the
owner switches share off / the owner's plan ends for that driver (that driver's cards only).

**Who is offered a request** (same rule for the push, the socket event and `GET /drivers/share/requests`):
* the vehicle type the rider chose; not bikes; allowed to take share rides (a pass, or a serving owner);
* **enough free seats for this request**: a driver whose car has 4 seats, 2 already booked and 2 left sees requests of 1 or 2
  seats, never 3 or more. Idle driver: capacity minus the driver. Driver on a normal ride: capacity minus 2.
* location: a driver with riders on board only sees requests along their route; a driver with an empty trip and a live GPS fix
  also sees requests next to them; a driver on a normal ride only along that ride; an idle driver, requests next to them.

**Answering from the card** (driver token only; safe to repeat):
* `POST /drivers/share/requests/:shareRideId/accept` : the driver who already holds the ride gets the same `200` again
  (`alreadyAccepted: true`); no second seat is taken.
* `POST /drivers/share/requests/:shareRideId/reject` : hides it for this driver, `200` even if the request is gone or already rejected.
* Errors carry `code` (kept for the apps) and a card code in `details.cardCode`:

| `code` | `details.cardCode` |
|---|---|
| `REQUEST_TAKEN` | `ALREADY_HANDLED` |
| `REQUEST_EXPIRED` | `EXPIRED` |
| `NO_FREE_SEATS` | `SEATS_EXCEED_CAPACITY` |
| `OWNER_STOPPED` | `OWNER_STOPPED` |

## Hourly Rental

Rental offers are normal `ride_request` pushes (and socket offers) with a few changes:

```json
{ "type": "ride_request", "serviceType": "rental", "packageHours": "4", "packageKm": "40", "fare": "1200",
  "pickupAddress": "...", "dropAddress": "" }
```

* `serviceType` is `"rental"` in the **push** (the socket offer keeps `hourly_rental` and gets `packageHours` / `packageKm` too).
* `fare` is the package price; `pickupAddress` is the pickup (the offer push already carried both).
* `dropAddress` is empty for a rental. `packageHours` is trimmed ("4", "1.5").
* Accept / reject are the existing `/drivers/ride-offers/:id/accept|reject`.

Spoken text is built on the app side.
