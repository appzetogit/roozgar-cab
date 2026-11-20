# Ride start PIN: now checked by the server

The rider's 4 digit PIN (`ride.otp`) is now checked by the server when the driver starts the trip. Before, any 4 digits started a ride.

## Behaviour
- Start with a **wrong** PIN: refused. REST: HTTP 400 `code: "WRONG_OTP"`, message "Incorrect trip PIN". Socket `ride:status:update`: `errorMessage` event with the same message. The ride stays `arriving`.
- After **5 wrong PINs** on one ride the start is locked for 5 minutes (HTTP 429, `WRONG_OTP`, "Too many wrong PINs, try again in a few minutes").
- Start with **no PIN** (an older app): still allowed, until the server flag `REQUIRE_TRIP_PIN=true` is set in `Backend/.env`. With it on, a missing PIN is HTTP 400 `OTP_REQUIRED` ("Trip PIN is required").
- A ride with no stored PIN is never blocked. A repeated `started` on a ride that already started is harmless. Share ride has its own PIN path and is unchanged.

## Where
`updateRideLifecycle({ ..., otp })` in `rideService.js` (all services: city, outstation, airport, parcel, rental). `PATCH /rides/:rideId/status` takes `otp` in the body; the socket event takes `otp` in its payload.

## Apps
- **Flutter driver app:** already sends `otp` on start. No change. Keep the local PIN check (instant feedback). Show the server message on `WRONG_OTP`.
- **Web driver app:** sends the PIN in the REST call and the socket event (`ActiveTrip.jsx`) and stays on the PIN screen if the server refuses.
- **Rider apps:** only show the PIN. No change.

## Turning the requirement on
Set `REQUIRE_TRIP_PIN=true` in `Backend/.env` and restart, only after every driver app in the field sends the PIN (old Flutter builds that do not send `otp` could not start rides).

## Known limit
The PIN is per rider (the same 4 digits on all of a rider's rides, `user.rideOtp`), so someone who has seen it once knows it. A PIN per ride would be a separate change.
