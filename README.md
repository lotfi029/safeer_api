# Safeer API

NestJS 11 + TypeORM + MySQL/MariaDB REST API for the Safeer Association: the
public site, the passwordless student portal (scholarship applications) and
the staff admin dashboard. Every route lives under `/api/v1` except `/health`
and `/files/:publicId[/:variant]`. Swagger UI is served at `/api/docs` outside
production; the same contract is committed as `openapi.json`.

## Prerequisites

- Node.js `^22.22.2` or `>=24.15.0`.
- MySQL 8 or MariaDB with `utf8mb4_unicode_ci` as the database collation.
- Docker (optional).

## Setup

```bash
cp .env.example .env          # then fill in every value (table below)
docker compose up -d          # MySQL on 127.0.0.1:3308 + MailHog on :9026 (optional)
npm ci
npm run migrate               # schema + seed (+ dev sample data when NODE_ENV != production)
npm run start:dev
```

Without Docker, create the database yourself:

```sql
CREATE DATABASE safeer CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Migrations are numbered SQL files in `migrations/` (plus `migrations/dev/`,
skipped in production), applied in order and tracked in `schema_migrations`.
The first admin account is created on boot from `BOOTSTRAP_ADMIN_EMAIL` /
`BOOTSTRAP_ADMIN_PASSWORD`.

## Environment

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
| `STORAGE_ROOT` | Local disk path for uploaded files (both the public media pipeline and applicants' private documents). Must be an absolute path outside the deployed build directory in production. |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | The first admin account. `002_seed.sql` deliberately seeds no users — `BootstrapService` creates this account (or, if it already exists, leaves it alone) on every boot. Password needs at least 8 characters. |
| `IP_HASH_SALT` | Salt for hashing visitor IPs before they're stored (contact messages, newsletter signups, sessions) — never store a raw IP. |
| `CORS_ORIGINS` | Comma-separated list of allowed origins for the (future) frontend. |
| `PUBLIC_BASE_URL` | Base URL used to build links inside emails/SMS (invite, password reset, portal links). |
| `CACHE_TTL_SECONDS`, `CACHE_MAX_ENTRIES` | The in-process response cache's TTL and entry ceiling. |
| `ALLOW_DEV_PASSWORD_FIXUP` | Dev/staging only — **refused at boot when `NODE_ENV=production`**. Lets a seeded user still holding the unusable placeholder password hash be given `BOOTSTRAP_ADMIN_PASSWORD` instead, so a fresh dev database doesn't need a real invite/accept round-trip just to sign in as a second account. |
| `PROTOTYPE_PATH` | `npm run seed` only — path to the prototype HTML, which is kept outside the repo. Default `../../docs/safeer-prototype.html`, resolved against the repo root. |

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | `nest build` — compiles to `dist/`. |
| `npm run lint` | `oxlint src/`. |
| `npm run start` / `start:dev` / `start:prod` | Run the app (see "Run" above). |
| `npm run migrate` / `migrate:status` | Apply / list pending migrations (see "Database" above). |
| `npm run db:reset` | Drop, recreate, and re-migrate the configured database — local-only. |
| `npm run seed` | Regenerate `002_seed.sql`/`dev/003_dev_sample.sql` from the prototype at `PROTOTYPE_PATH` (needs network for oEmbed). Only for changing the seed content — never part of normal setup. |
| `npm run openapi` | Boots the app (without listening) and writes the live Swagger document to the committed `openapi.json`. Run this after any route/DTO change. |
| `npm run openapi:check` | Regenerates the document in memory and diffs it against the committed `openapi.json` — the CI gate that catches a stale contract. |
| `npm run smoke` | Runs `scripts/smoke.mjs` against a running instance (build it, migrate/seed the database, start it, then run this in a second terminal). |
| `npm run schema:check` | `typeorm schema:log` against the compiled data source — a read-only diff between the entities and the live schema. |

## Deployment

Deployment notes (Hostinger), known issues and project documentation live
outside this repository, in the project's `docs/` folder.
