# Known issues and out-of-scope items

## Out of scope (per the project plan)

- **No frontend.** This repository is the REST API only. The prototype at
  `docs/prototype/safeer-prototype.html` describes the intended UI; nothing
  here renders it.
- **The Unifonic SMS driver hasn't been exercised against the live
  provider** from this repository — only against its documented API shape.
  Run `POST admin/sms/test` after configuring it (`DEPLOYMENT-HOSTINGER.md`,
  "SMS provider").
- **Backups are cron-scheduled scripts, not a managed service.**
  `DEPLOYMENT-HOSTINGER.md` describes a `mysqldump` cron and
  `npm run backup:storage` for `STORAGE_ROOT`. There is no restore tooling
  and no point-in-time recovery. In S3 mode the buckets' durability is the
  provider's job.
- **`npm run seed` rewrites `002_seed.sql` / `dev/003_dev_sample.sql`,**
  which `npm run migrate` now treats as immutable once applied (a sha256 per
  file). A regenerated 002/003 that differs from what a database already ran
  fails that database's next migrate. Seed changes for existing databases
  go in a new numbered migration; see `DEPLOYMENT-HOSTINGER.md`,
  "Migrations".
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
  one place that needed a real datetime value in this codebase
  (`src/admin-applications/dto/interview-slot.dto.ts`, `startsAt`/`endsAt`)
  uses `z.iso.datetime({ offset: true })` instead — a validated ISO 8601
  string. TypeORM's mysql driver already parses a string the same as a
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
- **`docker-compose.yml`'s MySQL 8 image (bound to `127.0.0.1:3308`) is a
  development convenience, not what production runs on.** `DEPLOYMENT-HOSTINGER.md` targets MariaDB
  (Hostinger's Node.js hosting plans provision MariaDB, not MySQL). Both
  speak the same wire protocol and both are configured with
  `utf8mb4_unicode_ci` throughout this codebase specifically so the schema
  and every query work unchanged on either — but this hasn't been verified
  against every MariaDB version's SQL-mode defaults, only against the
  MariaDB instance this phase's own verification ran against.
- **The CI workflow's dev-fixture comments predate Safeer's actual seed
  shape.** `.github/workflows/ci.yml` was ported from `african_api`
  (whose dev sample seeds a couple of editor accounts) in phase 1 and, until
  this pass, still described `ALLOW_DEV_PASSWORD_FIXUP`/`NODE_ENV=development`
  as being there for "the seeded editor" to sign in with for role-gate smoke
  cases. Safeer's own `002_seed.sql`/`migrations/dev/003_dev_sample.sql`
  seed **zero** users on purpose (`BootstrapService`'s own header comment
  says so directly) — the only account either one ever produces is the
  bootstrap admin. `scripts/smoke.mjs`'s permission-matrix case creates its
  own temporary editor/reviewer/support accounts by a direct row insert
  (hashing a known password with the same Argon2id `PasswordService` uses,
  since the invite-and-accept-token email flow has no way to hand a raw
  token back to an unattended script when mail is disabled by default). This
  pass corrected the stale comments; `NODE_ENV=development` is still needed,
  for a different, real reason — the legacy-news bulk-delete smoke case
  needs `dev/003_dev_sample.sql`'s 3 "legacy template" posts to have
  anything to act on.

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
