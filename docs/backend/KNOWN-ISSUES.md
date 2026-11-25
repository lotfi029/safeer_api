# Known issues and out-of-scope items

## Out of scope (per the project plan)

- **No frontend.** This repository is the REST API only. The prototype at
  `docs/prototype/safeer-prototype.html` describes the intended UI; nothing
  here renders it.
- **Backups are a cron-scheduled script, not a managed service.**
  `deploy/backup.sh` (`DEPLOYMENT-VPS.md` §6) dumps the database and tars
  the storage volume nightly; restoring is the manual procedure in its
  header. There is no point-in-time recovery. In S3 mode the buckets'
  durability is the provider's job.
- **`npm run seed` rewrites `002_seed.sql` / `dev/003_dev_sample.sql`,**
  which `npm run migrate` now treats as immutable once applied (a sha256 per
  file). A regenerated 002/003 that differs from what a database already ran
  fails that database's next migrate. Seed changes for existing databases
  go in a new numbered migration.
- **No `@ApiOkResponse` schemas.** Every route's request DTO is fully typed
  in `openapi.json` (nestjs-zod generates those from the same zod schemas
  the `ZodValidationPipe` validates against), but no route declares an
  explicit response schema — Swagger/`openapi.json` shows response bodies as
  untyped/`any`. A generated frontend API client gets full type safety on
  what it sends, none on what it gets back.

## Gotchas worth knowing about

- **`z.date()` / `z.coerce.date()` crash OpenAPI generation, silently, at
  boot-time-adjacent code — not at the route that uses it.** zod v4's
  `toJSONSchema()` (which `nestjs-zod`'s OpenAPI metadata factory calls) has
  no JSON-Schema representation for a native `Date`, and throws "Date cannot
  be represented in JSON Schema" for *any* `z.date()`, coerced or not. This
  doesn't show up as a validation bug — `z.coerce.date()` works fine for
  actually validating a request — it shows up as `npm run openapi`/
  `npm run openapi:check` crashing outright, with a stack trace that points
  into `zod`/`nestjs-zod` internals rather than at the offending DTO. The
  one place that needed a real datetime value (the interview-slot DTO,
  removed with the scholarship feature in 021) used
  `z.iso.datetime({ offset: true })` instead — a validated ISO 8601 string. TypeORM's mysql driver already parses a string the same as a
  `Date` instance when persisting a `datetime` column, so nothing downstream
  needs the value pre-converted to an actual `Date`. **If you add a new DTO
  field that needs a full date-and-time value, use
  `z.iso.datetime({ offset: true })` (or a stricter/looser variant of it),
  never `z.date()`/`z.coerce.date()`** — a date-*only* field (`YYYY-MM-DD`,
  e.g. `applications.birth_date`) is fine as a plain
  `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`, since that never touches the
  `Date`-in-JSON-Schema problem at all. A full sweep of `src/` for both
  patterns (phase 8 of the project plan) found no other instance — this file
  is where the next one should be checked against before it reaches CI.
- **Production runs on MySQL 8.4** (S4: the VPS deploy, `DEPLOYMENT-VPS.md`),
  and so do `docker-compose.yml` (bound to `127.0.0.1:3308`) and CI. The
  earlier target, Hostinger's Node.js hosting, provisioned MariaDB, which is
  why the code is still engine-neutral: `utf8mb4_unicode_ci` throughout, and
  every connection turns MariaDB's `SIMULTANEOUS_ASSIGNMENT` off (A3; a no-op
  on MySQL). The MariaDB CI leg was dropped with the move, so MariaDB is no
  longer tested.
- **Dev database 8.0 → 8.4 is a one-way upgrade.** An existing `dbdata`
  volume created by the old `mysql:8.0` image is upgraded in place on the
  first 8.4 start and can't go back. Dump it first if you need it, or start
  clean with `docker compose down -v`.
- **The CI workflow's dev-fixture comments predate Safeer's actual seed
  shape.** `.github/workflows/ci.yml` was ported from `african_api`
  (whose dev sample seeds a couple of editor accounts) in phase 1 and, until
  this pass, still described `ALLOW_DEV_PASSWORD_FIXUP`/`NODE_ENV=development`
  as being there for "the seeded editor" to sign in with for role-gate smoke
  cases. Safeer's own `002_seed.sql`/`migrations/dev/003_dev_sample.sql`
  seed **zero** users on purpose (`BootstrapService`'s own header comment
  says so directly) — the only account either one ever produces is the
  bootstrap admin. `scripts/smoke.mjs`'s permission cases create their
  own temporary editor/support/custom-role accounts by a direct row insert
  (hashing a known password with the same Argon2id `PasswordService` uses,
  since the invite-and-accept-token email flow has no way to hand a raw
  token back to an unattended script when mail is disabled by default). This
  pass corrected the stale comments; `NODE_ENV=development` is still needed,
  for a different, real reason — the legacy-news bulk-delete smoke case
  needs `dev/003_dev_sample.sql`'s 3 "legacy template" posts to have
  anything to act on.
- **Locking transactions have no deadlock retry.** Staff login and users
  (`auth.service.ts`, `users.service.ts` — the admin set and the target are
  locked together), roles (`roles.service.ts`) and the maintenance purge take
  `FOR UPDATE` locks with no retry on error 1213. (`withTransactionRetry`,
  added for the old applications flow, went with it in A2.) None has been
  seen deadlocking. If one does, fix the lock order first, then add a retry
  around the transaction only (never around anything after its commit).
- **`npm audit` state** (PERM-0, 2026-11-25: Nest 11.2.12 with multer
  2.5.0, zod 4.6.7, body-parser 2.4.0, undici 8.13.1, js-yaml 5.5.0 via
  swagger).
  - *Runtime (what the Docker image installs):*
    `npm_config_include=prod npm audit --omit=dev` finds 0 vulnerabilities.
  - *Dev tooling only:* `glob`/`minimatch` via `@nestjs/cli`, Jest and
    `nodemon` (moderate, ReDoS on patterns we write ourselves). The fixes are
    major bumps of those tools. None of it is in the image's runtime stage
    (the Dockerfile installs with `--omit=dev` and without this repo's
    `.npmrc`).
  - A plain `npm audit --omit=dev` still lists the dev chain: this repo's
    `.npmrc` sets `include=dev`, which wins over `--omit=dev`. Override it as
    above to audit what production installs.

- **`users.role` is a leftover column until migration 025** (PERM-1).
  024 keeps the pre-roles enum, now NULL-able, and the app writes it on
  every role assignment (the system role's key, or NULL for a custom role)
  so the previous image can still run if v1.1.0 has to be rolled back. While
  rolled back, that image can't invite anyone (it doesn't set `role_id`,
  which is NOT NULL), and a role change it makes doesn't reach `role_id`;
  users on a custom role (`role` NULL) are refused everywhere by it. Restore
  the pre-deploy backup instead if any of that matters (`DEPLOYMENT-VPS.md`
  §8, "Upgrading to v1.1.0"). 025 drops the column once the window closes.
- **Permissions are re-read on every staff request** (PERM-3): `SessionGuard`
  joins the role and its permissions into the session lookup it already
  did, so a role edit applies at once with no cache to invalidate. That
  costs two extra joins per staff request; the dashboard's traffic makes it
  negligible.

## Resolved during this pass (noted for context)

- **`escapeLikeValue()` duplication.** It was duplicated identically in
  `src/common/crud/crud.factory.ts` (the CRUD kernel's own `?q=` search) and
  `src/admin-applications/admin-applications.service.ts` (the hand-written
  applications list/CSV search) — not three call sites as an earlier phase's
  hand-back note described (the messages module has no free-text search at
  all, so there was nothing to extract there). Both real call sites now
  import a single definition from `src/common/query/list-params.ts`,
  alongside the `asString`/`readPageLimit` helpers it already held.
- **`scripts/create-app-db-user.sql` only covered the first-phase schema.**
  Ported from `african_api` in phase 1 with a `TODO(phase 2+)` to add a
  `GRANT` line for every table later phases would add, it never was — it
  still only listed `users`/`sessions`/`auth_tokens`/`media_*`/`redirects`/
  `mail_*`/`audit_log`. A production deployment following it verbatim would
  have gotten a least-privilege account that couldn't read or write most of
  the schema. It now grants exactly what every table in `001_schema.sql`
  needs (full `SELECT, INSERT, UPDATE, DELETE` on every domain table,
  `SELECT, INSERT` only on the append-only `audit_log`, nothing at all on
  `schema_migrations`/`typeorm_metadata`).
