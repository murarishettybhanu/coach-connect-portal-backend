# CLAUDE.md — ShipKit Backend (`coach-connect-portal-backend`)

Context for Claude when working in this repo. Read this before making changes.

## What this is

REST API for **ShipKit** — an end-to-end fulfillment + storefront platform for
Indian coaches/creators. Coaches send branded "Welcome Kits" to their audience
and sell merch through hosted storefronts; ShipKit (the admin/platform) handles
inventory, dispatch, and payouts. Currency is INR throughout.

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
CORS is enabled for all origins.

### Env (`.env`)
- `MONGODB_URI` — Mongo connection string (Atlas)
- `JWT_SECRET` — JWT signing secret (falls back to `'default-secret'` if unset — fix before prod)
- `PORT` — defaults to 3000

> ⚠️ `info.md` currently contains live MongoDB Atlas credentials committed to the
> repo. Treat as a leaked secret — rotate and remove from version control.

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
```

## Data model (`src/schemas/`)

- **User** — `email`, `password` (bcrypt), `name`, `role` (`ADMIN | COACH | CUSTOMER`), `phoneNumber`.
- **Coach** — 1:1 with a User (`userId`). `username` (storefront URL slug), `brand`,
  `bio`, `tagline`, `socialLinks`, `walletBalance`, `storefrontConfig`
  (banner/theme/domain), `bankingDetails` (account/IFSC). `isActive`.
- **Product** — owned by a Coach. `name`, `baseProductionCost`, `retailPrice`,
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
- **Transaction** — wallet ledger per Coach. `type` (`COMMISSION | PAYOUT | DEBIT`),
  `amount`, optional `orderId`, `utrReference` (payouts), `status`.

## Roles & access control

- `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(UserRole.X)` on handlers.
- `JwtStrategy.validate` loads the full User from `payload.sub` and puts it on
  `req.user`, so `req.user.role` and `req.user._id` are available in controllers.
- `RolesGuard` allows the request if `req.user.role` matches any required role.
  No required roles → open endpoint.
- Public (no guard): `POST /api/auth/*`, `GET /api/campaigns/slug/:slug`,
  `GET /api/coaches/:username`, `POST /api/orders` (storefront checkout).

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

## Known issues / tech debt

Address before production. Ordered by severity.

1. **🔴 Leaked credentials** — `info.md` contains a live MongoDB Atlas
   username, password, and connection URI committed to the repo. Rotate the
   Atlas password immediately, delete `info.md` from version control, and add it
   to `.gitignore`. Assume the secret is compromised.
2. **🔴 Weak JWT secret fallback** — `jwt.strategy.ts` falls back to the literal
   `'default-secret'` when `JWT_SECRET` is unset, so tokens are forgeable in any
   env missing the var. Require `JWT_SECRET` at boot (fail fast) and never ship a default.
3. **🟠 `.env` committed** — the `.env` file (MONGODB_URI / JWT_SECRET / PORT) is
   present in the repo. Should be gitignored; provide a `.env.example` with keys only.
4. **🟠 No token expiry handling** — JWTs are signed without an explicit `expiresIn`,
   and there's no refresh flow. Sessions effectively don't expire.
5. **🟡 CORS open to all origins** — `app.enableCors()` allows any origin. Restrict
   to the known frontend origin(s) in production.
6. **🟡 `walletBalance` not source of truth** — `Coach.walletBalance` exists but
   balance is computed from the transaction ledger (`transactions.service.getBalance`).
   The schema field can drift; either keep it in sync or remove it to avoid confusion.
7. **🟡 Loose typing** — services accept/return `any` for write payloads in many
   places (orders, transactions, coaches). Add DTOs (see `auth/dto/`) when extending.

## Conventions

- Services take/return loosely-typed `any` for write payloads in several places;
  prefer adding/using DTOs (see `auth/dto/`) when extending.
- Mongoose refs use `ObjectId` + `.populate()`; list endpoints sort `createdAt: -1`.
- `timestamps: true` on every schema (`createdAt`/`updatedAt`).
- Keep new endpoints behind `JwtAuthGuard` + `RolesGuard` unless intentionally public.
