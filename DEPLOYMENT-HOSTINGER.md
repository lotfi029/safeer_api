# Deploying to Hostinger (Node.js hosting)

This describes deploying `safeer_api` to a Hostinger Node.js hosting plan —
LiteSpeed running the app under PM2/`lsnode.js`, a MariaDB database on the
same account, and a `.env` set from the hosting panel's environment-variable
screen. It assumes the reader has a Hostinger hosting account with Node.js
hosting already provisioned; it does not cover buying the plan itself.

## Why MariaDB, and why 127.0.0.1

Hostinger's shared/Node.js hosting plans provision **MariaDB**, not MySQL.
This codebase never distinguishes between them — every table in
`migrations/001_schema.sql` and every query built by TypeORM or hand-written
SQL uses the same `utf8mb4_unicode_ci` collation on both, and `mysql2` (the
driver `scripts/migrate.mjs`/`scripts/db-reset.mjs`/the app itself all use)
speaks MariaDB's wire protocol identically to MySQL's for everything this
app does. The one thing to get right is the connection target: **the
database runs on the same server as the app**, so `DB_HOST` must be
`127.0.0.1` (not `localhost`, which can resolve to `::1`/IPv6 depending on
the host's `/etc/hosts`, and not every database user is granted access from
that address) and `DB_PORT` is `3306`.

## No top-level await

`src/main.ts` deliberately does **not** call `await bootstrap()` at the top
of the module — it calls `bootstrap().catch(...)` instead, with a comment
explaining why: Hostinger's Node.js runtime loads the app through
LiteSpeed's `/usr/local/lsws/fcgi-bin/lsnode.js`, which `require()`s the
entry file. Node can `require()` an ESM module graph, but not one containing
a top-level `await` anywhere in it — that throws
`ERR_REQUIRE_ASYNC_MODULE` before a single line of `bootstrap()` runs, and
the only visible symptom is a 503 with that error buried in the runtime log.
This is already correct in this repository; if you ever see that error after
editing `main.ts`, this is almost certainly why — do not "simplify" the
`.catch()` back into a top-level `await`.

## `.npmrc`: `include=dev`

Hostinger's build step runs with the same `NODE_ENV` the running app uses.
Since `src/config/env.ts` refuses to boot without `NODE_ENV` set, production
deployments set `NODE_ENV=production` — which makes npm's `omit` default to
`dev`, silently skipping `@nestjs/cli` and `typescript`, both
`devDependencies` the build itself needs (`nest build` fails outright with
"command not found"). `.npmrc`'s `include=dev` is already committed and
overrides that regardless of how `omit` gets set. Leave it as-is; the
tradeoff (devDependencies stay in `node_modules` at runtime, since the build
output *is* the deployed directory here) is intentional and documented
inline.

## `STORAGE_ROOT` must be an absolute path outside the build directory

Every Node.js deploy on Hostinger replaces the application's directory
contents on each new build/deploy. If `STORAGE_ROOT` (uploaded media, and
applicants' private scholarship documents under
`STORAGE_ROOT/private/applications/<id>/...`) points anywhere inside that
directory — including the default `./var/assets`, which is *relative to
the process's working directory*, i.e. the deploy directory — every
uploaded file is deleted the next time you deploy. Set it to an absolute
path outside the app's own directory tree, e.g.:

```
STORAGE_ROOT=/home/<hostinger-username>/safeer-storage
```

Create that directory once (via the hosting panel's file manager or SSH) and
make sure the Node.js process's user can write to it before the first
deploy — `MediaService`/`PrivateFileStore` both call `mkdir(..., { recursive: true })`
under it, but the top-level directory itself must already exist and be
writable.

## Environment variable checklist

Set every one of these in Hostinger's Node.js app → Environment variables
screen (never commit real values — `.env` is gitignored for exactly this
reason). See `README.md`'s environment table for what each one means; this
is the production-specific subset to double-check:

- [ ] `NODE_ENV=production`
- [ ] `PORT` — whatever Hostinger's Node.js app config expects the process to listen on.
- [ ] `DB_HOST=127.0.0.1`, `DB_PORT=3306`
- [ ] `DB_USER` / `DB_PASSWORD` / `DB_NAME` — from the hosting panel's MariaDB database screen. Use the DDL-capable account only to run `npm run migrate` once (from SSH, or a one-off deploy hook); switch the *running* app to the least-privilege account `scripts/create-app-db-user.sql` creates for everyday traffic.
- [ ] `APP_ENCRYPTION_KEY` — generate once with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and treat it as permanent (rotating it makes every already-stored SMTP password / SMS provider token unreadable).
- [ ] `STORAGE_ROOT` — an absolute path outside the deploy directory (see above).
- [ ] `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` — the real first admin's credentials, not a placeholder; change the password immediately after first login if you ever need to hand this value to someone else during setup.
- [ ] `IP_HASH_SALT` — a real random value (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), not the CI placeholder.
- [ ] `CORS_ORIGINS` — the real frontend origin(s), comma-separated.
- [ ] `PUBLIC_BASE_URL` — the API's own public URL (used to build links inside invite/reset/portal emails).
- [ ] `CACHE_TTL_SECONDS` / `CACHE_MAX_ENTRIES` — the defaults (60 / 500) are reasonable; only change them with the in-process-cache caveat below in mind.
- [ ] `ALLOW_DEV_PASSWORD_FIXUP` — **must be `false` (or unset)**. The env schema refuses to boot at all if this is `true` while `NODE_ENV=production`, as a hard backstop, but don't rely on that — it should never be set here in the first place.

## `instances: 1` is not a performance knob

`ecosystem.config.cjs` pins `instances: 1` / `exec_mode: 'fork'`. This is
required, not just a default: the response cache (`CacheService`) is an
in-process LRU. Under more than one instance or cluster mode, a cache purge
(an editor publishing a change) only clears the worker that handled the
write — every other worker keeps serving the stale page for up to
`CACHE_TTL_SECONDS`, intermittently, depending on which worker answers the
next request. If Safeer ever needs more than one process, the cache moves
to something shared (Redis) first — `CacheService`'s
`get`/`set`/`purgeTag` interface is the seam to swap behind — before
raising `instances`.

## First-deploy checklist

1. Provision a MariaDB database from the Hostinger panel; note its host
   (should resolve to `127.0.0.1` from the app), port (`3306`), database
   name, and a DDL-capable user/password.
2. Set every environment variable from the checklist above.
3. Deploy the code (Hostinger's Git-based deploy, or upload a build). Ensure
   the build step runs `npm ci && npm run build` (Hostinger's Node.js app
   settings screen lets you set the build command).
4. Run `npm run migrate` once against the production database (via SSH, or
   a one-off deploy hook) — this creates every table and applies
   `002_seed.sql` (organisation settings, pages, content, mail/SMS
   templates). `NODE_ENV=production` means `migrations/dev/003_dev_sample.sql`
   is **not** applied — no sample applications, no sample contact messages,
   no placeholder media. That's intentional; nothing in `002_seed.sql`
   depends on the dev sample existing.
5. (Recommended) Run `scripts/create-app-db-user.sql` against the database
   as a privileged user, change its placeholder password, and switch
   `DB_USER`/`DB_PASSWORD` to that least-privilege account for the
   *running* app — keep the DDL-capable account only for future
   `npm run migrate` runs.
6. Create the `STORAGE_ROOT` directory (see above) and confirm the app's
   process user can write to it.
7. Start the app (or let Hostinger's Node.js app runner start it — it should
   invoke `node dist/main.js`, the same entry `npm run start:prod` uses).
8. Verify (see below).
9. Sign in as `BOOTSTRAP_ADMIN_EMAIL` and invite any other staff accounts
   through `POST admin/auth/invite` — `AcceptInviteDto` needs the emailed
   token, so confirm outbound mail is actually configured (`admin/mail/settings`,
   `driver: 'smtp'`) before relying on that flow for a real team.

## Verification

```bash
# Liveness/readiness (outside the versioned API prefix):
curl -s https://<your-domain>/health
curl -s https://<your-domain>/health/ready
# {"status":"ok","checks":{"database":"up","storage":"up"}}

# Public site aggregate:
curl -s https://<your-domain>/api/v1/home | head -c 300

# Staff login (replace with the real bootstrap admin credentials):
curl -s -c /tmp/safeer-cookies.txt -X POST https://<your-domain>/api/v1/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<BOOTSTRAP_ADMIN_EMAIL>","password":"<BOOTSTRAP_ADMIN_PASSWORD>"}'
# {"user":{...},"csrfToken":"..."}

# A cookie-authenticated read:
curl -s -b /tmp/safeer-cookies.txt https://<your-domain>/api/v1/admin/overview | head -c 300
```

Swagger UI (`/api/docs`) is disabled in production on purpose (see
`README.md`) — use `openapi.json` (committed at the repo root) against an
API client or Postman/Insomnia instead if you need to explore routes
interactively without a staging deployment.

## Backups

There is no automated backup tooling in this repository (see
`KNOWN-ISSUES.md`). The recommended baseline for a first production
deployment is a cron-scheduled `mysqldump`, e.g. via Hostinger's cron job
feature or SSH's own crontab:

```bash
# Daily at 03:00 server time, keeping 14 days of dumps.
0 3 * * * mysqldump -h 127.0.0.1 -u <db_user> -p'<db_password>' <db_name> \
  | gzip > /home/<hostinger-username>/backups/safeer-$(date +\%Y\%m\%d).sql.gz \
  && find /home/<hostinger-username>/backups -name 'safeer-*.sql.gz' -mtime +14 -delete
```

This backs up the **database only** — it does not cover `STORAGE_ROOT`
(uploaded media and private scholarship documents). Back that directory up
separately (e.g. the same cron job `tar`-ing it alongside the dump) if the
uploaded files matter as much as the database rows referencing them.

## Rollback

- **Code**: redeploy the previous known-good commit/build through
  Hostinger's deploy mechanism (Git-based deploys keep prior commits
  reachable; a manual upload should keep the previous build archived
  somewhere before overwriting it).
- **Database**: migrations in this repo are forward-only — there is no
  down-migration tooling. Rolling back a schema change means restoring the
  most recent `mysqldump` backup taken before that migration ran, then
  redeploying the matching (older) code. Because `scripts/migrate.mjs`
  tracks applied migrations in `schema_migrations` by filename, restoring an
  older dump that predates a later migration and then running the *newer*
  code against it will leave the schema out of sync — always roll code and
  database back together, never one without the other.
- **A bad `APP_ENCRYPTION_KEY` change**: this key is permanent by design
  (rotating it makes every stored SMTP password / SMS provider token
  unreadable, not just newly-written ones). If it's ever changed by
  mistake, the fix is re-entering the SMTP password and SMS provider token
  through `admin/mail/settings`/`admin/sms/settings` after rolling the key
  back — there is no way to recover a secret encrypted under a key that's
  since been discarded.
