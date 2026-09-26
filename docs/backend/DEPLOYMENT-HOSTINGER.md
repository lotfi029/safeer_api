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
reason). See the [README](../../README.md)'s environment table for what each
one means; this is the production-specific subset to double-check:

- [ ] `NODE_ENV=production`
- [ ] HTTPS on both the API and the frontend. Outside development/test the session cookies are `Secure` (C32), so over plain HTTP (a staging site included) nobody can sign in.
- [ ] `PORT` — whatever Hostinger's Node.js app config expects the process to listen on.
- [ ] `DB_HOST=127.0.0.1`, `DB_PORT=3306`
- [ ] `DB_USER` / `DB_PASSWORD` / `DB_NAME` — the *running* app's account: the least-privilege one `scripts/create-app-db-user.sql` creates (bound to `127.0.0.1`).
- [ ] `MIGRATION_DB_USER` / `MIGRATION_DB_PASSWORD` — the DDL-capable account from the hosting panel's MariaDB screen, used only by `npm run migrate`. **Required** when `NODE_ENV` is `production`/`staging`: the runner refuses to fall back to `DB_USER` there.
- [ ] `APP_ENCRYPTION_KEY` — generate once with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and treat it as permanent (rotating it makes every already-stored SMTP password / SMS provider token and applicant ID number unreadable). Keep a copy outside the server (see *Backups*).
- [ ] `STORAGE_DRIVER` — `local` (default) or `s3` (see "S3 storage mode" below).
- [ ] `STORAGE_ROOT` — with `local`: an absolute path outside the deploy directory (see above).
- [ ] `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_PUBLIC`, `S3_BUCKET_PRIVATE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SIGNED_URL_TTL_SECONDS` — only with `STORAGE_DRIVER=s3`.
- [ ] `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` — the real first admin's credentials, not a placeholder; change the password immediately after first login if you ever need to hand this value to someone else during setup.
- [ ] `IP_HASH_SALT` — a real random value (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), not the CI placeholder.
- [ ] `CORS_ORIGINS` — the real frontend origin(s), comma-separated.
- [ ] `FRONTEND_BASE_URL` — the public frontend's origin (e.g. `https://<your-domain>`). Every invite, password-reset, portal and inbox link in mail/SMS is built as `${FRONTEND_BASE_URL}/{locale}/…`; the API refuses to boot without it in production/staging. It replaces the old `PUBLIC_BASE_URL`, which can be removed.
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
   a one-off deploy hook), with `MIGRATION_DB_USER`/`MIGRATION_DB_PASSWORD`
   set — this creates every table and applies `002_seed.sql` (organisation
   settings, pages, content, mail/SMS templates) and the later numbered
   files. With `NODE_ENV=production` (or `staging`),
   `migrations/dev/003_dev_sample.sql` is **not** applied — no sample
   applications, no sample contact messages, no placeholder media. That's
   intentional; nothing in `002_seed.sql` depends on the dev sample existing.
   Then run `npm run schema:check` (same env): it must print
   `Schema matches the entities`. CI runs this same production path on a
   fresh database on every push.
5. Run `scripts/create-app-db-user.sql` against the database as a
   privileged user, change its placeholder password, and set
   `DB_USER`/`DB_PASSWORD` to that least-privilege account for the
   *running* app. The DDL-capable account stays in `MIGRATION_DB_*`, for
   `npm run migrate` only.
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
[`ARCHITECTURE.md`](ARCHITECTURE.md)) — use `openapi.json` (committed at the repo root) against an
API client or Postman/Insomnia instead if you need to explore routes
interactively without a staging deployment.

## One-off: strip EXIF from media uploaded before C7

Uploads now store image originals re-encoded, with EXIF/GPS removed and the
orientation applied. Assets uploaded before that change still carry their
original metadata. After deploying, run once (dry run first):

```bash
npm run media:reprocess              # lists what would change
npm run media:reprocess -- --apply   # rewrites originals + variants, updates sizes
```

It works through `STORAGE_DRIVER` (local disk or the S3 public bucket) and
skips rows whose file is missing.

## UTC

The app, `scripts/migrate.mjs` and `scripts/db-reset.mjs` run every database
connection in UTC (`timezone: 'Z'` plus `SET time_zone = '+00:00'`), so
expiries written from JS and compared with `NOW()` agree whatever the
server's own time zone is. The app **refuses to boot** if a connection's
`NOW()` isn't UTC — check the database user can run `SET time_zone` (every
MariaDB user can) if you ever see "Database session is not UTC" in the
runtime log. Nothing needs to change on Hostinger's MariaDB itself.

Rows written before this change, by an app process whose own `TZ` wasn't
UTC, hold local times. Hostinger's Node.js processes run in UTC, so a
production database is unaffected; a dev database can simply be reset.

## Migrations

`npm run migrate` applies `migrations/*.sql` in order and records each file,
with its sha256, in `schema_migrations`.

- **Applied files are immutable.** If a file that has already run is
  edited, the next `npm run migrate` fails before applying anything and
  names the file. Revert the edit and put the change in a new numbered
  file. The first run of this runner on an older database records the
  checksum of each file already applied instead of failing.
- **Seed regeneration.** `npm run seed` rewrites `002_seed.sql` and
  `dev/003_dev_sample.sql`. Once those have run anywhere, commit a
  regenerated 002/003 only together with a new numbered migration that
  carries the same change for existing databases — and expect the checksum
  failure above on every database that already ran the old 002/003. See
  `KNOWN-ISSUES.md`.
- **One run at a time.** The runner takes `GET_LOCK('safeer_migrate')` and
  waits up to `MIGRATE_LOCK_TIMEOUT_SECONDS` (default 30) for another run to
  finish.
- `npm run migrate:status` lists every file as applied, pending or CHANGED,
  and writes nothing.

### Recovering from a half-applied migration

Each file runs in a transaction, but MariaDB/MySQL commit every DDL
statement (`CREATE`, `ALTER`, `DROP`, `RENAME`) implicitly. If a file with
several DDL statements fails part-way, the statements before the failure
stay applied and the file is **not** recorded in `schema_migrations`, so a
plain re-run would try the already-applied statements again and fail.

1. Take a `mysqldump` before touching anything.
2. Read the failing file and the error `npm run migrate` printed. Compare
   the file's statements with the live schema (`SHOW CREATE TABLE <t>`) to
   find which ones already ran.
3. Either finish the file by hand (run the remaining statements in order)
   and mark it applied —
   `INSERT INTO schema_migrations (version, checksum) VALUES ('<file>', NULL);`
   (the next migrate records the checksum) — or undo the statements that
   ran, fix the file, and re-run `npm run migrate`.
4. Run `npm run migrate:status` and `npm run schema:check` to confirm the
   schema matches.

Keep future DDL migrations to one logical change per file, so a failure
leaves at most one statement to reason about.

## SMS provider (Unifonic)

OTP codes and applicant notifications go out by SMS through the driver set
in `admin/sms/settings` (`PUT /api/v1/admin/sms/settings`, admin only):

- `driver: 'unifonic'`, `token` = the Unifonic account's **AppSid**
  (stored encrypted with `APP_ENCRYPTION_KEY`), `senderName` = the approved
  **SenderID**. `providerUrl` is optional and overrides the default endpoint
  (`https://el.cloud.unifonic.com/rest/SMS/messages`).
- `isEnabled: true`, then `POST /api/v1/admin/sms/test` sends a test
  message and reports the provider's answer.
- The seeded default is `driver: 'log'`, which writes `sms_log` and sends
  nothing. With `log` in production, OTP requests fall back to email.
- `driver: 'http'` remains for a generic JSON gateway (URL + bearer token).
- Every provider call has a 5-second timeout. Notification SMS are queued
  and sent in the background (`sms_log` shows `queued` → `sent`/`failed`);
  only the OTP request waits for the result, and falls back to email if the
  SMS isn't sent. SMS always go to the applicant's E.164 number.
- OTP codes are never stored: `sms_log.message` and `mail_log.subject`
  hold `••••••` in their place, and no OTP mail payload is kept for retries.
  (In development/test only, `GET /api/v1/__dev/otp/:applicationId` returns
  the last code for the smoke and Jest suites; the route is a 404 elsewhere.)

## S3 storage mode

With `STORAGE_DRIVER=s3`, uploads go to two buckets on any S3-compatible
endpoint instead of `STORAGE_ROOT`:

- `S3_BUCKET_PUBLIC` — the public media pipeline (served through
  `/files/:publicId[/:variant]`).
- `S3_BUCKET_PRIVATE` — applicants' scholarship documents. **Never make this
  bucket public.** The guarded routes (`/portal/documents/:id/file`,
  `/admin/applications/:id/documents/:docId/file`) still check the session
  and ownership, then redirect (302) to a signed GET URL valid for
  `S3_SIGNED_URL_TTL_SECONDS` (default 300).
- Every `S3_*` variable is required at boot when `STORAGE_DRIVER=s3`
  (`src/config/env.ts`).
- `GET /health/ready` checks both buckets with a `HeadBucket` (local mode:
  that `STORAGE_ROOT` is writable), so wrong credentials or a missing bucket
  show up as `storage: down` before the first upload fails.
- The access key needs `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and
  `s3:ListBucket` (for `HeadBucket`) on both buckets, nothing else. A delete
  that fails (for example, a missing permission) is logged and never fails the
  request that triggered it. Watch the log for `Could not delete s3://…`.

## Backups

A cron-scheduled `mysqldump` for the database plus `npm run backup:storage`
for uploaded files, via Hostinger's cron job feature or SSH's own crontab.
All times below are **server time**; keep the host on UTC (see *UTC*).

### Database (C28)

Keep the credentials out of the command line (and so out of `ps` and the
cron log) in `~/.my.cnf`, readable only by you:

```ini
# ~/.my.cnf   (chmod 600 ~/.my.cnf)
[mysqldump]
host=127.0.0.1
user=<backup_user>          # SELECT, LOCK TABLES, SHOW VIEW, TRIGGER on <db_name>
password=<backup_password>
```

```bash
# Daily at 03:30 — after the 03:00 maintenance job (retention purge) — keeping 14 days.
30 3 * * * mysqldump --single-transaction --quick --routines --triggers --default-character-set=utf8mb4 <db_name> \
  | gzip > /home/<hostinger-username>/backups/safeer-$(date +\%Y\%m\%d).sql.gz \
  && find /home/<hostinger-username>/backups -name 'safeer-*.sql.gz' -mtime +14 -delete
```

`--single-transaction` takes a consistent InnoDB snapshot without locking
the tables the app is writing to. `--quick` streams rows instead of
buffering whole tables in memory.

**Offsite, encrypted copy.** A backup that lives on the same server doesn't
survive losing that server. Copy each dump elsewhere, encrypted, e.g. with
`age` or `gpg --symmetric` before upload. The dump holds applicant PII: names,
phone numbers, e-mail addresses. The ID number column is already AES-256-GCM
encrypted with `APP_ENCRYPTION_KEY` (C28), but the rest is plain text.

**`APP_ENCRYPTION_KEY` is part of the backup.** Without it, the restored
ID numbers, SMTP password and SMS token can't be decrypted. Store the key
separately from the dumps, e.g. in the association's password manager, never
in the same archive.

**Test the restore** at least once after setting this up, and after any
schema change of note: restore into a scratch database, point a local
checkout at it with the production `APP_ENCRYPTION_KEY`, and open an
application in the admin.

```bash
mysql -e 'CREATE DATABASE safeer_restore_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
gunzip -c safeer-YYYYMMDD.sql.gz | mysql safeer_restore_test
```

### Uploaded files

`STORAGE_DRIVER=local`: `scripts/backup-storage.mjs` writes a dated
`safeer-storage-<timestamp>.tar.gz` of `STORAGE_ROOT`:

```bash
# Daily at 03:45, keeping 14 days of archives.
45 3 * * * cd /path/to/safeer_api && NODE_ENV=production node scripts/backup-storage.mjs /home/<hostinger-username>/backups \
  >> /home/<hostinger-username>/logs/safeer-storage-backup.log 2>&1 \
  && find /home/<hostinger-username>/backups -name 'safeer-storage-*.tar.gz' -mtime +14 -delete
```

The archive holds applicants' private documents, so it gets the same
encrypted offsite copy as the dump.

With `STORAGE_DRIVER=s3`, the script prints a message and does nothing. Use
the provider's own versioning or replication for both buckets.

## Data retention (C27)

`MaintenanceService` runs nightly at 03:00 (server time) inside the app
process. Nothing extra needs scheduling. It deletes:

| Data | Kept for |
|---|---|
| Expired staff/applicant sessions, spent auth tokens and OTPs | until expiry |
| `mail_log` | 90 days (a reply's delivery status is first copied onto `message_replies`) |
| `sms_log` | 90 days |
| Contact messages | 24 months |
| Draft applications nobody touched | 180 days (their uploaded files are deleted too) |
| Newsletter rows unsubscribed, or never confirmed | 30 days |

Submitted applications are never deleted by age. When an applicant asks
for their data to be removed, an admin uses `DELETE admin/applications/:id`.
That anonymises the row (the reference and status stay, for the figures)
and deletes its documents and their files, notes, events and mail/SMS logs.
The action is audited.

Backups keep deleted data for their own 14 days, which the privacy notice
should mention.

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
  (rotating it makes every stored SMTP password / SMS provider token, and
  every applicant ID number (C28), unreadable, not just newly-written ones). If it's ever changed by
  mistake, the fix is re-entering the SMTP password and SMS provider token
  through `admin/mail/settings`/`admin/sms/settings` after rolling the key
  back — there is no way to recover a secret encrypted under a key that's
  since been discarded.
