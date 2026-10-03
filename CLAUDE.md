# CLAUDE.md — ShipKit Backend (`coach-connect-portal-backend`)

Context for Claude when working in this repo. Read this before making changes.

## What this is

REST API for **Tribe Merchandise** (formerly "ShipKit") — an end-to-end fulfillment
+ storefront platform for Indian creators/coaches. A creator's audience is their
**"tribe"**; creators send branded welcome kits and sell merch through hosted
storefronts, while the admin/platform handles inventory, dispatch, and payouts.
Currency is INR throughout. (Internal field/model naming often still uses `coach`/
`coachId` — the "tribe" rename was primarily UI/routes.)

This is the backend that the [coach-connect-portal](../coach-connect-portal) frontend talks to.

## Stack

- **NestJS 11** (modular controllers/services/DI) on **Express**
- **MongoDB** via **Mongoose 9** (`@nestjs/mongoose`)
- **Auth**: JWT (`@nestjs/jwt` + `passport-jwt`), bcrypt password hashing
- **Validation**: `class-validator` + global `ValidationPipe` (whitelist + transform)
- **Docs**: Swagger at `GET /api/docs`
- TypeScript, Jest (`*.spec.ts`), ESLint + Prettier

## Run

```bash
npm install
npm run start:dev      # watch mode, http://localhost:3000
npm run build && npm run start:prod
npm test               # jest unit specs
npm run lint           # eslint --fix
```

**Global route prefix is `/api`** (set in `main.ts`), so all endpoints are `/api/...`.
CORS is restricted to the frontend origins in `CORS_ORIGINS`. Also live in `main.ts`:
`helmet`, `trust proxy`, a global exception filter, and Swagger only when `NODE_ENV !== production`.

### Env (`.env` — gitignored; provisioned on the VM from GitHub Actions secrets)
- `MONGODB_URI` — Mongo connection string (Atlas)
- `JWT_SECRET` — **required** signing secret; boot fails fast if unset (no default)
- `CORS_ORIGINS` — comma-separated allowed frontend origins
- `SITE_ADDRESS` — Caddy apex/www domains for the static frontend (see Deployment)
- `MAIL_*` (SES SMTP), `S3_*` (uploads to S3), `PORT` (default 3000)
- `WHATSAPP_VERIFY_TOKEN` — echoed handshake token; must match the Meta dashboard
- `WHATSAPP_APP_SECRET` — Meta app secret; verifies `X-Hub-Signature-256`.
  **Required in production** — the webhook refuses unverified deliveries without it
- `WHATSAPP_PHONE_NUMBER_ID` — the sending number; **required to send**, and when set
  it also filters out webhook events for other business numbers
- `WHATSAPP_ACCESS_TOKEN` — permanent System User token (`whatsapp_business_messaging`
  + `whatsapp_business_management`); required to send. Without it inbound still works,
  the acknowledgement is skipped with a warning
- `WHATSAPP_WABA_ID` — WhatsApp Business Account id; required for template endpoints only
- `WHATSAPP_API_VERSION` — Graph version, defaults to `v21.0`
- `WHATSAPP_OTP_TEMPLATE_ID` — Meta **template id** for the authentication template
  that delivers verification codes (defaults to `1521285713364906`). Resolved to a
  name/language once at runtime and cached, since the send API takes a name
- `WHATSAPP_DIGEST_TEST_NUMBER` / `WHATSAPP_DIGEST_ENABLED` / `WHATSAPP_DIGEST_TEMPLATE_ID`
  — the nightly dispatch digest (below). Sending is **off unless one is set**
- `INDIAPOST_BASE_URL` — India Post external-integration host. Defaults to UAT
  (`https://test.cept.gov.in/beextcustomer`); point at production once India Post
  issues production credentials
- `INDIAPOST_USERNAME` / `INDIAPOST_PASSWORD` — login for `/v1/access/login`.
  Without them the tracking endpoints return 503 with a clear message rather than
  failing obscurely

> Secrets live only in GitHub Actions secrets + the VM's gitignored `.env`. Never commit them.

## Deployment

Single **AWS EC2 t3.micro** (`/opt/shipkit/`, see [`deploy/`](deploy/)) runs this backend
container + **Caddy**. Caddy serves the **static SPA frontend** on the apex/www domains
(from `/opt/shipkit/frontend`) and reverse-proxies **`api.tribemerchandise.com`/`.in` →
`backend:3000`**; the frontend calls the API cross-origin (CORS allows the apex origin).
CI (`.github/workflows/deploy.yml`) builds the image → GHCR → SSH deploy with a
**health-gated rollout + rollback**, and syncs `deploy/docker-compose.yml` + `Caddyfile`.
MongoDB Atlas, AWS S3 (uploads), AWS SES (mail).

## Architecture

Standard Nest layout. `app.module.ts` wires Mongoose + all feature modules.
Each module under `src/modules/<name>/` has `.module.ts`, `.controller.ts`,
`.service.ts`, a `.spec.ts`, and DTOs where present.

```
src/
  main.ts                 # bootstrap, /api prefix, ValidationPipe, Swagger, CORS
  app.module.ts           # ConfigModule + MongooseModule.forRootAsync + feature modules
  schemas/                # Mongoose schemas (the data model — start here)
  common/
    decorators/roles.decorator.ts   # @Roles(...)
    guards/roles.guard.ts           # RolesGuard (reads @Roles metadata off req.user.role)
  modules/
    auth/        # register + login, JwtStrategy, JwtAuthGuard
    users/       # User CRUD
    coaches/     # Coach profiles, storefront config, banking
    products/    # Inventory (admin-managed)
    campaigns/   # Welcome-kit & store-sale campaigns (public slug links)
    orders/      # Order lifecycle, approvals, commission calc  ← most business logic
    transactions/# Wallet ledger, balance, payouts
    whatsapp/    # Public WhatsApp Cloud API webhook (inbound messages)
    tracking/    # India Post consignment tracking (official Bulk Tracking API)
    tribe-members/ # Customers per tribe, derived from orders (admin read-only)
  scripts/       # One-off maintenance scripts run with ts-node (backfills)
```

### India Post tracking (`tracking/`)

`IndiaPostApiService` is the transport: it owns the credentials, logs in at
`POST /v1/access/login` and **caches the bearer token** (India Post's tokens live
~15 minutes, so it refreshes on expiry rather than per request, de-duplicates
concurrent logins, and retries once on a 401 in case a token lapsed in flight).
`TrackingService` maps `POST /v1/tracking/bulk` onto our own `TrackingResult`.

**The live API is looser than their integration document — trust this list, not
the document's samples.** Verified against UAT from the production host:
- A scan's `date` carries the day with the **clock zeroed** (`2026-02-19T00:00:00Z`)
  and the real time is in a separate `time` field (`17:44:15`). They must be
  stitched back together, or every scan renders as 00:00 and same-day events have
  nothing to order by.
- An article India Post has no data for is **echoed back with its number and every
  other field blank**, not omitted. So a `booking_details` object proves nothing —
  "known" means real booking data (`booked_on`/`booked_at`/`article_type`/
  `delivery_location`) or at least one scan.
- `tariff` is `0` for "not supplied" (don't print ₹0), `officeid` is a **number**,
  `booked_on` can be **null**, and `remarks`/`rts` are **absent from every scan**
  despite being documented — so the return-to-sender flag is currently always false.
- Scan order is **not guaranteed**: the document's samples are newest-first, the
  live API answers oldest-first. We sort rather than trust it.
- `del_status` is the string `"not delivered"` for undelivered articles — it
  contains the word "delivered", so a plain `/deliver/` test reads backwards.

Operational notes:

1. **⚠️ Tracking returns nothing for real parcels right now, and that is expected.**
   Production points at **UAT**, and UAT carries its own synthetic dataset that is
   **disjoint from live India Post data**. Measured 2026-09-27 across 30 real
   dispatched/delivered orders: India Post knew **0 of 30**. The two directions
   both fail, which is what proves it:

   | Article | UAT API | Public tracking |
   |---|---|---|
   | `CA187141418IN` (a real parcel of ours) | no data | 19 events, delivered |
   | `EY011867595IN` (a UAT sample) | 6 events | no data |

   So this is **not** customer-id scoping and **not** a mapping bug — the fix is
   production credentials, nothing else. Don't re-debug the code over it.
   **Decision (2026-09-27):** leave the feature dark until India Post completes
   onboarding (§2 of their document, `integrations.cept@indiapost.gov.in`); a
   scrape fallback was considered and declined. Switching over is
   `INDIAPOST_BASE_URL` + real credentials, no code change.
2. Their document also says only articles **booked under our own customer id** are
   reported. Untested — the UAT dataset gap masks it. It may bite once production
   credentials land, because we book by handing over a CSV rather than through
   their Booking API. That is the next thing to check, not the first.
3. India Post **filters callers by IP**: the UAT host resets the TLS handshake
   from unapproved networks, so it cannot be smoke-tested from a dev machine. The
   EC2 reaches it fine, so verify from there (`docker compose exec backend node -e …`).
   Tokens come back with `expires_in: 900`, matching the cache's assumption.

## Data model (`src/schemas/`)

- **User** — `email`, `password` (bcrypt), `name`, `role` (`ADMIN | COACH | CUSTOMER`), `phoneNumber`.
- **Coach** — 1:1 with a User (`userId`). `username` (storefront URL slug), `brand`,
  `bio`, `tagline`, `socialLinks`, `walletBalance`, `storefrontConfig`
  (banner/theme/domain), `bankingDetails` (account/IFSC). `isActive`.
- **Product** — owned by a Coach. `customizationType` (`TEXT | PHOTO | SIZE`) with
  `sizeOptions` for the sizes a customer chooses from (empty = the standard XS–XXL),
  `disabledSizes` (off sale) and `sizeStock` (per-size quantities) — see "Stock" below.
  `name`, `baseProductionCost`, `retailPrice`, `sku` (unique), `stockLevel`, `imageUrl`, `isActive`.
- **TribeKit** — owned by a Coach. `name`, `items[]` (productId + `quantity`),
  optional `kitPrice` (null = Σ retail × qty), `isActive`, soft `isDeleted`.
- **Campaign** — owned by a Coach. `type` (`WELCOME_KIT | STORE_SALE`),
  `products[]` (productId, optional `retailPrice` for store sales, `quantity`
  units per claim — absent on legacy lines, read as 1), optional `kitId` (linked
  TribeKit) + `kitPrice` (override; null = follow the kit), unique `slug`
  (public URL), `status` (`ACTIVE | PAUSED | STOPPED`), `claims` counter.
- **Order** — owned by a Coach, optional `campaignId`. `type` (`WELCOME_KIT | STORE_SALE`),
  `status` (`NEW → PACKED → DISPATCHED → DELIVERED`, or `CANCELLED`),
  `approvalStatus` (`PENDING | APPROVED | REJECTED | null`), `items[]`
  (productId, quantity, baseCost, retailPrice, commission), `totalCommission`,
  `totalAmount`, `totalCost`, `shippingAddress` (India format: pincode, state,
  district, sector/village…), tracking/courier/payment refs. `memberId` → the
  TribeMember it belongs to (every order, including rejected/deleted ones).
- **TribeMember** (`tribemembers`) — a customer of one tribe, derived from its
  orders. Identity `{ coachId, phone }` (unique; phone = last 10 digits).
  `name` / `email` / `alternatePhone` (latest non-empty across the orders),
  `addresses[]` (distinct by line 1 + pincode, `lastUsedAt`, newest first),
  `orderCount` / `firstOrderAt` / `lastOrderAt` (non-deleted orders only).
  Never edited directly — see "Tribe members" below.
- **WhatsappSetting** — singleton (`key: 'default'`) behind the admin settings page:
  `autoReplyEnabled`, `acknowledgementText`, plus business hours
  (`businessHoursEnabled`, `openTime`/`closeTime`, `openDays`, `timezone`,
  `afterHoursText`). Created lazily with schema defaults on first read.
- **WhatsappConversation** — one row per customer wa_id (`contact`, unique). Inbox
  metadata: `profileName`, `lastInboundAt`/`lastOutboundAt`, `lastMessagePreview`,
  `unreadCount`, and `ackSentAt` — the auto-acknowledgement guard.
- **WhatsappMessage** — one WhatsApp message, inbound or outbound. Unique `waMessageId` (Meta redelivers
  until it gets a 200, so writes are upserts), `from` (wa_id), `profileName`, `type`,
  best-effort `text`, `mediaId`/`mimeType`, `contextMessageId` (reply-to), `sentAt`,
  full `raw` payload, `handled` flag.
- **Transaction** — wallet ledger per Coach. `type` (`COMMISSION | PAYOUT | DEBIT`),
  `amount`, optional `orderId`, `utrReference` (payouts), `status`.

## Roles & access control

- `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(UserRole.X)` on handlers.
- `JwtStrategy.validate` loads the full User from `payload.sub` and puts it on
  `req.user`, so `req.user.role` and `req.user._id` are available in controllers.
- `RolesGuard` allows the request if `req.user.role` matches any required role.
  No required roles → open endpoint.
- Public (no guard): `POST /api/auth/*`, `GET /api/campaigns/slug/:slug`,
  `GET /api/coaches/:username`, `POST /api/orders` (storefront checkout),
  `GET|POST /api/whatsapp/webhook` (Meta calls it with no auth header — authenticity
  is the `X-Hub-Signature-256` HMAC instead; both are `@SkipThrottle()` so a burst of
  customer messages isn't 429'd into Meta's retry/disable path).

## Key business logic — Orders (`orders.service.ts`)

This is where the money math lives; touch carefully.

- **On create**: for each item, fetches the product, computes
  `commission = (retailPrice - baseProductionCost) * quantity` **for STORE_SALE only**,
  accumulates `totalAmount` / `totalCost` / `totalCommission`, and **decrements
  product stock**. Increments `campaign.claims` if `campaignId` present.
- **Campaign orders take exactly the campaign's contents** (public claims *and*
  signed-in CSV imports): per campaign product, the order's lines — several when
  units differ in size/name/photo — must sum to the product's campaign `quantity`
  (legacy lines = 1), every product must be there and nothing else, or 400
  `Quantities don't match this campaign`. Only a product deleted since the
  campaign was made may be left out (the claim form no longer shows it).
- **Kit-priced store sales**: a kit-linked STORE_SALE campaign whose price
  resolves (`campaign.kitPrice ?? kit.kitPrice`) charges that price P for the
  claim: `totalAmount = P`, `totalCommission = max(0, P − Σ cost × qty)`. Both
  are spread over the lines by retail value (product retailPrice × qty; by
  quantity if that's all zero) in whole paise (`common/kit-pricing.ts`):
  commissions sum exactly; per-unit `retailPrice`s sum exactly whenever some
  line can absorb the leftover paise evenly (always when a line has one unit).
  No resolved price → lines are priced one by one as before.
- **WELCOME_KIT** orders start with `approvalStatus = PENDING` and record **no**
  commission transaction until approved.
- **STORE_SALE** orders record a `COMMISSION` transaction immediately (if commission > 0).
- **approveOrder** (welcome kits only): sets APPROVED, records the deferred COMMISSION transaction.
- **rejectOrder** (welcome kits only): sets REJECTED + status CANCELLED and **restores stock**.

### Stock (`products.service.ts`)

**Orders never block on stock** (decision, 2026-10-03). Claims, checkout, CSV
imports, restores and re-sends always go through; stock may go **below zero**,
and that negative number is the shortfall the admin restocks. Only the admin
sees it — `ProductsController` floors stock at 0 for every other role, the
public storefront does the same, and campaign responses carry no stock at all.
Manual *removals* are the one exception: they can't take a size (or Unassigned)
below zero, since they're physical corrections.

**Per-size stock.** A SIZE product keeps `sizeStock: [{ size, qty }]` alongside
`stockLevel`, which stays the product total. Anything in the total beyond the
sum of the sizes is **Unassigned** — stock not yet counted into a size (all of
it, for products that existed before this was built). Rules worth knowing:
- An **array, not a map**: Mongo keys can't contain dots (`"32.5"`), and one
  positional `$inc` moves a size *and* the total together, so the total is
  always the sum by construction. A size's first movement `$push`es its bucket
  behind a `$ne` guard, so concurrent first orders retry instead of pushing twice.
- `decrementStock` / `incrementStock` take the order line's size
  (`item.customizationValue` when `customizationType` is SIZE). `matchSize`
  (`src/common/sizes.ts`) resolves it case-insensitively to the product's own
  spelling; an **unknown or missing size moves only the total**, i.e. Unassigned.
  All seven order paths pass it — create (+ its rollback), delete, restore,
  reject, return, reorder.
- **Old orders** (placed before per-size stock) need no backfill: if one is
  rejected/deleted/returned later, its unit goes back to the size on the order.
- `disabledSizes` = **off sale**: hidden from the claim and checkout forms, stock
  kept, re-enable to sell the rest off. Orders already in that size are untouched,
  and the server doesn't reject the size (CSV imports may still use it).
- **Size stock page** (`GET /products/sized`, `PATCH /products/:id/size-stock`):
  the admin enters what's **on the shelf** per size; the page subtracts units
  `promised` to open orders (NEW/PACKED, not rejected/deleted, not dropped at
  approval) and saves the result. The new total is the sum — so the same call
  splits Unassigned *and* corrects to a physical count; every changed bucket is
  logged in `InventoryLog` with its `size`. `expectedUpdatedAt` makes a save
  fail with 409 if an order moved stock while the page was open.
- Tests: `src/modules/products/size-stock.int.spec.ts` runs against a real,
  throwaway MongoDB (`MONGO_TEST_URI=mongodb://localhost:27017/shipkit_sizetest
  npx jest size-stock`) and is skipped without it — the logic lives in the
  atomic updates, so a mocked model would prove nothing.

Known gaps: tribe-kit "buildable" counts use the product total, not sizes.

## Key business logic — Kits & kit-linked campaigns

(`tribe-kits.service.ts`, `campaigns.service.ts`, `common/kit-pricing.ts`.)
Applies to campaigns created from a kit; older campaigns are untouched.
- **Price floor** = Σ product `baseProductionCost` × quantity. A kit's own
  `kitPrice` below it is a 400 `Kit price can't be below the production cost of
  its products (₹X)`; so is a campaign whose effective price is, when it links
  or changes its price (not on every edit — pausing/stopping always works).
- **Linking** (`kitId` on campaign create/update): the kit must be the tribe's
  own and active; products are copied from the kit with quantities and current
  retail prices, and any `products` in the body are **ignored**. The form
  re-sends `kitId` on every save — an existing link tolerates a kit deactivated
  since (and a deleted one while the campaign stays STOPPED). `kitId: null`
  unlinks (price cleared; products from the body, else the old lines, at 1 each).
  `kitPrice` without a kit is a 400.
- **Live sync**: every kit PATCH rewrites `products` on all campaigns with its
  `kitId`. Refused with 409 if a linked campaign's override would sit below the
  new floor (names listed). Kit saved first, then campaigns (no transactions —
  dev is a standalone mongod); the sync is idempotent, so re-saving repairs it.
- **Deactivate / delete** a kit → 409 while a linked campaign isn't STOPPED.
- **Responses**: every campaign carries `products[].quantity`, `kitId` as
  `{ _id, name, kitPrice }`, `effectivePrice` (null unless linked and priced).
  Signed-in reads (`GET /`, `/me`, create/update results) add `kitMinPrice`.
  The public ones (`/slug/:slug`, `/:id`) never load production cost — the kit
  populate there selects only name and price. Kit lists add `productValue`,
  `minPrice` and `linkedCampaigns` (not STOPPED).

### Wallet balance (`transactions.service.ts`)
`getBalance` = sum of COMMISSION amounts minus PAYOUT/DEBIT amounts (computed from
the ledger, not read off `coach.walletBalance` — the schema field is not the source of truth).

## Tribe members (`tribe-members/`)

A member is one person's history with one tribe: every order with the same
`coachId` and phone (last 10 digits, so `+91 98765 43210` = `9876543210`). The
same person ordering from two tribes is two members. Members are **derived
data** — `TribeMembersService.recordOrder(order)` recomputes one from all the
orders linked to it — so there is no create/edit endpoint.
- **Where it's called** (`OrdersService.recordMember`): create, attach-address
  (each order it completes), `PATCH /orders/:id/address`, reorder (the new
  order), delete and restore. Failures are **logged and swallowed** — they
  never fail the order write. Re-running the backfill repairs any drift.
- **Race safety without transactions**: the member is found or created with an
  upsert on the unique `{ coachId, phone }` index (an E11000 from a concurrent
  upsert re-reads the winner), and the recomputed fields are written
  conditionally on the member's `__v`, so of two orders syncing one member at
  once the one holding an older picture retries rather than overwrites.
- Contact details and addresses come from **all** linked orders (latest
  non-empty wins); counts and first/last dates skip soft-deleted ones (rejected
  ones still count). Address-pending claims add no address until one is
  attached. Because it is a recompute, correcting an order's address replaces
  the old one, and an order whose phone changes moves to the new member (the
  old one is deleted once it has no orders).
- Linking writes only `memberId`, with `timestamps: false` — the order's
  `updatedAt` doesn't move.
- **Backfill** (`src/scripts/backfill-tribe-members.ts`) — idempotent, prints
  counts only (never names/phones/addresses); additive writes only (the new
  collection and `memberId`). Dry run first:
  `MONGODB_URI=... npx ts-node src/scripts/backfill-tribe-members.ts --dry-run`,
  then without `--dry-run`. Also built to `dist/scripts/` for running in the
  container (`node dist/scripts/backfill-tribe-members.js`). A second run
  reports "No changes".
- Tests: `tribe-members.int.spec.ts` covers the upsert race and idempotence
  against a real MongoDB (`MONGO_TEST_URI=… npx jest tribe-members`; it uses its
  own `shipkit_membertest` database and drops it).

## API surface (all prefixed `/api`)

- **auth**: `POST /auth/register`, `POST /auth/login` → `{ access_token, user }`
- **coaches**: `POST /` (admin), `GET /` (admin), `GET /profile` (coach),
  `GET /:username` (public), `GET /id/:id` (admin), `PATCH /:id` (admin/coach)
- **products**: all guarded. `POST` `PATCH` `DELETE` admin-only; `GET /` `GET /:id` any authed
  (stock floored at 0 for non-admins). `GET /products?coachId=` filters by coach.
  Admin: `GET /products/sized`, `PATCH /:id/size-stock`, `PATCH /:id/inventory/add|remove`
  (optional `size`), `GET /:id/inventory/logs`.
- **campaigns**: `GET /me` (coach), `POST /` (coach/admin), `GET /` (admin),
  `GET /slug/:slug` (public), `GET /:id` (public), `PATCH /:id` (coach/admin).
  Create/update take `kitId?` / `kitPrice?` (see Kits above)
- **tribe-kits**: `GET /?coachId=` (admin; a tribe always gets its own),
  `POST /`, `PATCH /:id`, `DELETE /:id` (admin only; validated DTOs,
  `kitPrice?: number | null`)
- **orders**: `GET /me` & `GET /coach` (coach), `GET /pending-approvals` (admin/coach),
  `POST /` (public checkout), `GET /` (admin), `GET /:id`, `PATCH /:id/status` (admin),
  `PATCH /:id/approve` & `PATCH /:id/reject` (admin/coach)
- **tribe-members** (admin only): `GET /tribe-members?coachId=<id,id>&search=&page=&limit=`
  → `{ data, total, page, limit, totalPages }`, sorted `lastOrderAt` desc, limit
  default 20; search (escaped, case-insensitive) on name, phone, email, any
  address's city or pincode; each member has `coachId` populated as
  `{ _id, username, brand, name, userId: { name } }`. `GET /tribe-members/:id`
  (same populate, all addresses). `GET /tribe-members/:id/orders` → plain array,
  non-deleted first then `createdAt` desc, populated like the admin order tables
- **tracking** (admin/tribe): `GET /tracking/:consignmentNumber`,
  `POST /tracking/bulk` (`{ consignmentNumbers: [] }`, max 500 — results come back
  in the order asked for)
- **transactions**: `GET /me` & `GET /my-balance` & `GET /coach` & `GET /balance` (coach),
  `POST /payout` (admin), `GET /` (admin)
- **whatsapp**: `GET /whatsapp/webhook` (public — Meta's `hub.challenge` handshake,
  replies in `text/plain`), `POST /whatsapp/webhook` (public — signed inbound events,
  always acks 200). Admin-only: `GET /whatsapp/conversations`,
  `GET /whatsapp/conversations/:contact`, `POST /whatsapp/conversations/:contact/reply`,
  `PATCH /whatsapp/conversations/:contact/read`, `GET /whatsapp/messages?from=&limit=`,
  `POST /whatsapp/conversations/:contact/template`, `GET /whatsapp/media/:mediaId`,
  `GET|PATCH /whatsapp/settings`, `GET|POST /whatsapp/templates`,
  `DELETE /whatsapp/templates/:name`

### WhatsApp webhook (`whatsapp.service.ts`)
Callback URL given to Meta: `https://api.tribemerchandise.com/api/whatsapp/webhook`.
`main.ts` boots with `rawBody: true` because the signature HMAC is over the exact
bytes Meta sent — re-serialized JSON won't match. Delivery is at-least-once and
sustained non-2xx gets the webhook disabled, so per-message failures are logged and
swallowed, never returned. Delivery statuses (sent/delivered/read) are logged only.

**Auto-acknowledgement.** A new inbound message triggers one acknowledgement per
24-hour customer service window — the guard is a *conditional* update on
`ackSentAt` (`findOneAndUpdate` matching "unset or older than 24h"), not a
read-then-write, because Meta delivers concurrently and two handlers would each
see "no ack yet" and both send. A failed send clears `ackSentAt` so the next
message retries.

Acknowledgement text and business hours come from **WhatsappSetting**, not code,
so they change without a redeploy. Hours are evaluated in the configured
timezone (`Intl.DateTimeFormat`) rather than the server's — the box runs UTC and
the business runs on IST; a close time before the open time means an overnight
shift. A bad timezone string is treated as "open" rather than silencing the reply.

**Authentication templates are a different shape at both ends.** Meta writes and
localises their copy, so `createTemplate` sends knobs (`add_security_recommendation`,
`code_expiration_minutes`, an `OTP`/`COPY_CODE` button) rather than text — and the
send repeats the passcode in a `button` component (`sub_type: 'url'`, index `'0'`)
as well as the body, or Meta rejects it because the copy-code button has nothing
to copy. `sendTemplateTo` looks the template up to decide; a lookup failure still
sends, treated as an ordinary template.

`POST /whatsapp/conversations/:contact/template` doubles as "start a new
conversation": a template is the only message WhatsApp lets you *open* with, so
the `:contact` there may be a number that has never written in. It runs through
`normalizeContact` (digits only, bare 10-digit numbers assumed Indian), and the
inbox sorts on `updatedAt` rather than `lastInboundAt` so a thread we started
doesn't sink to the bottom for want of an inbound message.

**Inbound media is proxied, never linked.** Meta's media URLs expire in minutes
*and* need the bearer token, so `GET /whatsapp/media/:mediaId` resolves the id
and streams the bytes; the admin UI fetches it as a blob because an `<img src>`
can't carry the Authorization header.

**The 24-hour window governs everything outbound.** Free-form text is only
allowed within 24h of the customer's last message; outside it Meta accepts only
approved templates. `replyTo` refuses early with an explanation rather than
letting the Graph call fail. Templates are **not** stored locally — the endpoints
proxy the Graph API so the review status shown is always current.

### WhatsApp OTP on the public campaign forms (`whatsapp-otp.service.ts`)
The claim form and the address step both verify the customer's number before
they will submit. Codes are 6 digits, **bcrypt-hashed** (never stored in the
clear), expire in 10 minutes, allow 5 guesses, and can't be re-sent within 60s;
the endpoints are throttled far below the global ceiling because every request
costs a real WhatsApp message. Every failure mode returns the *same* message —
telling a caller which part was wrong helps them enumerate numbers.

Postal rules for the public forms live in `validatePublicAddress` (phone must be
10 digits starting 6-9; Landmark and Sector/Village required) and run server-side for untrusted callers, mirroring
the form. The forms also show a **label preview** before submitting —
`AddressLabelPreview` mirrors `ShippingLabelOverlay`'s field order, so keep the
two in step.

Verification returns a **signed proof token** (JWT, 30 min, same `JWT_SECRET`),
not a boolean: `POST /orders` (for campaign claims) and `POST /orders/attach-address`
require it and check it matches the phone on the submission, so the gate can't be
skipped by calling the API directly. Signed-in callers are exempt — `isSignedIn`
in `orders.controller.ts` — which keeps the admin CSV importer working. Storefront
checkout carries no `campaignId` and is unaffected.

## Nightly dispatch digest (`orders/dispatch-digest.service.ts`)

A 9pm IST WhatsApp summary to each tribe owner (template
`order_dispach_update_for_tribe_owner`, id `1393420296257983`), covering the 24
hours since the previous 9pm.

Things worth knowing before touching it:
- **The window is not a UTC day.** IST is UTC+05:30 with no DST, so the cut-off
  is 15:30 UTC. Computing it with the server's own clock and zeroing the minutes
  lands on 20:30 or 21:30 IST — never 21:00. `windowEndingAt` does the arithmetic
  with a constant offset; its tests pin the half hour.
- **`statusHistory` is the only record of when a dispatch happened** — the
  order's own timestamps move on to delivery — so the query matches a
  `DISPATCHED` history entry inside the window.
- **A shipment is an order, not a unit.** An order of three tees is one shipment;
  an order holding two products counts once against each, so the product lines
  can legitimately sum to more than the total.
- **Template parameters cannot contain newlines** (Meta rejects them), which is
  why `dispatch_summary` joins the product lines inline — and why the template's
  own example shows them run together.
- The template's TEXT header carries its own `{{date}}` placeholder. Body
  parameters don't fill a header, so `sendTemplateByIdTo` now splits values
  between header and body components.
- **Tribes with nothing dispatched are skipped.** Most nights only one to three
  of the eleven ship anything; a nightly "0 shipments" to the rest is how a
  business number gets muted.

Sending is off unless configured: `WHATSAPP_DIGEST_TEST_NUMBER` routes every
digest to one number (rollout step 1), `WHATSAPP_DIGEST_ENABLED=true` sends to
real owners, neither set computes and logs only.

## Weekly fulfilment report (`orders/weekly-report.service.ts`)

Fridays at 6pm IST (template `weekly_dispatch_report`, id `1638054397686424`),
covering the seven days since the previous Friday 6pm.

It answers a **different question from the nightly digest**: that one counts
**dispatches**, this one counts **deliveries and returns**, because that is what
the template asks for. An order delivered and then returned inside the same week
appears in both columns, which is correct, not double counting.

- The cut-off is Friday 18:00 IST = **12:30 UTC**; on a Friday before 6pm the
  week hasn't closed, so it reports the *previous* Friday's week. Tests pin both.
- Counts come from `statusHistory` transitions inside the window, not from the
  order's current status — an order delivered on Monday and returned on Thursday
  must show in both totals.
- Kept as a separate service from `DispatchDigestService` on purpose: that job
  runs nightly in production and a different aggregation wasn't worth
  destabilising it for. The overlap in shape is the deliberate cost.
- Shares the digest's on/off switches, so one setting governs both jobs.

## Future scope

### Notifications — surface failed sends (planned, not built)

Five automated WhatsApp flows now run without a human: dispatch, delivered and
returned notifications to customers, plus the nightly digest and weekly report
to tribe owners. Every one of them is **deliberately fire-and-forget and
swallows its errors** — a messaging failure must not fail an admin's status
change or stop the other tribes in a run. The cost is that nothing fails
loudly: today a failure is visible only to whoever reads container logs.

That cost is now deliberate on both sides. The scheduled jobs have **no
catch-up** — a run missed because the container was restarting at 9pm is
accepted rather than replayed (decision, 2026-09-27) — so notifications are the
compensating control, which is what makes them worth building.

**Two failure classes, and they arrive very differently:**

1. **Send rejected** — the Graph call itself fails (bad number, closed window,
   malformed template). Known synchronously, and *already persisted*:
   `WhatsappMessage.sendStatus = FAILED` plus the error text, surfaced in the
   admin inbox.
2. **Accepted, then undelivered** — Meta accepts the send and reports
   `status: failed` on the webhook minutes later: the number isn't on WhatsApp,
   the user blocked the business, the template got paused for quality. Today
   this is a single `logger.warn` in `handleWebhook` and is **neither persisted
   nor surfaced**. This is the actual gap.

Work, roughly 2 days: persist the webhook delivery statuses onto the message
(`deliveredAt`/`readAt`/`failedAt` + error code, keyed on the already-unique
`waMessageId`) · a notification feed with an unread count · surface it in the
admin shell · wire the five flows and the two cron jobs to raise one.

Decide before starting:
1. **What deserves a notification.** A customer who isn't on WhatsApp is
   routine and self-resolving; an expired access token or a paused template is
   systemic and urgent. Without that triage the feed becomes noise and gets
   ignored, which is worse than no feed.
2. **Whether "didn't happen" counts too** — a scheduled run skipped because the
   container was restarting, or a tribe skipped for a missing phone number,
   aren't message failures but belong to the same "something silently didn't
   happen" class, and are arguably the more valuable half.
3. **Who sees them.** Admin-only is simplest; showing tribe owners their own
   failures raises support load but catches bad customer numbers faster.
4. **Where they land.** In-app only, email (SES is already wired), or WhatsApp
   to an admin number — the last one fails in exactly the cases you most need
   to hear about.
5. **Grouping.** One notification per failed message, or one per run — 48
   failures from a single expired token should not be 48 notifications.

## Known issues / tech debt

**Resolved** (during the production-hardening pass — do not reintroduce): leaked
credentials rotated + purged from git history; `JWT_SECRET` now required at boot
(no `'default-secret'` fallback); `.env` gitignored + provisioned from CI secrets;
CORS restricted to `CORS_ORIGINS`; security headers + global exception filter added;
Swagger disabled in production; ownership checks + server-derived order pricing +
atomic stock decrement.

**Still open** (backlog — to be planned/prioritized later), ordered by severity:
1. **🟠 No token expiry handling** — JWTs are signed without an explicit `expiresIn`,
   and there's no refresh flow. Sessions effectively don't expire. Add `expiresIn` +
   a refresh mechanism (coordinate with the frontend's client-side session).
2. **🟡 `walletBalance` not source of truth** — `Coach.walletBalance` exists but
   balance is computed from the transaction ledger (`transactions.service.getBalance`).
   The schema field can drift; either keep it in sync or remove it to avoid confusion.
3. **🟡 Loose typing** — services accept/return `any` for write payloads in several
   places (orders, transactions, coaches). Add DTOs (see `auth/dto/`) when extending.
4. **🟢 CI on deprecated Node 20** — `.github/workflows/deploy.yml` uses actions
   (`actions/checkout@v4`, `docker/*-action`, `appleboy/*`) that GitHub now force-runs
   on Node 24 (Node 20 deprecated). Bump action major versions when convenient.

## Conventions

- Services take/return loosely-typed `any` for write payloads in several places;
  prefer adding/using DTOs (see `auth/dto/`) when extending.
- Mongoose refs use `ObjectId` + `.populate()`; list endpoints sort `createdAt: -1`.
- `timestamps: true` on every schema (`createdAt`/`updatedAt`).
- Keep new endpoints behind `JwtAuthGuard` + `RolesGuard` unless intentionally public.
