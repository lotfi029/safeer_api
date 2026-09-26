# Prompt — Finish the Safeer backend (fix everything in the FR review)

> Run Claude Code (cloud or local) on the `safeer_api` repo and paste everything below the line. All referenced files are committed in the repo under `docs/`.

---

You are finishing the **Safeer API** (NestJS 11 + TypeORM + MySQL/MariaDB, zod DTOs via `nestjs-zod`, cookie sessions, RFC 7807 errors, generic `CrudController<E>()` factory). The repo builds and lints cleanly. An FR review found one blocker, several bugs and some gaps against the spec. Your job is to fix **all** of them without breaking what already works.

## Inputs (read fully before touching code)

- `docs/safeer-backend-fr-review.md` — the review. Every item ID below (B1…B15, D-items; B16–B19 are defined in this prompt) refers to it.
- `docs/safeer-design-spec.md` and `docs/safeer-implementation-prompt.md` — the source requirements.
- `README.md` and `KNOWN-ISSUES.md` in the repo, which describe the architecture conventions. Follow them: the zod DTO style, `ProblemException` + `ErrorCode`, the audit interceptor, cache tags / `extraPurgeTags`, numbered SQL migrations with entities kept in sync, and `z.iso.datetime()` instead of `z.date()`.

## Decisions already made (do not reopen)

1. **Keep MySQL/MariaDB + TypeORM** (Hostinger provisions MariaDB). Do not migrate to PostgreSQL/Prisma.
2. **Keep DB-backed cookie sessions + CSRF** instead of JWT.
3. **Storage:** add a storage-driver abstraction with `local` (the current behaviour, the default) and `s3` (S3-compatible, private bucket, short-lived signed GET URLs). Staff and applicant file routes keep their auth checks in both modes.
4. **SMS provider:** before starting B1, ask me which Saudi provider the association uses (Unifonic / Taqnyat / Msegat). If I don't answer, implement **Unifonic**. Keep the existing `log` and generic `http` drivers.
5. **Project docs live in the repo under `docs/`** so cloud sessions can read them. Keep them there, and don't delete or gitignore `docs/`. Operational notes (`DEPLOYMENT-HOSTINGER.md`, `KNOWN-ISSUES.md`) move into `docs/` too, so the repo root stays clean.

## Rules

- Schema changes go in **new** numbered migrations (`migrations/004_*.sql`, …). Never edit `001`/`002`/`dev/003`, because they may already be applied somewhere. Update the matching entity in `src/database/entities/` in the same step.
- Seed-data fixes also go in a new migration (`UPDATE` statements), not edits to `002_seed.sql`. Also update `tools/seed-from-prototype.mjs` so a regeneration produces the corrected data.
- After any route or DTO change, run `npm run openapi` and commit the updated `openapi.json`. `npm run openapi:check` must pass.
- No invented content: no made-up numbers, names, partners or testimonials. Placeholders stay `[...]`.
- Commit after each phase with a clear message. **Do not force-push or rewrite git history** without asking me.
- At the end of each phase, run `npm run build && npm run lint && npm test`, report the results, and wait for my OK before moving to the next phase.

## Phase 0 — Repo hygiene + portal CSRF prerequisite

1. Move `DEPLOYMENT-HOSTINGER.md` and `KNOWN-ISSUES.md` into `docs/backend/` with `git mv`, and fix any links to them.
2. Keep `docs/prototype/safeer-prototype.html`, because `npm run seed` reads it. Make `tools/seed-from-prototype.mjs` accept an optional `PROTOTYPE_PATH` env var, defaulting to the current path, and fail with a clear message if the file is missing.
3. Keep `README.md` short and technical: setup, env table, scripts, and a pointer to `docs/`.
4. **B16 (frontend prerequisite):** add `csrfToken` to the `GET /portal/me` response. Compute it exactly as `GET /admin/me` does in `src/auth/auth.controller.ts` (`computeCsrfToken(APP_ENCRYPTION_KEY, req.sessionTokenHash)`), and cover it in `scripts/smoke.mjs`. Without it, the student portal loses the ability to write after a page reload.

## Phase 1 — Blocker B1 + High B2 (student OTP login)

**B1 — OTP delivery**
- Add an SMS provider adapter for the chosen vendor behind `SmsServiceInterface`. Configure it through the existing admin `sms/settings` (encrypted token, sender name) and add `driver: 'unifonic' | …` to the settings enum. `POST /admin/sms/test` must work with it.
- `POST /portal/auth/request-otp` takes an optional `channel: 'sms' | 'email'`:
  - With `sms`: if the SMS driver is `log` in production, or the send throws, fall back to email automatically.
  - With no channel: prefer SMS when a real driver is configured, otherwise email.
  - The response stays the non-enumerating `{ ok: true }`. It may add `channelHint: 'sms' | 'email'` only in a way that is the same whether or not the identifier exists (e.g. echo the requested or default channel, never the resolved one).
- Store the channel actually used on the `applicant_otps` row, as the code already does.

**B2 — identifier resolution**
- Accept a **reference, email, or phone** as the identifier. Normalise phones to E.164, with `+966` as the default country code for local `05…` numbers. Store a normalised `phone_e164` column, backfilled in the migration, with an index.
- Enforce **one active application per applicant**: `POST /applications` must reject (409 `APPLICATION_EXISTS`, non-enumerating wording) when a non-terminal application (`draft/new/under_review/docs_missing/interview`) already exists for the same email or phone. In that case send that applicant a "continue your application" mail/SMS containing the portal link, reusing the existing template mechanism with a new `application_resume` template in both languages.
- `findApplication()` must never pick an arbitrary row. For email/phone, resolve the most recent **non-terminal** application; if there is none, the most recent one.

## Phase 2 — High B3, B4, B5 (integrity + permissions)

- **B3** in `portal-documents.service.ts`:
  - `upload()` is allowed only when the status is `draft`, or when it is `docs_missing` and the doc type is one that was rejected or requested. Otherwise return 409 `APPLICATION_LOCKED`.
  - Never supersede a document whose status is `accepted`.
  - If the DB transaction fails after the file was stored, delete the stored file (add `PrivateFileStore.remove`).
  - When every requested or rejected type in `docs_missing` has a fresh upload, record a `DOCS_RESUBMITTED` event visible to staff, and show it as a badge in the admin list. Don't auto-change the status.
- **B4** — add `@Roles('admin', 'editor')` to `RedirectsController`.
- **B5** — add class-level `@Roles('admin', 'editor')` to `admin/media` and keep DELETE admin-only.
- **Sweep:** write a small test that loads every controller under `admin/*` and fails if one has no `@Roles` metadata, except for an explicit allow-list (`admin/me`, `admin/auth/*`, `admin/overview`, `admin/preview-token`), so this can't happen again.

## Phase 3 — Medium B6–B9

- **B6** — in `admin-overview.service.ts`, return `recentAuditLog` only to `admin`. Alternatively, filter it by `entity_type` to the areas each role owns, using the same matrix as `GET admin/roles`.
- **B7** — `applyAssignReviewer` (single and bulk) must require `role in ('admin','reviewer')` and `isLocked = false`. Otherwise return 422 `INVALID_ASSIGNEE`. Add `GET /admin/applications/assignees`, which lists the users who can be assigned.
- **B8** — match deletion to the spec matrix. Pass `deleteRoles: ['admin','editor']` for news, news categories, pages, page sections, work areas and their items, board, stats, about-items, partners, documents, doc categories and media. Pass `['admin','support']` for testimonials and testimonial themes. Users and settings stay admin-only.
- **B9** — in a new migration:
  - Set the placeholder testimonial to `status = 'pending', is_featured = 0`.
  - Rewrite every `primary_button_url` / `secondary_button_url` from `#/x` to the locale-agnostic path `/x`. The frontend adds `/{locale}`. Map: `#/apply → /apply`, `#/about → /about`, `#/work → /work-areas`, `#/scholarships → /scholarships`, `#/news → /news`, `#/partners → /partners`, `#/contact → /contact`. Check the prototype's route list and adjust any others to match.
  - Make the same fix in the seed generator.

## Phase 4 — Low B10–B15 and remaining gaps

- **B10** — `GET /admin/pages` returns `sectionsCount` and `updatedAt`. Add a hook in the CRUD factory (e.g. `listQuery?: (qb) => qb`) rather than hand-writing the controller.
- **B11** — add `is_published` to `work_area_items`, add a `publishable: true` route on its admin controller, and filter unpublished items out of the public `/work-areas`.
- **B12** — add `bio_ar` / `bio_en` (text, nullable) to `board_members`: DTOs, the public mapper, and the Arabic fallback. It comes for free through the `LocaleInterceptor` if the columns are named `bioAr`/`bioEn`.
- **B13** — use `escapeLikeValue()` in the news search, plus any other `LIKE` built from user input. Grep for them all.
- **B14** — in `portal-application.service.ts`, load the application with `pessimistic_write` inside a transaction in `submit()`, and in `patch()` as well.
- **B15** — add public `GET /sitemap-index`, returning `{ pages: [{slug, updatedAt}], posts: [{slug, updatedAt}], categories: [...] }` for published content only, cached with tags that are purged when any of those collections change. The frontend builds `sitemap.xml` and `hreflang` from it.
- **Settings/social** — add `youtube_url`, `linkedin_url`, `whatsapp_url`, `tiktok_url` (nullable) to `site_settings`, and expose them in `GET /site`.

## Phase 4b — Gaps found during frontend planning (B17–B19)

- **B17 — `GET /admin/roles` does not exist.** The README documents it, but no controller implements it. Add it for any staff session. It returns `{ roles: ['admin','reviewer','editor','support'], matrix: { [area]: Role[] } }`, built from the same constants the `@Roles()` decorators use, so the two can't drift. Add a unit test that compares the matrix with the decorators on every `admin/*` controller.
- **B18 — no public source for about-items outside the home page.** `vision`, `mission`, `scholarship_step` and `requirement` are seeded, but only `goal` and `care_pillar` are exposed (inside `GET /home`). The `about` and `scholarships` pages also have no seeded sections.
  - Add public `GET /about-items?kind=vision,mission,goal,care_pillar,scholarship_step,requirement`, returning published rows grouped by kind and sorted by `sortOrder`. Cache it with the `about-items` tag.
  - In a new migration, seed page sections for `about` (vision, mission, goals, governance) and `scholarships` (pillars, steps, requirements, cta) from the prototype. No invented content.
- **B19 — `GET /portal/documents` returns raw `ApplicationDocument` entities**, including `storageKey` and `checksum`. Map them to a public shape: `id, docType, originalName, mime, sizeBytes, status, rejectionReason, createdAt`. The same applies to any admin response that returns the entity; admins don't need `storageKey` either.

## Phase 5 — Storage abstraction (decision 3)

- Add a `StorageDriver` interface: `put`, `getStream`, `remove`, `signedUrl?`. Build a `LocalStorageDriver` from the current code and an `S3StorageDriver` using `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, configurable for any S3-compatible endpoint.
- Env: `STORAGE_DRIVER=local|s3`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_PUBLIC`, `S3_BUCKET_PRIVATE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SIGNED_URL_TTL_SECONDS` (default 300). Validate them in `config/env.ts`, with the S3 vars required only when the driver is `s3`.
- `MediaService` and `PrivateFileStore` go through the driver. For private documents in S3 mode, the existing guarded routes (`/portal/documents/:id/file`, `/admin/applications/:id/documents/:docId/file`) still run their auth and ownership checks and then return **302 to a signed URL**. Never make the private bucket public.
- Add `scripts/backup-storage.mjs`. In local mode it writes a dated tar.gz of `STORAGE_ROOT`; in S3 mode it prints a no-op message. Document the cron line in `docs/backend/DEPLOYMENT-HOSTINGER.md`.

## Phase 6 — Automated tests (acceptance criterion)

- Add Jest + `ts-jest` (ESM-compatible with this repo's `"type": "module"`) + `supertest`, and an `npm test` script. Add a test step to `.github/workflows/ci.yml` after `migrate`.
- Use a real MySQL test database, created and migrated in `globalSetup`. Don't mock the ORM.
- Minimum coverage, one spec file per area:
  1. **Permissions matrix**: for every role × every admin route group, assert 200/403, generated from the same matrix `GET admin/roles` returns. Also the unauthenticated 401, and staff cookie ≠ applicant cookie in both directions.
  2. **Apply flow**: create (ref format `SA-YYYY-NNNNN`, sequencing), autosave, submit rules (missing docs → 409, consent must be true), duplicate active application → 409 (B2).
  3. **OTP**: request by reference/email/phone, the 10-minute expiry, the 5-attempt cap, the non-enumerating responses, email fallback when SMS is `log` (B1).
  4. **Documents**: upload status rules and no superseding an accepted doc (B3), ownership 404, MIME and size rejection.
  5. **Admin review**: transition map (valid and invalid), reject without reason → 400, assignee validation (B7), bulk actions with partial failures, CSV export headers and encoding, notes never exposed on `/portal/*`.
  6. **Content**: locale fallback (`?lang=en` with an empty `*_en` returns the Arabic value), the publish filter on public routes, B8 delete roles, B11 item visibility, B15 sitemap index.
- Keep `scripts/smoke.mjs` working, and update it wherever these fixes change behaviour.

## Definition of done

- Every item B1–B19 and every ⚠️/❌ row in the review's FR matrix is resolved. Give me a final table: item → fix → commit hash → test that covers it.
- `npm run build`, `npm run lint`, `npm test`, `npm run openapi:check` all pass, and CI is green.
- `npm run migrate` works on a fresh DB, and on a DB already at `003`.
- Project docs stay in `docs/`, and the repo root holds only `README.md` plus config files.
- `docs/backend/DEPLOYMENT-HOSTINGER.md` covers the new env vars, SMS provider setup, S3 mode and the storage backup cron.

Start with Phase 0 plus the SMS-provider question from decision 4, then stop and report.

In a cloud session: commit and push each phase to a branch named `fix/phase-N` and open a PR against `main`. Don't merge it yourself.
