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
npm run migrate               # schema + seed (+ dev sample data when NODE_ENV is development/test)
npm run start:dev
```

Without Docker, create the database yourself:

```sql
CREATE DATABASE safeer CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Migrations are numbered SQL files in `migrations/` (plus `migrations/dev/`,
applied only when `NODE_ENV` is `development` or `test`), applied in order and
tracked in `schema_migrations` with a sha256 per file. An applied file is
immutable: editing one makes `npm run migrate` fail, and the change goes in a
new numbered file instead. The database connection is always UTC.
The first admin account is created on boot from `BOOTSTRAP_ADMIN_EMAIL` /
`BOOTSTRAP_ADMIN_PASSWORD`.

## Environment

| Variable | Meaning |
|---|---|
| `NODE_ENV` | `development` \| `test` \| `staging` \| `production`. No default — deliberately: it gates both the session cookie's `Secure` flag and whether `ALLOW_DEV_PASSWORD_FIXUP` is even permitted. |
| `PORT` | HTTP port the API listens on. |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL/MariaDB connection used by the app. In production, a least-privilege account (`scripts/create-app-db-user.sql`). |
| `MIGRATION_DB_USER`, `MIGRATION_DB_PASSWORD` | DDL-capable account for `npm run migrate` / `db:reset`. Required when `NODE_ENV` is `staging`/`production`; in `development`/`test` they fall back to `DB_USER`/`DB_PASSWORD`. |
| `SESSION_COOKIE_NAME` | Staff session cookie name (default `sf_sid`). |
| `SESSION_IDLE_HOURS`, `SESSION_ABSOLUTE_DAYS` | Staff session lifetime (default 8h idle / 30d absolute). |
| `APPLICANT_SESSION_COOKIE_NAME` | Student-portal session cookie name (default `sf_app_sid`) — see [`docs/backend/ARCHITECTURE.md`](docs/backend/ARCHITECTURE.md). |
| `APPLICANT_SESSION_IDLE_HOURS`, `APPLICANT_SESSION_ABSOLUTE_DAYS` | Applicant session lifetime (default 12h idle / 7d absolute). |
| `APP_ENCRYPTION_KEY` | 32 random bytes, base64-encoded. Encrypts the stored SMTP password and the SMS provider token (AES-256-GCM). **Permanent once real settings exist** — rotating it makes the stored secrets unreadable. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. |
| `STORAGE_ROOT` | Local disk path for uploaded files (both the public media pipeline and applicants' private documents). Must be an absolute path outside the deployed build directory in production. Only used when `STORAGE_DRIVER=local`. |
| `STORAGE_DRIVER` | `local` (default) or `s3`. See `S3_*` below. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_PUBLIC`, `S3_BUCKET_PRIVATE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Required only when `STORAGE_DRIVER=s3` — any S3-compatible endpoint, two buckets (public assets, private applicant documents). |
| `S3_SIGNED_URL_TTL_SECONDS` | How long a signed GET URL for a private document stays valid in S3 mode (default 300). |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | The first admin account. `002_seed.sql` deliberately seeds no users — `BootstrapService` creates this account (or, if it already exists, leaves it alone) on every boot. Password needs at least 8 characters. |
| `IP_HASH_SALT` | Salt for hashing visitor IPs before they're stored (contact messages, newsletter signups, sessions) — never store a raw IP. |
| `CORS_ORIGINS` | Comma-separated list of allowed origins for the (future) frontend. |
| `FRONTEND_BASE_URL` | The public frontend's origin. Every link sent by mail or SMS points at a locale-prefixed page there: `/{locale}/admin/accept/{token}`, `/{locale}/admin/reset/{token}`, `/{locale}/admin/messages/{id}`, `/{locale}/portal/login`. Required when `NODE_ENV` is `staging`/`production`; defaults to `http://localhost:4200` otherwise. (Replaces `PUBLIC_BASE_URL`.) |
| `CACHE_TTL_SECONDS`, `CACHE_MAX_ENTRIES` | The in-process response cache's TTL and entry ceiling. |
| `ALLOW_DEV_PASSWORD_FIXUP` | Dev/staging only — **refused at boot when `NODE_ENV=production`**. Lets a seeded user still holding the unusable placeholder password hash be given `BOOTSTRAP_ADMIN_PASSWORD` instead, so a fresh dev database doesn't need a real invite/accept round-trip just to sign in as a second account. |
| `PROTOTYPE_PATH` | `npm run seed` only — optional override for the prototype HTML. Default `docs/prototype/safeer-prototype.html`; relative paths resolve against the repo root. |

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | `nest build` — compiles to `dist/`. |
| `npm run lint` | `oxlint src/`. |
| `npm run start` / `start:dev` / `start:prod` | Run the app (see [`docs/backend/ARCHITECTURE.md`](docs/backend/ARCHITECTURE.md)). |
| `npm run migrate` / `migrate:status` | Apply pending migrations / list them as applied, pending or changed. Takes a `GET_LOCK`, so concurrent runs wait for each other. |
| `npm run db:reset -- --confirm=<DB_NAME>` | Drop, recreate, and re-migrate the configured database. Local `DB_HOST`, `NODE_ENV` development/test, and the database named in `--confirm` only. |
| `npm run seed` | Regenerate `002_seed.sql`/`dev/003_dev_sample.sql` from the prototype at `PROTOTYPE_PATH` (needs network for oEmbed). Only for changing the seed content — never part of normal setup. |
| `npm run openapi` | Boots the app (without listening) and writes the live Swagger document to the committed `openapi.json`. Run this after any route/DTO change. |
| `npm run openapi:check` | Regenerates the document in memory and diffs it against the committed `openapi.json` — the CI gate that catches a stale contract. |
| `npm run smoke -- --confirm=<DB_NAME>` | Runs `scripts/smoke.mjs` against a running instance (build it, migrate/seed the database, start it, then run this in a second terminal). It writes rows directly, so it has the same `NODE_ENV` and `--confirm` guard as `db:reset`. |
| `npm test` | Jest + supertest HTTP tests (`test/*.spec.ts`) against a dedicated, real MySQL database (`<DB_NAME>_test`, recreated each run) and a real running instance of the app, started with `TZ=Asia/Riyadh` on purpose (`test/global-setup.ts`). Needs `npm run build` first and a DB user that can create databases. |
| `npm run check:admin-roles` | Fails if any `admin/*` route has no `@Roles()` and isn't explicitly allow-listed (`scripts/lib/check-admin-roles.mjs`). Needs a migrated database, like `openapi:check`. |
| `npm run backup:storage` | `STORAGE_DRIVER=local`: tars `STORAGE_ROOT`. `STORAGE_DRIVER=s3`: no-op (the provider's own job). |
| `npm run schema:check` | `typeorm schema:log` against the compiled data source — a read-only diff between the entities and the live schema. |

## Docs

Project documentation lives in [`docs/`](docs/):

- [`docs/backend/ARCHITECTURE.md`](docs/backend/ARCHITECTURE.md) — roles and the permission matrix, the two cookie-session systems, UTC.
- [`docs/backend/DEPLOYMENT-HOSTINGER.md`](docs/backend/DEPLOYMENT-HOSTINGER.md) — production deployment, env checklist, SMS/S3 setup, migrations, backups.
- [`docs/backend/KNOWN-ISSUES.md`](docs/backend/KNOWN-ISSUES.md) — out-of-scope items and gotchas.
- [`docs/safeer-design-spec.md`](docs/safeer-design-spec.md), [`docs/safeer-implementation-prompt.md`](docs/safeer-implementation-prompt.md) — the product spec and build brief.
- [`docs/safeer-backend-fr-review.md`](docs/safeer-backend-fr-review.md), [`docs/safeer-backend-fix-prompt.md`](docs/safeer-backend-fix-prompt.md) — the review and the current fix plan.
- [`docs/prototype/safeer-prototype.html`](docs/prototype/safeer-prototype.html) — the clickable prototype `npm run seed` reads.
