# Admin: new-booking alert sound and "Assign driver"

Two admin features, both additive. Share rides (car pooling) are **not** part of this; they have their own admin page and flow.
Applies to every booking type: city, airport, outstation, hourly rental, parcel / delivery.

## 1. New booking alert (admin panel)
When any such booking is created, the server sends the socket event **`new_booking`** to the admin room (`admin:broadcast`). The admin panel plays a chime
(a speaker button in the header turns it on or off; the choice is remembered), shows a card with the booking and two buttons (**Assign driver**, **View**), and refreshes the
Trips, Ongoing and Deliveries lists that are open.

Payload (all optional except `rideId`):

| Field | Example |
|---|---|
| `type` | `city`, `airport`, `outstation`, `rental`, `bike`, `auto`, or `parcel` |
| `kind`, `kindLabel` | `outstation`, `Outstation (Round trip, 3 days)` |
| `rideId`, `requestId` | `6b0a...`, `REQ_88AC3F08DD19` (`DEL_...` for a parcel) |
| `fare`, `pickupAddress`, `dropAddress`, `vehicleName` | |
| `userName`, `userPhone`, `paymentMethod`, `scheduledAt`, `days`, `createdAt` | |

Note: a browser allows sound only after the admin has clicked or typed on the page once. Until then the card still appears, silently.

## 2. Assign a driver to a booking (admin panel)
In Trips, Ongoing and Deliveries, a booking that is **still searching for a driver** has **Assign Driver** in its action menu (also from the alert card).
It opens the list of drivers who can take it **right now**:

- registered in the **zone of the rider's pickup** (the ride now stores `zone_id` at booking; for older rides the zone is found from the pickup point, and if there is none, the drivers of the booking's city),
- online, not on a ride, approved, not blocked,
- enrolled in the booked vehicle type (a driver with several vehicle types counts for each),
- able to take a ride (a pass, or the fleet owner's plan; wallet not blocked), and not blocked by an upcoming scheduled trip,
- rentals only to drivers who accept rentals.

Nearest to the pickup first. Choosing one gives the booking to that driver **exactly as if the driver had accepted it** (same function), so the search stops, other drivers'
offers close, the rider gets the usual "driver accepted" update, and the ride appears in the lists with `assignedBy: "admin:<name>"`.
A booking in the old driver-bid mode, one that already has a driver, or one that is cancelled or finished cannot be assigned (HTTP 409).

### Endpoints (admin token, permission `trips.view`)
| | |
|---|---|
| `GET /admin/ride-requests/:id/assignable-drivers` | `{ zone, drivers: [{ id, name, phone, vehicleNumber, vehicleName, rating, fleet, distanceKm }], total, note }` |
| `POST /admin/ride-requests/:id/assign-driver` body `{ driverId }` | `{ id, status, liveStatus, driver, assignedBy }` |

## 3. What the Flutter driver app must handle
The driver did not tap accept, so the app must open the trip itself. On assignment the driver receives:

- socket **`rideAccepted`** (the existing event: `rideId`, `status`, `liveStatus`, `otp`), and **`rideAssignedByAdmin`** (new: `rideId`, `serviceType`, `pickupAddress`, `dropAddress`, `fare`, `otp`, `assignedBy`),
- FCM push, `type: "ride_assigned_by_admin"`, with `rideId` and `serviceType` (a normal notification, not data-only).

Do: on either of these, fetch the active ride (`GET /rides/active/me`, `GET /deliveries/active/me` for a parcel) and open the trip screen, the same screen as after accepting.
From there the trip runs as any other (arrive, PIN, start, complete). Nothing else changes for the driver app. The web driver app already does this on `rideAccepted`.

## 4. Rider apps
No change. The rider gets the existing `rideAccepted` socket event and the `ride_accepted` push with the driver's details and the PIN.
