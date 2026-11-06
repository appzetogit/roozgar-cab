# Server fare quote (city rides and parcel delivery), Flutter guide

Until now the app worked out the fare itself and the server stored whatever it sent. On live data the same trip came out at two
different prices (XL, 11.2 km: Rs 298 charged vs Rs 336 from the admin tariff) because the app and the server measure a different
distance (the app about 9.4 km, the server's stored route 11.2 km). The server now answers with the price **from the admin's tariff**
so the apps can show exactly that. Base URL `https://roozgarcab.com/api/v1`, rider token, responses `{ success, data }`.

## 1. City / airport / bike / auto: `POST /rides/quote`
Body: `{ "pickup": [lng, lat], "drop": [lng, lat], "vehicleTypeIds": ["..."] }` (leave `vehicleTypeIds` out for every vehicle). Optional:
`zone_id`, `service_location_id` (the server finds them from the pickup), `estimatedDistanceMeters` / `estimatedDurationMinutes` (used
only if the server cannot route).

```json
{ "serviceType": "ride", "category": "city", "distanceMeters": 11210, "durationMinutes": 13, "routeSource": "google",
  "quotes": [ { "vehicleTypeId": "...", "name": "Roozgar XL (XL6)", "available": true, "setPriceId": "...",
      "distanceKm": 11.21, "durationMinutes": 13, "baseDistanceKm": 2, "basePrice": 110, "extraKm": 9.21, "distanceAmount": 184.2,
      "timeAmount": 26, "subtotal": 320.2, "serviceTaxPercent": 5, "tax": 16.01, "fareBeforeSurge": 336,
      "surgeMultiplier": 1, "surgeAmount": 0, "platformFee": 0, "airportFee": 0, "total": 336 },
    { "vehicleTypeId": "...", "name": "...", "available": false, "reason": "No tariff for this area" } ] }
```
Formula (same as the web app): within `baseDistanceKm` only `basePrice`; beyond it `basePrice + extraKm * price per km + trip minutes * time price`,
then service tax %, then surge, then the rider platform fee and the airport fee. `total` is the amount to show.

**What to do:** call it when the rider has picked pickup and drop, show `total` per vehicle, and send **that same number** as `fare` in
`POST /rides`. Today the server still accepts the app's `fare`, but it records its own quote on the ride (`pricingSnapshot.serverQuote`) and flags
`fareMismatch` when the two differ by more than max(Rs 5, 5%); the admin sees it in the request details ("Server tariff fare" / "Difference").

## 2. Parcel / delivery: `POST /deliveries/quote`
Body `{ "vehicleTypeId": "...", "pickup": [lng, lat], "drop": [lng, lat] }` -> `{ total, subtotal, baseDistanceKm, serviceTaxPercentage,
serviceTaxAmount, distanceKm }`. `400` means the server refuses the trip (another city, no delivery tariff): show the message, do not show a price.
The parcel booking is charged this price (the pickup zone's delivery tariff first, the vehicle's own tariff as the default).

## 3. Outstation
Not part of this: the outstation fare is the admin's package row (one way; round trip x1.8) plus the route's tolls; see
`driver-counter-offer-and-outstation-advance-flutter.md`.

## 4. Test
1. A city ride: the price on the vehicle card equals `quotes[].total` and the booked `fare`.
2. A trip in a city with no tariff: `available: false` and the reason, no price.
3. A parcel in a city without delivery vehicles: `400` with a message.
