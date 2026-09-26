# Prompt — Finish the Safeer backend (fix everything in the FR review)

> Run Claude Code (cloud or local) on the `safeer_api` repo and paste everything below the line. All referenced files are committed in the repo under `docs/`.

---

You are finishing the **Safeer API** (NestJS 11 + TypeORM + MySQL/MariaDB, zod DTOs via `nestjs-zod`, cookie sessions, RFC 7807 errors, generic `CrudController<E>()` factory). The repo builds and lints cleanly. Two reviews found problems: an FR review (B-items: missing or wrong features against the spec) and a deep code review (C-items: security, correctness and operations). Your job is to fix **all** of them without breaking what already works.

## Inputs (read fully before touching code)

- `docs/safeer-backend-fr-review.md` — the FR review (B1–B15; B16–B19 are defined in this prompt).
- `docs/safeer-backend-code-review.md` — the deep code review (**C1–C47**). Each item has its location and the fix. Where a C-item and a B-item overlap, do both.
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
- **Tests come with the fix.** The Jest harness is built in Phase 0, and every later phase adds tests for the items it fixes: at least one regression test per High/Medium item.
- At the end of each phase, run `npm run build && npm run lint && npm test && npm run openapi:check`, report the results with a table of item → fix → test, and wait for my OK before moving to the next phase.
- If a C-item's suggested fix conflicts with the code as you find it, choose the safer design, explain why in the phase report, and keep going.

## Phase 0 — Hygiene, safety rails, test harness

1. Move `DEPLOYMENT-HOSTINGER.md` and `KNOWN-ISSUES.md` into `docs/backend/` with `git mv`, and fix any links to them. Keep `README.md` short and technical: setup, env table, scripts, and a pointer to `docs/`.
2. Keep `docs/prototype/safeer-prototype.html`, because `npm run seed` reads it. Make `tools/seed-from-prototype.mjs` accept an optional `PROTOTYPE_PATH` env var, defaulting to the current path, and fail with a clear message if the file is missing.
3. **Test harness (moved here from the old Phase 6):**
   - Add Jest + `ts-jest` (ESM-compatible with `"type": "module"`) + `supertest`, and an `npm test` script.
   - Use a real MySQL test database, created and migrated in `globalSetup`. Don't mock the ORM.
   - Add a CI step after `migrate`.
   - Include one smoke spec proving the harness boots the app.
4. **B16 (frontend prerequisite):** add `csrfToken` to `GET /portal/me`, computed exactly as `GET /admin/me` does. Cover it with a test.
5. **C8:** `db:reset` and `smoke` refuse to run unless `NODE_ENV ∈ {development, test}` and `--confirm=<dbname>` is given.
6. **C11:** load dev fixtures only when `NODE_ENV ∈ {development, test}`. `migrate.mjs` validates `NODE_ENV` against the `env.ts` enum.
7. **C9:** force UTC everywhere: TypeORM/mysql2 `timezone: 'Z'` plus `SET time_zone = '+00:00'` on every connection (app, `data-source.ts`, `migrate.mjs`). Add a test showing an OTP, reset token and session expire at the right time regardless of the process time zone (`TZ=Asia/Riyadh`).
8. **C29 (migration runner):**
   - Store a sha256 per file. Backfill the checksum for rows already applied, on the first run of the new runner. Fail when a checksum no longer matches.
   - `GET_LOCK('safeer_migrate')`.
   - Separate `MIGRATION_DB_USER` / `MIGRATION_DB_PASSWORD`, falling back to `DB_USER` in dev.
   - `create-app-db-user.sql` uses host `127.0.0.1`.
   - Document recovery for a half-failed DDL file.
9. **C47:** remove the unused packages, bind docker-compose MySQL to `127.0.0.1`, and fix the stale comment.

## Phase 1 — Student login, notifications, outbound mail/SMS (B1, B2, C1, C2, C16, C21, C22)

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


**C-items in this phase**
- **C1:** no OTP code in any mail subject. Store a masked body for `otp_code` in `mail_log` and `sms_log`. Tests read codes through a dev/test-only hook.
- **C2:**
  - Add `FRONTEND_BASE_URL` (validated in `env.ts`, added to `.env.example`).
  - Every emailed or SMS'd link targets locale-prefixed **frontend** routes: `/{locale}/admin/accept/{token}`, `/{locale}/admin/reset/{token}`, `/{locale}/portal/login`, `/{locale}/admin/messages/{id}`.
  - `PUBLIC_BASE_URL` stays for API-absolute URLs only. Rename it if it no longer has any user.
- **C16:** restrict applicant and contact name fields to letters (Arabic + Latin), spaces, `'` and `-`. Template variables are escaped so URLs are never auto-linked. Drop `{{name}}` from `contact_ack`.
- **C21:** SMS HTTP calls use `AbortSignal.timeout(5000)` and go out fire-and-forget after commit, like mail.
- **C22:** OTP rate limits per `application.id` as well as per identifier. A DB-backed daily failure counter locks after 10 failures. Issuing a new code invalidates older ones.

## Phase 2 — Applicant data integrity + files (B3, C5, C6, C15, C18, C19)

- **B3** in `portal-documents.service.ts`:
  - `upload()` is allowed only when the status is `draft`, or when it is `docs_missing` and the doc type is one that was rejected or requested. Otherwise return 409 `APPLICATION_LOCKED`.
  - Never supersede a document whose status is `accepted`.
  - If the DB transaction fails after the file was stored, delete the stored file (add `PrivateFileStore.remove`).
  - When every requested or rejected type in `docs_missing` has a fresh upload, record a `DOCS_RESUBMITTED` event visible to staff, and show it as a badge in the admin list. Don't auto-change the status.
- **C5:** neutralise CSV formula injection in `escapeCsvField`. Test it with `=`, `+`, `-`, `@`, tab and CR prefixes.
- **C6:** status changes (single, bulk, request-documents) run in a transaction with `pessimistic_write`. Notifications go out after commit. A concurrency test shows only one of two conflicting transitions wins.
- **C15:** `PATCH /portal/application` only while `draft`. Corrections in `docs_missing` go through a whitelisted endpoint that writes a visible event.
- **C18:** `@Throttle` on uploads (20/h) and a per-application quota (30 files / 50 MB). Delete superseded files after commit.
- **C19:** UTF-8 filename decoding. `Content-Disposition` with an ASCII fallback + `filename*=UTF-8''…`. Test with an Arabic filename on both download routes.

## Phase 3 — Staff auth + content security (B4, B5, C3, C4, C7, C10, C12, C24, C25)

- **B4** — add `@Roles('admin', 'editor')` to `RedirectsController`.
- **B5** — add class-level `@Roles('admin', 'editor')` to `admin/media` and keep DELETE admin-only.
- **Sweep:** write a small test that loads every controller under `admin/*` and fails if one has no `@Roles` metadata, except for an explicit allow-list (`admin/me`, `admin/auth/*`, `admin/overview`, `admin/preview-token`), so this can't happen again.

- **C3:**
  - Add a `users.status` column (`active | disabled | invited`), backfilled in a migration and separate from the brute-force lock.
  - Forgot, reset and accept-invite refuse `disabled` users.
  - Disable, email change and any token use delete the user's outstanding tokens.
  - An admin unlock resets `failedLogins`.
  - Update `GET/PATCH /admin/users` and the DTOs.
- **C4:** login uses atomic targeted `UPDATE`s, never `save(user)`. There's a test showing a login in flight can't undo a password reset.
- **C12:** time-boxed lockout (15 min with exponential backoff). A brute-force lock doesn't revoke sessions.
- **C7:**
  - Re-encode image originals on upload with `sharp().rotate()`, which strips EXIF/GPS, and use `autoOrient` for the variants.
  - Store the dimensions after rotation.
  - Add `scripts/reprocess-media.mjs` to backfill existing assets.
- **C10:** a shared `safeUrl` zod refinement on every stored URL (page buttons, partner url, social links). Redirect DTO: both paths `^/(?!/)`, `from ≠ to`, no chains.
- **C24:** the cache bypasses only on routes marked preview-aware, and only once the token verifies.
- **C25:** short `max-age` for originals and PDFs. The public-readable check joins `doc_categories.is_published`. Add `doc_categories` to the memo purge tags.

## Phase 4 — Medium B6–B9 + C13, C14, C17, C20, C23, C26, C27, C28

- **B6** — in `admin-overview.service.ts`, return `recentAuditLog` only to `admin`. Alternatively, filter it by `entity_type` to the areas each role owns, using the same matrix as `GET admin/roles`.
- **B7** — `applyAssignReviewer` (single and bulk) must require `role in ('admin','reviewer')` and `isLocked = false`. Otherwise return 422 `INVALID_ASSIGNEE`. Add `GET /admin/applications/assignees`, which lists the users who can be assigned.
- **B8** — match deletion to the spec matrix. Pass `deleteRoles: ['admin','editor']` for news, news categories, pages, page sections, work areas and their items, board, stats, about-items, partners, documents, doc categories and media. Pass `['admin','support']` for testimonials and testimonial themes. Users and settings stay admin-only.
- **B9** — in a new migration:
  - Set the placeholder testimonial to `status = 'pending', is_featured = 0`.
  - Rewrite every `primary_button_url` / `secondary_button_url` from `#/x` to the locale-agnostic path `/x`. The frontend adds `/{locale}`. Map: `#/apply → /apply`, `#/about → /about`, `#/work → /work-areas`, `#/scholarships → /scholarships`, `#/news → /news`, `#/partners → /partners`, `#/contact → /contact`. Check the prototype's route list and adjust any others to match.
  - Make the same fix in the seed generator.

- **C20** (together with B6): `includeApplications` only for admin and reviewer. The audit feed is admin-only, with no `diff`.
- **C13:** `publishRules` run on create. `publishedOn` defaults to today on publish. Audit `publish`/`unpublish`. The spec keeps images as labelled placeholders until real photos arrive, so the cover rule becomes a **warning** rather than a block: the save succeeds and returns `warnings: ['COVER_MISSING']`. The seeded post stays published.
- **C14:**
  - Slug hygiene: validate the format, max 180, reserved words (`featured`, …).
  - Check redirects when a slug is assigned. Delete self or duplicate redirects inside the rename transaction, and purge `redirects`.
  - Page `slug` is read-only on update.
- **C17:**
  - Add `interview` to `/portal/me`. The slot list is empty once booked, and only future slots are shown.
  - Duplicate booking → `SLOT_ALREADY_BOOKED`.
  - Add `DELETE /portal/interview` (cancel, which frees the slot, under a lock) and send confirmation/cancellation mail + SMS through new templates in both languages.
  - Slot DTO: `endsAt > startsAt`. Editing a booked slot notifies the applicant.
- **C23:**
  - Localised labels for status and doc type in every mail/SMS.
  - `user_invite` gets `{{role}}`.
  - Remove or fill `note`.
  - Arabic HTML mail wrapped in `dir="rtl" lang="ar"`.
- **C26:** page-section and about-item bodies are rendered with `MarkdownService` (sanitized HTML), including the B18 endpoint.
- **C27:**
  - Retention jobs: contact messages 24 months, `sms_log` 90 days, idle drafts 180 days together with their files, unsubscribed newsletter rows.
  - Signed-token `POST /newsletter/unsubscribe` + double opt-in (`newsletter_confirm` template).
  - `DELETE /admin/applications/:id`: admin only, anonymises data and deletes files, audited.
- **C28:**
  - Encrypt `applications.id_number` with AES-GCM under `APP_ENCRYPTION_KEY`, with a migration that encrypts existing rows.
  - Staff responses decrypt it. The CSV export masks it (last 4 digits only).
  - Fix the documented backup recipe (`--single-transaction --quick`, `~/.my.cnf`, 03:30, encrypted offsite copy, tested restore).

## Phase 5 — Low B10–B15, B17–B19, C30–C46

- **B10** — `GET /admin/pages` returns `sectionsCount` and `updatedAt`. Add a hook in the CRUD factory (e.g. `listQuery?: (qb) => qb`) rather than hand-writing the controller.
- **B11** — add `is_published` to `work_area_items`, add a `publishable: true` route on its admin controller, and filter unpublished items out of the public `/work-areas`.
- **B12** — add `bio_ar` / `bio_en` (text, nullable) to `board_members`: DTOs, the public mapper, and the Arabic fallback. It comes for free through the `LocaleInterceptor` if the columns are named `bioAr`/`bioEn`.
- **B13** — use `escapeLikeValue()` in the news search, plus any other `LIKE` built from user input. Grep for them all.
- **B14** — in `portal-application.service.ts`, load the application with `pessimistic_write` inside a transaction in `submit()`, and in `patch()` as well.
- **B15** — add public `GET /sitemap-index`, returning `{ pages: [{slug, updatedAt}], posts: [{slug, updatedAt}], categories: [...] }` for published content only, cached with tags that are purged when any of those collections change. The frontend builds `sitemap.xml` and `hreflang` from it.
- **Settings/social** — add `youtube_url`, `linkedin_url`, `whatsapp_url`, `tiktok_url` (nullable) to `site_settings`, and expose them in `GET /site`.

- **B17 — `GET /admin/roles` does not exist.** The README documents it, but no controller implements it. Add it for any staff session. It returns `{ roles: ['admin','reviewer','editor','support'], matrix: { [area]: Role[] } }`, built from the same constants the `@Roles()` decorators use, so the two can't drift. Add a unit test that compares the matrix with the decorators on every `admin/*` controller.
- **B18 — no public source for about-items outside the home page.** `vision`, `mission`, `scholarship_step` and `requirement` are seeded, but only `goal` and `care_pillar` are exposed (inside `GET /home`). The `about` and `scholarships` pages also have no seeded sections.
  - Add public `GET /about-items?kind=vision,mission,goal,care_pillar,scholarship_step,requirement`, returning published rows grouped by kind and sorted by `sortOrder`. Cache it with the `about-items` tag.
  - In a new migration, seed page sections for `about` (vision, mission, goals, governance) and `scholarships` (pillars, steps, requirements, cta) from the prototype. No invented content.
- **B19 — `GET /portal/documents` returns raw `ApplicationDocument` entities**, including `storageKey` and `checksum`. Map them to a public shape: `id, docType, originalName, mime, sizeBytes, status, rejectionReason, createdAt`. The same applies to any admin response that returns the entity; admins don't need `storageKey` either.

- **C30–C46:** fix every Low item in `docs/safeer-backend-code-review.md`. C43's indexes go in a migration. C44's CI changes land together with Phase 7.

## Phase 6 — Storage abstraction (decision 3)

- Add a `StorageDriver` interface: `put`, `getStream`, `remove`, `signedUrl?`. Build a `LocalStorageDriver` from the current code and an `S3StorageDriver` using `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, configurable for any S3-compatible endpoint.
- Env: `STORAGE_DRIVER=local|s3`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_PUBLIC`, `S3_BUCKET_PRIVATE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SIGNED_URL_TTL_SECONDS` (default 300). Validate them in `config/env.ts`, with the S3 vars required only when the driver is `s3`.
- `MediaService` and `PrivateFileStore` go through the driver. For private documents in S3 mode, the existing guarded routes (`/portal/documents/:id/file`, `/admin/applications/:id/documents/:docId/file`) still run their auth and ownership checks and then return **302 to a signed URL**. Never make the private bucket public.
- Add `scripts/backup-storage.mjs`. In local mode it writes a dated tar.gz of `STORAGE_ROOT`; in S3 mode it prints a no-op message. Document the cron line in `docs/backend/DEPLOYMENT-HOSTINGER.md`.

- The storage abstraction must keep C7 (re-encoded originals) and C18 (superseded-file cleanup) working in both drivers.

## Phase 7 — Test completion + CI hardening (C44)

Earlier phases added tests per item. This phase fills the gaps to this minimum:
- Minimum coverage, one spec file per area:
  1. **Permissions matrix**: for every role × every admin route group, assert 200/403, generated from the same matrix `GET admin/roles` returns. Also the unauthenticated 401, and staff cookie ≠ applicant cookie in both directions.
  2. **Apply flow**: create (ref format `SA-YYYY-NNNNN`, sequencing), autosave, submit rules (missing docs → 409, consent must be true), duplicate active application → 409 (B2).
  3. **OTP**: request by reference/email/phone, the 10-minute expiry, the 5-attempt cap, the non-enumerating responses, email fallback when SMS is `log` (B1).
  4. **Documents**: upload status rules and no superseding an accepted doc (B3), ownership 404, MIME and size rejection.
  5. **Admin review**: transition map (valid and invalid), reject without reason → 400, assignee validation (B7), bulk actions with partial failures, CSV export headers and encoding, notes never exposed on `/portal/*`.
  6. **Content**: locale fallback (`?lang=en` with an empty `*_en` returns the Arabic value), the publish filter on public routes, B8 delete roles, B11 item visibility, B15 sitemap index.
- Keep `scripts/smoke.mjs` working, and update it wherever these fixes change behaviour.

- **C44:** CI runs `schema:check`, migrates twice (the second run must do nothing), migrates with `NODE_ENV=production` (only `001` + `002` + new files; no dev fixtures), sets a `permissions:` block, and pins action versions.

## Definition of done

- Every item **B1–B19** and **C1–C47**, and every ⚠️/❌ row in the FR matrix, is resolved. Final table: item → fix → commit hash → test that covers it.
- `npm run build`, `npm run lint`, `npm test`, `npm run openapi:check` all pass, and CI is green.
- `npm run migrate` works on a fresh DB, on a DB already at `003`, and a second run is a no-op.
- Project docs stay in `docs/`, and the repo root holds only `README.md` plus config files.
- `docs/backend/DEPLOYMENT-HOSTINGER.md` covers:
  - the new env vars (`FRONTEND_BASE_URL`, `MIGRATION_DB_*`, S3)
  - SMS provider setup and S3 mode
  - the storage and DB backup crons
  - the retention policy
  - the UTC requirement

Start with Phase 0 plus the SMS-provider question from decision 4, then stop and report.

In a cloud session: commit and push each phase to a branch named `fix/phase-N` and open a PR against `main`. Don't merge it yourself.
