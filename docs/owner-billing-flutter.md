# Owner billing (Plan or Commission), Flutter integration guide

For the Flutter developers of the **Roozgar Cab driver app** (the owner role lives inside the driver app). Everything
here is **live in the backend** (commit `db6c22d` and later). The JSON examples were captured from the real running API
by the automated test (`Backend/scripts/testOwnerBilling.mjs`), not written by hand. The web app already uses all of it:

| Role | Web reference |
|---|---|
| Owner | `frontend/src/modules/driver/pages/OwnerBilling.jsx` (new), `OwnerDashboard.jsx` (banner/card) |
| Fleet driver | no new screen, only new error messages (section 6) |
| Solo driver | nothing new on screen (section 7), but earnings now really arrive in the wallet |
| Admin | web only, **nothing to build in Flutter** (section 11) |

Backend: `Backend/src/modules/taxi/driver/services/ownerBillingService.js`, `walletService.js`
(`settleCompletedRideWallet`), `matchingService.js`. Base URL: `https://roozgarcab.com/api/v1`.
All responses are `{ "success": true, "data": ... }` or `{ "success": false, "message": "...", "details": null }`.

---

## 0. TL;DR, what you build

1. **Owner screen "Plan & billing"** (owner token): status banner, Plan/Commission switch, plan cards with Buy,
   purchase history, wallet activity. 6 endpoints (section 4).
2. **Owner dashboard**: a card that turns into a red "Service stopped" banner when `serviceActive == false`.
3. **Fleet driver app**: show the server's message when going online / accepting fails with 403 (section 6), and
   handle one push type `owner_subscription_expired`.
4. **Fleet drivers never buy a pass any more.** Hide the pass screen for a driver whose profile has `owner_id`.
5. Nothing changes for riders.

---

## 1. The idea in plain words

There are two kinds of drivers and they pay the platform differently:

| | Pays the platform with | Who buys it | Commission |
|---|---|---|---|
| **Solo driver** (no owner) | their own daily / weekly / monthly **pass** | the driver | none while the pass is active |
| **Fleet driver** (linked to an owner, `owner_id` set) | **nothing of their own** | the **owner** | decided by the owner's mode |

An **owner** chooses one of two modes (`mode`):

* **`subscription`** (default): the owner buys a **plan**. While it is active the **whole fleet works**, **no
  commission** is charged, and no driver needs a pass.
* **`commission`**: no plan. The fleet works and the platform keeps the admin-set **owner commission** on every fleet
  ride.

**When a plan ends** and the owner is still in `subscription` mode, the **owner and all their drivers get no
service**: no ride requests, drivers cannot go online or accept, share-ride is off. It starts again when the owner
**renews** the plan or **switches to `commission`**. A plan is a fixed window; nothing runs at expiry, the server just
compares `expiresAt` with now (a background job also takes the fleet offline and pushes drivers within ~5 min).

Existing owners start in `subscription` mode with **no plan**, so their fleet is stopped until they buy a plan or choose
commission.

---

## 2. Money rules (this is the part to get right on screen)

Per completed fleet ride, server side (`settleFleetRide`), `fare` is the ride fare:

```
platformFee        = rider platform fee inside the fare (0 if the app does not charge one)
tripCommission     = owner commission on (fare - tolls)      // % of fare, or fixed Rs, set by admin
commission waived  = owner has an ACTIVE plan at completion  // then tripCommission is not charged
commissionAmount   = min( (waived ? 0 : tripCommission) + platformFee , fare )
ownerEarnings      = fare - commissionAmount
```

What moves in the **owner wallet**:

| Ride paid by | Owner wallet | Ledger row |
|---|---|---|
| **online** (money reached the platform) | `+ ownerEarnings` | `type: ride_earning`, `kind: credit` |
| **cash / UPI to the driver** (money stayed with the driver) | `- commissionAmount` | `type: commission_deduction`, `kind: debit` |
| cash and `commissionAmount == 0` | no change | no row |

* The **fleet driver's own wallet is not touched** by a fleet ride (no `ride_earning` / `commission_deduction` for
  them). Fleet drivers are paid by their owner (salary); the app already says "Monthly salary and wallet activity".
* `ride.driverEarnings` = `ownerEarnings`; `ride.commissionAmount` = what the platform kept; `ride.ownerId` is set.
* Settlement runs **once per ride** (`walletSettledAt`), so repeating the call never double-pays.
* Examples with 10% owner commission: online Rs 500 on commission mode -> owner `+450`. Cash Rs 500 on commission mode
  -> owner `-50`. Any ride while a plan is active: commission 0 (online Rs 600 -> `+600`, cash -> no change).
* Tolls inside the fare are never commissioned.

The owner dashboard (`GET /drivers/fleet/dashboard`, unchanged) keeps working: `earnings.ownerEarnings` is the sum
of `driverEarnings` of completed fleet rides and `earnings.walletBalance` is the owner wallet.

---

## 3. States of an owner

`GET /drivers/owner/billing` returns `mode` and `serviceActive`:

| mode | live plan? | `serviceActive` | Fleet works? |
|---|---|---|---|
| `subscription` | yes | `true` | yes, no commission |
| `subscription` | no (never bought / expired) | `false` | **no** |
| `commission` | any | `true` | yes; commission waived only while a plan is also live |
| (owner deleted / `active:false`) | - | `false` | no |

Buying a plan sets `mode` back to `subscription`. Switching mode does not cancel a running plan (it keeps covering).
You cannot buy a second plan while one is active (409); renew after it ends.

---

## 4. Owner endpoints (header `Authorization: Bearer <owner token>`)

A **driver** token gets `403` here, no token gets `401`.

### 4.1 `GET /drivers/owner/billing`  (the screen's one call)

```json
{
  "success": true,
  "data": {
    "mode": "subscription",
    "serviceActive": false,
    "reason": "Your subscription has ended. Renew it or switch to commission to get your fleet working again.",
    "walletBalance": 0,
    "paymentMethods": ["wallet", "gateway"],
    "currentCycle": { "startsAt": "2026-11-02T00:30:00.000Z", "expiresAt": "2026-11-03T00:30:00.000Z" },
    "subscription": null,
    "plans": [
      { "id": "6ae85080f9e23d343e1dd162", "name": "Fleet Monthly", "description": "Whole fleet", "amount": 1000, "durationDays": 30, "howItWorks": "" }
    ],
    "commission": { "percentage": null, "fixedPerRide": null }
  }
}
```

* `subscription` is `null` when no plan is live, else `{ id, planName, amount, startsAt, expiresAt, paymentMethod }`.
* `commission.percentage` / `fixedPerRide` are `null` or `{ "min": 10, "max": 10 }` (the range of admin-set owner
  commission over all normal price rows). Show "10%" when `min == max`, else "10 - 12%".
* `reason` is `""` when the service is active.
* `paymentMethods` tells you which of wallet / gateway (Razorpay) to offer.

### 4.2 `POST /drivers/owner/billing/subscribe`  (pay from the owner wallet)

Body `{ "planId": "...", "paymentMethod": "wallet" }`. The wallet is debited atomically.

```json
{ "success": true, "data": {
  "subscription": { "planName": "Fleet Monthly", "amount": 1000, "startsAt": "2026-11-02T00:30:00.000Z",
                    "expiresAt": "2026-12-02T00:30:00.000Z", "status": "active", "paymentMethod": "wallet", "paidAt": "2026-11-02T08:57:36.919Z" },
  "requiresPayment": false, "amount": 1000,
  "billing": { "...same object as 4.1, now serviceActive:true and walletBalance reduced..." } } }
```

Errors (all `success:false`): `400 "Not enough wallet balance for this plan"`, `400 "Choose a subscription plan"`,
`409 "A plan is already active. Renew once it ends."`, `400 "Paying from the wallet is not enabled"`.

### 4.3 Pay online with Razorpay (two calls)

1. `POST /drivers/owner/billing/razorpay/order` body `{ "planId": "..." }` returns
   `{ keyId, orderId, amount (paise), currency, subscriptionId, planName }` (HTTP 201). The plan row exists but is
   **unpaid and does not count** yet.
2. Open Razorpay checkout with `keyId` + `orderId`, then
   `POST /drivers/owner/billing/razorpay/verify` body
   `{ "razorpay_order_id", "razorpay_payment_id", "razorpay_signature" }` returns `{ subscriptionId, billing }` with the
   plan active. The signature is verified on the server; a retried verify is safe.

Rate-limited like other payment-order calls. If the owner closes checkout, nothing is charged and no plan is active.

### 4.4 `PUT /drivers/owner/billing/mode`

Body `{ "mode": "commission" }` or `{ "mode": "subscription" }`; returns the same `billing` object as 4.1.
`400 "Mode must be subscription or commission"` otherwise. Always show a confirm dialog (copy in section 8).

### 4.5 `GET /drivers/owner/billing/history?limit=30`

Plans paid for, newest first:
`[{ id, planName, amount, startsAt, expiresAt, paymentMethod, paidAt, tripsCovered, commissionWaived }]`.
`tripsCovered` / `commissionWaived` show what the plan saved (updated on each settled ride).

### 4.6 `GET /drivers/owner/wallet/history?limit=50`

```json
{ "success": true, "data": { "balance": 1100, "results": [
  { "id": "...", "kind": "credit", "type": "ride_earning", "amount": 450, "title": "Fleet ride earning", "balance": 1100, "rideId": "...", "createdAt": "..." },
  { "id": "...", "kind": "debit",  "type": "commission_deduction", "amount": 50, "title": "Commission on cash fleet ride", "balance": 650, "rideId": "...", "createdAt": "..." },
  { "id": "...", "kind": "debit",  "type": "subscription_purchase", "amount": 1000, "title": "Subscription: Fleet Monthly", "balance": 500, "rideId": null, "createdAt": "..." }
] } }
```

`type` is `""` for older rows (admin adjustment, pooling income). Colour by `kind`: credit green `+`, debit red `-`.

---

## 5. Where "service stopped" must show

* Owner Home / dashboard: if `serviceActive == false`, a red banner "Service stopped, renew or switch to commission"
  that opens the Plan & billing screen. Poll `GET /drivers/owner/billing` on screen open (there is no realtime for
  owners; there is also no owner push, only the banner).
* After a successful buy / mode change, replace local state with the returned `billing`.
* Creating a Share Ride trip for a fleet driver while the service is stopped is refused with `403 "Your subscription has ended. Renew it or switch to commission first."`.

---

## 6. Fleet driver app (driver token, profile has `owner_id`)

* **Hide** the daily-pass purchase screen and any "buy pass to go online" prompt for fleet drivers.
* **Go online** `PATCH /drivers/online` and **accept ride** (and share-ride accept) now return `403` while the owner's
  service is stopped, with this message to show as-is:

```json
{ "success": false, "message": "Your owner's subscription has ended. The owner needs to renew it or switch to commission.", "details": null }
```

* **Push** (data message) `type: "owner_subscription_expired"` with title "Your fleet subscription has ended": mark the
  driver offline in the UI and show the message above. The server has already set `isOnline = false`.
* A fleet driver is **dispatched only if** the owner is serving (live plan or commission mode). No pass needed.
* The driver wallet screen for fleet drivers stays "Monthly salary and wallet activity"; fleet rides add no row there.

---

## 7. Solo drivers (unchanged screens, but one important fix)

Endpoints already used by the app, still the same: `GET /drivers/subscription`, `POST /drivers/subscription/purchase`,
`POST /drivers/subscription/razorpay/order`, `POST /drivers/subscription/razorpay/verify`,
`GET /drivers/subscription/history`.

**What changed:** ride settlement never ran on the production database before (a database transaction error silently
stopped it: 0 of 138 rides were settled). It now runs on every completed ride, so:

* **Online ride**: `driverEarnings` is credited to the driver wallet (`WalletTransaction.type = ride_earning`).
* **Cash ride**: `commission_deduction` is debited only if there is commission to take; with an active pass the
  commission is waived, so usually nothing moves.
* The wallet balance and "today earnings" now reflect real money. Test that the driver wallet screen shows the new
  `ride_earning` rows.

Rides completed **before** this fix are not back-filled.

---

## 8. Suggested copy (same as the web)

* Active plan: "Fleet working until <date>". Commission mode: "Fleet working (commission mode)".
* Stopped: "Service stopped. Renew or switch to commission." + `reason`.
* Confirm Plan: "Your whole fleet works for the plan duration with no commission and no pass per driver. When the plan
  ends, you and all your drivers get no rides until you renew or switch back."
* Confirm Commission: "The platform keeps <10%> on each fleet ride. Online rides credit your wallet the rest; cash
  rides debit the commission from your wallet."
* Buy button: "Buy from wallet" when `walletBalance >= amount` and `paymentMethods` has `wallet`, else "Buy online".

---

## 9. Edge cases the server already handles

| Case | Result |
|---|---|
| Owner buys while a plan is live | `409` |
| Two taps on Buy with money for one | one succeeds (atomic conditional debit), other `400` |
| Gateway closed before paying | unpaid row never counts; try again |
| Plan ends mid-ride | the running ride finishes; commission follows who covers it at completion time; nothing new is dispatched |
| Owner on commission, commission is 0 | fleet works, nothing deducted |
| Owner deleted / deactivated | no service for owner or fleet |
| Settlement retried | no double credit (`walletSettledAt` claim) |
| Server instances (4) running the expiry job | one acts per plan (atomic claim) |
| Legacy owner with no billing fields | treated as `subscription`, no plan |

---

## 10. Test checklist

1. Owner with no plan: banner shown, fleet driver gets the 403 message on go-online, no requests arrive.
2. Add wallet money (admin), buy a plan from the wallet: banner turns green, fleet driver can go online and gets rides.
3. Complete a fleet ride **online** under the plan: owner wallet `+fare`, history row `ride_earning`, plan card
   `tripsCovered` +1, `commissionWaived` shows the saved commission.
4. Complete a fleet ride by **cash** under the plan: no wallet change.
5. Let the plan end (admin can shorten it): service stops, driver is set offline, push arrives.
6. Switch to commission: service returns; a cash ride of Rs 500 at 10% debits Rs 50, an online one credits Rs 450.
7. Buy online with Razorpay test keys: plan active only after verify; cancelling checkout leaves nothing active.
8. Solo driver: complete an online ride and see the wallet increase.

---

## 11. Admin side (web only, FYI)

* **Owner Subscription** page (`/admin/owner-subscriptions`): tabs Owners (mode, service on/off, plan expiry, drivers,
  wallet; grant a plan; force a mode), Plans (create/edit Rs, days, text, on/off), Payments (what owners paid), and
  **Commission** (see and set the owner commission for all price rows, rental packages and vehicle types at once; a
  single route or vehicle can still be edited under Price Management -> "Admin Commission From Owner").
* Commission type: `percentage` of the fare or `fixed` Rs per ride. Admin earnings include owner plan revenue
  ("Driver passes and owner plans") and the commission kept on fleet rides.
* Starting data on the live server: plans **Fleet Weekly Plan Rs 599 / 7 days**, **Fleet Monthly Plan Rs 1,999 / 30
  days**; owner commission **10%**. All editable in admin.

Admin endpoints (for reference only): `GET/POST /admin/owner-subscriptions/plans/*`, `.../payments`, `.../owners`,
`POST .../grant`, `PATCH .../owners/:id/mode`, `GET/POST .../commission`.

---

## 12. Not covered / known limits

* Car Pooling vehicles an owner lists (the old admin-managed pooling) are **not** switched off by an ended plan.
* Share Ride money for a fleet driver still settles through the driver wallet; only the plan / commission rule follows
  the owner.
* Owners get **no push** for plan expiry (drivers do); show the banner and optionally remind locally from
  `subscription.expiresAt`.
* A plan cannot be queued: renew after the current one ends.
* The first plan window starts at the daily cycle hour (06:00 IST by default), so `startsAt` can be earlier than the
  purchase time; `expiresAt` is `startsAt + durationDays`.
