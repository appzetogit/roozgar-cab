# Driver: more than one vehicle

A driver (for example a bike driver) can add more vehicles (for example a car). The admin approves
each new vehicle. The driver has one **active** vehicle at a time and receives ride requests **only
for the active vehicle's type**. To get the other type's bookings they switch vehicle.

The web driver app (`frontend/src/modules/driver/pages/settings/MyVehicles.jsx`) and the admin panel
(Drivers > Driver Vehicle Requests) are done. **The native driver app must call the APIs below** on its
Vehicle Details screen.

## How it works

- `GET /drivers/me` and the flat vehicle fields (`vehicleType`, `vehicleTypeId`, `vehicleNumber`, ...)
  always describe the **active** vehicle. Dispatch reads only these, so nothing else in the app changes.
- A new vehicle is a *request*. While it is pending nothing changes: the driver stays approved and online.
- After approval it appears in the driver's list but is **not** switched to automatically.
- Switching copies that vehicle into the flat fields, so the next ride requests are for its type.
- The existing `PATCH /drivers/vehicle` (edit current vehicle, needs re-approval) is unchanged and edits
  the active vehicle.
- Not available to fleet drivers (those with an `owner_id`) or drivers still waiting for first approval.
- At most 5 vehicles per driver (approved + pending).

## Driver APIs (`/api/v1/drivers`, driver token)

| Call | Purpose |
|---|---|
| `GET /vehicles` | `{ activeVehicleId, canAdd, vehicles[], requests[] }` |
| `POST /vehicles` | Ask to add a vehicle. Body: `vehicleTypeId` (or `vehicleTypeIds[]`), `vehicleNumber`, `vehicleColor`, optional `vehicleMake`, `vehicleModel`, `vehicleImage`, `documents` (`{name: url}`). 201 with the pending request. |
| `DELETE /vehicles/requests/:requestId` | Cancel a pending request |
| `POST /vehicles/:vehicleId/activate` | Switch the active vehicle. 409 while on a ride. Returns the same shape as `GET /vehicles` |
| `DELETE /vehicles/:vehicleId` | Remove a vehicle that is not active |

`vehicles[]` item: `id, isActive, vehicleTypeId, vehicleTypeIds, vehicleTypeName, vehicleType,
vehicleIconType, vehicleIconUrl, vehicleMake, vehicleModel, vehicleNumber, vehicleColor, vehicleImage`.
`requests[]` item: the same fields plus `status` (`pending` | `rejected`), `rejectionReason`, `createdAt`.

`GET /drivers/me` also returns `activeVehicleId`, `vehicleCount`, `pendingVehicleRequests`, `vehicleTypeIds`.

Errors are `{ success: false, message }`; show `message`. The vehicle number is validated server side
(for example `MH12AB1234`) and must not belong to another driver.

## Admin APIs (`/api/v1/admin`, admin token)

- `GET /drivers/vehicle-requests?status=pending|approved|rejected|all&search=&page=&limit=`
- `PATCH /drivers/vehicle-requests/:id/approve`
- `PATCH /drivers/vehicle-requests/:id/reject` with `{ reason }`

## Notifications to the driver

On approve or reject the driver gets a push and a socket event `driver:vehicle:updated`
(`type`: `driver_vehicle_approved` or `driver_vehicle_rejected`). Refresh `GET /vehicles` on either.

## Screen suggestion (native app)

Vehicle Details: list `vehicles` (badge on `isActive`, "Use this vehicle" on the others), list pending
`requests` as "Waiting for admin approval", and an "Add another vehicle" button when `canAdd`. After a
switch, reload `GET /drivers/me` so the app header shows the new active vehicle.

## Test

`Backend/scripts/testDriverVehicles.mjs` (throwaway Mongo only, see the file header).
