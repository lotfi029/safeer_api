# Safeer API

A NestJS + MySQL/MariaDB REST API for **جمعية سفير الدعوية** (the Safeer Da'wah
Association) — a Saudi non-profit that supports international scholarship
students at Saudi universities. This backend is the server side of the
association's public site, its student portal, and its staff admin
dashboard, built to match the concept demonstrated in the clickable
prototype at [`docs/prototype/safeer-prototype.html`](docs/prototype/safeer-prototype.html)
(bilingual Arabic/English, 29 screens: a public site, a passwordless student
portal, and a 14-screen admin dashboard).

There is no frontend in this repository — see [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md)
for what's intentionally out of scope.

## What's here

- **Public site API** — home/site chrome, pages & sections, news, board,
  work areas, testimonials, partners, documents, contact & newsletter.
- **Scholarship apply flow** — a 3-step public application form, a
  passwordless OTP student portal (status timeline, document upload,
  interview booking).
- **Admin dashboard API** — content CMS for every public collection, a
  messages inbox, full applications review (status transitions, per-document
  accept/reject, notes, bulk actions, CSV export), an overview dashboard, and
  user/role management.
- **Infrastructure** — argon2 DB-backed cookie sessions (no JWT) with HMAC
  CSRF, RFC 7807 problem+json errors, a generic `CrudController<E>()`
  factory, a locale-collapsing interceptor, an append-only audit log, a
  tag-purged in-process response cache, DB-stored mail/SMS settings with a
  delivery log, and a private-document media pipeline for scholarship
  attachments separate from the public asset pipeline.

## Prerequisites

- Node.js `^22.22.2` or `>=24.15.0` (see `package.json`'s `engines`).
- A MySQL 8 or MariaDB server, reachable with `utf8mb4_unicode_ci` as its
  default collation — the schema and every query assume it explicitly (a
  mismatch throws "Illegal mix of collations" on any query joining a string
  literal against a table column).
- Docker (optional — see below for a no-Docker fallback).

## Environment setup

Copy `.env.example` to `.env` and fill in every value:

```bash
cp .env.example .env
```

| Variable | Meaning |
|---|---|
| `NODE_ENV` | `development` \| `test` \| `staging` \| `production`. No default — deliberately: it gates both the session cookie's `Secure` flag and whether `ALLOW_DEV_PASSWORD_FIXUP` is even permitted. |
| `PORT` | HTTP port the API listens on. |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL/MariaDB connection. `DB_USER` needs DDL rights for `npm run migrate`; see `scripts/create-app-db-user.sql` for a least-privilege account to switch the *running* process to afterwards. |
| `SESSION_COOKIE_NAME` | Staff session cookie name (default `sf_sid`). |
| `SESSION_IDLE_HOURS`, `SESSION_ABSOLUTE_DAYS` | Staff session lifetime (default 8h idle / 30d absolute). |
| `APPLICANT_SESSION_COOKIE_NAME` | Student-portal session cookie name (default `sf_app_sid`) — see "Two cookie-session systems" below. |
| `APPLICANT_SESSION_IDLE_HOURS`, `APPLICANT_SESSION_ABSOLUTE_DAYS` | Applicant session lifetime (default 12h idle / 7d absolute). |
| `APP_ENCRYPTION_KEY` | 32 random bytes, base64-encoded. Encrypts the stored SMTP password and the SMS provider token (AES-256-GCM). **Permanent once real settings exist** — rotating it makes the stored secrets unreadable. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. |
| `STORAGE_ROOT` | Local disk path for uploaded files (both the public media pipeline and applicants' private documents). Must be an absolute path outside the deployed build directory in production (see `DEPLOYMENT-HOSTINGER.md`). |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | The first admin account. `002_seed.sql` deliberately seeds no users — `BootstrapService` creates this account (or, if it already exists, leaves it alone) on every boot. Password needs at least 8 characters. |
| `IP_HASH_SALT` | Salt for hashing visitor IPs before they're stored (contact messages, newsletter signups, sessions) — never store a raw IP. |
| `CORS_ORIGINS` | Comma-separated list of allowed origins for the (future) frontend. |
| `PUBLIC_BASE_URL` | Base URL used to build links inside emails/SMS (invite, password reset, portal links). |
| `CACHE_TTL_SECONDS`, `CACHE_MAX_ENTRIES` | The in-process response cache's TTL and entry ceiling. |
| `ALLOW_DEV_PASSWORD_FIXUP` | Dev/staging only — **refused at boot when `NODE_ENV=production`**. Lets a seeded user still holding the unusable placeholder password hash be given `BOOTSTRAP_ADMIN_PASSWORD` instead, so a fresh dev database doesn't need a real invite/accept round-trip just to sign in as a second account. |

## Database

### With Docker

```bash
docker compose up -d
```

This starts MySQL 8 on `127.0.0.1:3308` (not the default 3306 — so the
sibling `african_api` repo's own compose stack, on 3307, can run alongside
it) and a MailHog instance on `http://localhost:9026` for catching outgoing
mail in development. Point `.env`'s `DB_HOST`/`DB_PORT` at `127.0.0.1:3308`.

### Without Docker

If Docker isn't available (as in this sandbox), install MySQL or MariaDB
directly and create a database with the right collation:

```sql
CREATE DATABASE safeer CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Point `.env`'s `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` at that
instance. Everything downstream (`npm run migrate`, `npm run db:reset`, the
app itself) works identically either way — nothing in this repo assumes
Docker specifically, only a reachable MySQL-protocol server with the right
collation.

### Migrate (and seed)

```bash
npm run migrate
```

This applies every numbered file in `migrations/` in order, each inside its
own transaction, tracked in a `schema_migrations` table it creates itself.
**There is no separate seeding step that inserts data into a running
database.** The "seed" *is* `migrations/002_seed.sql` (site settings, pages,
content, mail/SMS templates — every environment) and, when
`NODE_ENV !== 'production'`, `migrations/dev/003_dev_sample.sql` (sample
partners, documents, a full spread of scholarship applications in every
status, contact messages, and 3 "legacy template" news posts for the
admin clean-up flow to act on) — both are just more numbered migration
files, and `npm run migrate` applies them the same way it applies the
schema. `npm run seed` is a *different* thing entirely: it's
`tools/seed-from-prototype.mjs`, a generator that reads
`docs/prototype/safeer-prototype.html`'s own embedded content object and
*regenerates* `002_seed.sql`/`dev/003_dev_sample.sql` on disk from it — it
needs network access (to fetch oEmbed data) and is only ever run by someone
changing what the seed contains, never as part of a normal setup. A plain
`npm run migrate` on a fresh database is all that's needed to get a fully
seeded dev environment.

`npm run migrate:status` lists every migration as `[applied]`/`[pending]`
without running anything.

`npm run db:reset` drops and recreates the configured database, then runs
`npm run migrate` — the fast way back to a known, freshly-seeded state. It
refuses to run against anything but `127.0.0.1`/`localhost`/`::1`, as a
guardrail against pointing it at a staging or production `DB_HOST` by
mistake.

## Run

```bash
npm run start:dev
```

Compiles with `tsc --watch` and runs `dist/main.js` under `nodemon`,
restarting on every rebuild. `npm run build && npm run start:prod` runs the
same compiled output without the watch loop, the way production does (see
`DEPLOYMENT-HOSTINGER.md`).

Once running:
- `GET /health` / `GET /health/ready` — liveness/readiness, outside the
  versioned API prefix.
- Swagger UI at **`/api/docs`** (development only — disabled outright when
  `NODE_ENV=production`, since the strict Content-Security-Policy would
  break its inline bootstrap script anyway and there's no value in shipping
  a blank page). The same document is committed as `openapi.json` at the
  repo root, regenerated with `npm run openapi` (see below).
- Every route lives under `/api/v1`, except `/files/:publicId[/:variant]`,
  which is deliberately outside the versioned prefix.

## Roles and the permission matrix

Four staff roles (`users.role`): `admin`, `reviewer`, `editor`, `support`.
There is no self-registration — the only way to create a staff account is
`POST admin/auth/invite` (admin-only), which emails an accept-invite link;
the very first admin comes from `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`
instead, created automatically on first boot.

| Area | admin | reviewer | editor | support |
|---|:---:|:---:|:---:|:---:|
| Applications, application docs/notes, interview slots, applications CSV export | ✅ | ✅ | | |
| Pages/sections, news, categories, work areas, board, stats, about-items, partners, doc categories, documents, media | ✅ | | ✅ | |
| Messages, testimonials, testimonial themes, newsletter subscribers | ✅ | | | ✅ |
| Users, settings, mail, audit, cache | ✅ | | | |

`GET admin/overview` adapts to the caller's role: applications figures are
hidden from editors, message figures from reviewers. `GET admin/roles`
returns this same matrix for the admin users screen to render.

## Two cookie-session systems

Staff and applicants are authenticated with two entirely separate,
non-interchangeable session systems — a staff cookie is never accepted on a
portal route, and an applicant cookie is never accepted on a staff route
(`SessionGuard` resolves each against its own table):

- **Staff** — cookie `sf_sid` (configurable), backed by the `sessions`
  table, joined to `users`. Every `/admin/*` route and the handful of
  session-authenticated non-admin routes (`GET /me`, `/auth/*`) use this.
- **Applicant** — cookie `sf_app_sid` (configurable), backed by the
  `applicant_sessions` table, joined to `applications`. Minted by
  `POST applications` (starting a new application) or
  `POST portal/auth/verify-otp` (an existing applicant signing back in).
  Every `portal/*` route carrying the `@ApplicantRoute()` decorator uses
  this instead.

Both use the same underlying mechanics (a random token, only its SHA-256
ever stored, an HMAC CSRF token derived from that hash) — just against
different cookies, tables, and lifetimes.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | `nest build` — compiles to `dist/`. |
| `npm run lint` | `oxlint src/`. |
| `npm run start` / `start:dev` / `start:prod` | Run the app (see "Run" above). |
| `npm run migrate` / `migrate:status` | Apply / list pending migrations (see "Database" above). |
| `npm run db:reset` | Drop, recreate, and re-migrate the configured database — local-only. |
| `npm run seed` | Regenerate `002_seed.sql`/`dev/003_dev_sample.sql` from the prototype — only needed when changing what the seed contains, not for normal setup. |
| `npm run openapi` | Boots the app (without listening) and writes the live Swagger document to the committed `openapi.json`. Run this after any route/DTO change. |
| `npm run openapi:check` | Regenerates the document in memory and diffs it against the committed `openapi.json` — the CI gate that catches a stale contract. |
| `npm run smoke` | Runs `scripts/smoke.mjs` against a running instance (build it, migrate/seed the database, start it, then run this in a second terminal). |
| `npm run schema:check` | `typeorm schema:log` against the compiled data source — a read-only diff between the entities and the live schema. |

## Testing

There's no unit-test suite — verification is a single, real end-to-end
smoke suite (`scripts/smoke.mjs`, wired to `npm run smoke`) that logs in as
the bootstrap admin, exercises the permission matrix, the apply flow and
reference-number sequencing, the OTP student portal (reading the one-time
code back from `sms_log` directly), private-document isolation between
applicants and between the two session systems, a full application
review-loop (submit → reject/re-upload/accept a document → interview → book
→ accept, checking the portal timeline and the `mail_log` trail), the
messages inbox (honeypot, reply, convert-to-testimonial), content
publish/reorder cache invalidation, the legacy-news bulk-delete, CSV export
encoding, and CSRF protection on both session systems. Every case cleans up
whatever rows it created. See `.github/workflows/ci.yml` for the exact
sequence CI runs (build → lint → migrate → `openapi:check` → boot → smoke).

## Deployment

See [`DEPLOYMENT-HOSTINGER.md`](DEPLOYMENT-HOSTINGER.md) for a Hostinger
Node.js hosting deployment, and [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) for
what's intentionally out of scope and any open gotchas.
