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
```

## Data model (`src/schemas/`)

- **User** — `email`, `password` (bcrypt), `name`, `role` (`ADMIN | COACH | CUSTOMER`), `phoneNumber`.
- **Coach** — 1:1 with a User (`userId`). `username` (storefront URL slug), `brand`,
  `bio`, `tagline`, `socialLinks`, `walletBalance`, `storefrontConfig`
  (banner/theme/domain), `bankingDetails` (account/IFSC). `isActive`.
- **Product** — owned by a Coach. `customizationType` (`TEXT | PHOTO | SIZE`) with
  `sizeOptions` for the sizes a customer chooses from (empty = the standard XS–XXL).
  Stock is per product, not per size — see Future scope. `name`, `baseProductionCost`, `retailPrice`,
  `sku` (unique), `stockLevel`, `imageUrl`, `isActive`.
- **Campaign** — owned by a Coach. `type` (`WELCOME_KIT | STORE_SALE`),
  `products[]` (productId + optional `retailPrice` for store sales), unique `slug`
  (public URL), `status` (`ACTIVE | PAUSED | STOPPED`), `claims` counter.
- **Order** — owned by a Coach, optional `campaignId`. `type` (`WELCOME_KIT | STORE_SALE`),
  `status` (`NEW → PACKED → DISPATCHED → DELIVERED`, or `CANCELLED`),
  `approvalStatus` (`PENDING | APPROVED | REJECTED | null`), `items[]`
  (productId, quantity, baseCost, retailPrice, commission), `totalCommission`,
  `totalAmount`, `totalCost`, `shippingAddress` (India format: pincode, state,
  district, sector/village…), tracking/courier/payment refs.
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
- **WELCOME_KIT** orders start with `approvalStatus = PENDING` and record **no**
  commission transaction until approved.
- **STORE_SALE** orders record a `COMMISSION` transaction immediately (if commission > 0).
- **approveOrder** (welcome kits only): sets APPROVED, records the deferred COMMISSION transaction.
- **rejectOrder** (welcome kits only): sets REJECTED + status CANCELLED and **restores stock**.

### Wallet balance (`transactions.service.ts`)
`getBalance` = sum of COMMISSION amounts minus PAYOUT/DEBIT amounts (computed from
the ledger, not read off `coach.walletBalance` — the schema field is not the source of truth).

## API surface (all prefixed `/api`)

- **auth**: `POST /auth/register`, `POST /auth/login` → `{ access_token, user }`
- **coaches**: `POST /` (admin), `GET /` (admin), `GET /profile` (coach),
  `GET /:username` (public), `GET /id/:id` (admin), `PATCH /:id` (admin/coach)
- **products**: all guarded. `POST` `PATCH` `DELETE` admin-only; `GET /` `GET /:id` any authed.
  `GET /products?coachId=` filters by coach.
- **campaigns**: `GET /me` (coach), `POST /` (coach/admin), `GET /` (admin),
  `GET /slug/:slug` (public), `GET /:id`, `PATCH /:id` (coach/admin)
- **orders**: `GET /me` & `GET /coach` (coach), `GET /pending-approvals` (admin/coach),
  `POST /` (public checkout), `GET /` (admin), `GET /:id`, `PATCH /:id/status` (admin),
  `PATCH /:id/approve` & `PATCH /:id/reject` (admin/coach)
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

## Future scope

### Per-size inventory (planned, not built)

A product with `customizationType: 'SIZE'` carries `sizeOptions` (the choices a
customer picks from), but stock is still a single `Product.stockLevel` for the
whole product — sell 40 tees and nothing knows how many mediums are left.

Chosen approach when we pick this up — **per-size quantities on the product**,
not a product per size (which would multiply the catalogue and lose the size
dropdown) and not a full `ProductVariant` collection (right at 10× the
catalogue, but it touches orders, kits, campaigns, CSV and labels):

```ts
sizeStock: [{ size: 'M', qty: 12 }, { size: '32.5', qty: 4 }]
```

An **array of subdocuments, not a map** — Mongo keys can't contain dots, so
`{ '32.5': 4 }` breaks on the first half-size. The array also allows the atomic
guard that keeps the total honest by construction:

```js
updateOne(
  { _id, sizeStock: { $elemMatch: { size, qty: { $gte: q } } } },
  { $inc: { 'sizeStock.$.qty': -q, stockLevel: -q } },
)
```

One operation moves the size *and* the cached total, so `stockLevel` stays a
correct sum and every existing report keeps working.

Work, roughly 3 days: atomic helpers + tests · thread `item.customizationValue`
through **all seven** order stock paths (create + rollback, delete, restore,
reject, return, reorder) · per-size admin adjustments with `size` on
`InventoryLog` · disable sold-out sizes in the claim/checkout dropdowns ·
migration + a reconciliation script.

Decide before starting:
1. **Migration has no breakdown** — 40 in stock doesn't say 10 of each. Needs a
   one-time admin screen to distribute; don't assume an even split.
2. **Kits** containing a sized product have no size picker in the claim flow.
   Per-size stock makes that gap load-bearing.
3. The **CSV order importer** has a Size column and creates orders directly — it
   must respect per-size stock or it becomes the drift vector.
4. **Removing a size** that still holds stock or open orders: block, or keep the
   bucket until it empties.
5. **Legacy orders** carry a size but were never counted per-size — reconcile
   from `sizeStock`, never by replaying order history.

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
