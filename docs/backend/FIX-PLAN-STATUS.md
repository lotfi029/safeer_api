# Fix plan status: item → fix → commit → test

Status of every item in `docs/safeer-backend-fix-prompt.md`: B1–B19 from
`docs/safeer-backend-fr-review.md` (plus B16–B19 defined in the prompt),
and C1–C47 from `docs/safeer-backend-code-review.md`. Contract changes for
the frontend are in [`API-CHANGES.md`](API-CHANGES.md).

## Commits

| Phase | Commit | Scope |
|---|---|---|
| PR #2 (before this plan) | `a52b99d` | B4, B5, B7–B15, social links; B1/B2/B3 partly |
| 0 | `b6096dc` | docs back in the repo, C8, C9, C11, C29, C47, B16 |
| 1 | `3a47118` | B1, B2, C1, C2, C16, C21, C22 (+ C43 lookup) |
| 2 | `f8aae77` | B3, B19, C5, C6, C15, C18, C19, C34 |
| 3 | `23a98ab` | C3, C4, C7, C10, C12, C24, C25 (+ C37, C38, part of C33), B4/B5 sweep |
| 4 | `eea8ff3` | C13, C14, C17, C20, C23, C26, C27, C28 (+ C43 indexes, C46) |
| 5 | `038fd35` | B10, B17, B18, C30–C33, C35, C36, C39–C42, C45 |
| 6 | `850d3f3` | storage abstraction: verified, hardened, tested |
| 7 | `0cf6f69`, `4b56c80` | C44, generated permission matrix, coverage gaps |

Test files are under `test/` (e2e against the real app and MySQL/MariaDB)
and `test/unit/` (pure helpers). `smoke` is `scripts/smoke.mjs`.

## B items

| Item | Fix | Commit | Test |
|---|---|---|---|
| B1 | OTP by SMS to the E.164 number; OTP row saved before sending; email fallback when SMS is off or fails | `a52b99d`, `3a47118` | `otp.spec` (B1 email fallback), `otp-hardening.spec` (E.164) |
| B2 | Lookup by reference, email or phone (`05…` → `+966`); a second active application for the same email is 409 | `a52b99d`, `3a47118` | `otp.spec` (local 05… phone), `apply-flow.spec` (B2), unit `phone.spec` |
| B3 | Upload status rules and "never supersede an accepted document", re-checked under a row lock | `f8aae77` | `documents.spec`, `integrity.spec` (B3) |
| B4 | Redirects role-gated | `a52b99d` | `content-security.spec` (sweep), `permissions.spec` |
| B5 | Media role-gated | `a52b99d` | `content-security.spec` (sweep), `permissions.spec` |
| B6 | Overview audit feed not exposed to every role | `eea8ff3` (C20) | `privacy.spec` (C20) |
| B7 | Assignee must be an active, unlocked admin/reviewer | `a52b99d`, `23a98ab` | `admin-review.spec` (B7), `staff-auth.spec` |
| B8 | Per-collection delete roles | `a52b99d`, `038fd35` (`deleteArea`) | `content.spec` (B8), `permissions.spec` (delete probes) |
| B9 | Placeholder testimonial pending; locale-agnostic section buttons | `a52b99d` | smoke (B9) |
| B10 | `GET admin/pages` returns `sectionsCount` via the factory's `listEnrich` hook | `038fd35` | `low-items.spec` (B10), smoke |
| B11 | Work-area items have `is_published`, filtered on `/work-areas` | `a52b99d` | `content.spec` (B11) |
| B12 | Board member `bio_ar/en` | `a52b99d` | smoke (board bio) |
| B13 | `LIKE` input escaped in the news search | `a52b99d` | `coverage-gaps.spec` (B13), smoke |
| B14 | Submit and patch lock the application row | `a52b99d`, `f8aae77` | `coverage-gaps.spec` (B14), `integrity.spec` |
| B15 | Public `GET /sitemap-index` | `a52b99d` | `content.spec` (B15) |
| B16 | `GET portal/me` returns `csrfToken` | `b6096dc` | `portal-me-csrf.spec` |
| B17 | `src/auth/role-matrix.ts` + `@Area()` + `GET admin/roles`; checker fails on drift | `038fd35` | `permissions.spec` (generated), `low-items.spec` (B17), `content-security.spec` (sweep) |
| B18 | Public `GET about-items?kind=`; about/scholarships sections seeded from the prototype (014) | `038fd35` | `low-items.spec` (B18), smoke |
| B19 | Document responses mapped (no `storageKey`/`checksum`) | `f8aae77` | `integrity.spec` (B19) |
| Social links | YouTube, LinkedIn, WhatsApp, TikTok URLs on `site_settings` and `GET /site` | `a52b99d` | `coverage-gaps.spec` |

FR matrix ⚠️/❌ rows: P3b → B12, P14b → B15, S1 → B1/B2, D5 → B10,
D8 → B11, R1 → B6/C20, "no test suite" → the Jest suite, "docs not pushed"
→ Phase 0.

## C items

| Item | Fix | Commit | Test |
|---|---|---|---|
| C1 | No OTP code in `mail_log`/`sms_log`/subjects; dev-only peek hook | `3a47118` | `otp-hardening.spec` (C1) |
| C2 | `FRONTEND_BASE_URL`; every mailed link a locale-prefixed frontend route | `3a47118` | `mail-links.spec`, unit `frontend-url.spec` |
| C3 | `users.status` (active/disabled/invited); tokens and sessions revoked on disable | `23a98ab` | `staff-auth.spec` (C3) |
| C4 | Login writes only targeted `UPDATE`s | `23a98ab` | `staff-auth.spec` (C4, login racing a reset) |
| C5 | CSV formula injection neutralised | `f8aae77` | unit `csv.spec`, `integrity.spec` (C5) |
| C6 | Status changes, bulk, request-documents, review: one transaction, row lock, notify after commit | `f8aae77` | `integrity.spec` (C6 race) |
| C7 | Image originals re-encoded (EXIF/GPS stripped, orientation applied); backfill script | `23a98ab` | `content-security.spec` (C7) |
| C8 | `db:reset`/`smoke` need dev/test and `--confirm=<DB_NAME>` | `b6096dc` | `script-guards.spec` |
| C9 | UTC on every connection; boot fails otherwise | `b6096dc` | `utc.spec` |
| C10 | `safeUrl` on URL fields; redirect paths and chains checked | `23a98ab` | `content-security.spec` (C10), unit `safe-url.spec`, `coverage-gaps.spec` |
| C11 | `migrations/dev/` only in development/test; NODE_ENV validated | `b6096dc` | `node-env.spec`, `migrate.spec`, `schema.spec` |
| C12 | Lockout with exponential backoff; admin unlock | `23a98ab` | `staff-auth.spec` (C12) |
| C13 | Publish rules on create; `publishedOn` default; `COVER_MISSING` warning; publish audited | `eea8ff3` | `content-publishing.spec` (C13) |
| C14 | Slug format and reserved words; no self/stale redirects; page slug read-only | `eea8ff3` | `content-publishing.spec` (C14) |
| C15 | Edit only while draft; `PATCH portal/application/corrections` while docs_missing | `f8aae77` | `integrity.spec` (C15) |
| C16 | Name validation; mail values never autolink; no name in `contact_ack` | `3a47118` | unit `person-name.spec`, `render-template.spec`, `mail-links.spec` |
| C17 | Future-only slots, cancel, `/portal/me` interview, notices, slot validation | `eea8ff3` | `interviews.spec` |
| C18 | Upload throttle and per-application quota; superseded files removed | `f8aae77` | `integrity.spec` (C18) |
| C19 | UTF-8 filenames (RFC 5987) on every download; S3 presign carries them | `f8aae77` | unit `filenames.spec`, `integrity.spec` (C19), unit `storage-drivers.spec` |
| C20 | Overview figures by role; audit feed admin-only without diff/IP | `eea8ff3` | `privacy.spec` (C20) |
| C21 | SMS 5 s timeout; background delivery (awaited only for OTP) | `3a47118` | `otp-hardening.spec` (timeout) |
| C22 | Per-application OTP budget; daily failure lock; old codes invalidated | `3a47118` | `otp-hardening.spec` (C22) |
| C23 | Human labels in mail/SMS; `dir`/`lang` wrapper; `{{note}}` removed | `eea8ff3` | `privacy.spec` (C23) |
| C24 | `?preview` ignored off preview routes; verified previews never cached | `23a98ab` | `content-security.spec` (C24) |
| C25 | Short cache for originals/PDFs; documents public only with a published category | `23a98ab` | `content-security.spec` (C25) |
| C26 | Page-section and about-item bodies rendered as sanitized HTML | `eea8ff3` | `content-publishing.spec` (C26), `low-items.spec` (B18) |
| C27 | Newsletter double opt-in + signed unsubscribe; nightly retention; admin anonymise | `eea8ff3` | `privacy.spec` (C27), unit `newsletter-token.spec`, smoke |
| C28 | ID number encrypted at rest (011–013, `.mjs` migrations); masked in CSV; backup recipe | `eea8ff3` | `privacy.spec` (C28), `migrate.spec` (.mjs), `schema.spec` (upgrade from 003) |
| C29 | Migration checksums, lock, `MIGRATION_DB_USER` | `b6096dc` | `migrate.spec`, `schema.spec` |
| C30 | Readiness uses an access check (driver `healthCheck()`, HeadBucket on S3) | `038fd35`, `850d3f3` | `low-items.spec` (C30), `storage.spec`, unit `storage-drivers.spec` |
| C31 | Per-tag purge version; stale `set` skipped | `038fd35` | unit `cache.spec` |
| C32 | Session cookies `Secure` outside development/test | `038fd35` | unit `cookie-options.spec` |
| C33 | Idle sessions hidden; changePassword throttled; failed-login label; async forgot; token + password in one transaction; fixup allow-list | `23a98ab`, `038fd35` | `low-items.spec` (C33), `staff-auth.spec`, unit `bootstrap-fixup.spec` |
| C34 | Reviewing a superseded document or a closed application is 409 | `f8aae77` | `integrity.spec` (C34) |
| C35 | Portal notifications mapped | `038fd35` | `low-items.spec` (C35) |
| C36 | CSV `X-Truncated` + export audited (015) | `038fd35` | `low-items.spec` (C36) |
| C37 | Alt-text edit purges every tag that can show the asset | `23a98ab` | `coverage-gaps.spec` (C37) |
| C38 | Media upload cleanup, 422 on decode errors, duplicate race returns the existing asset | `23a98ab` | `coverage-gaps.spec` (C38) |
| C39 | `readMinutesAr/En`; whitespace-only English falls back; `*En` trimmed | `038fd35` | `low-items.spec` (C39) |
| C40 | Markdown `#` → h2, GFM tables allowed | `038fd35` | `low-items.spec` (C40) |
| C41 | Post preview token unlocks that post's cover on `/files` | `038fd35` | `low-items.spec` (C41) |
| C42 | Unknown public filter values are 400 | `038fd35` | `low-items.spec` (C42, B18), smoke |
| C43 | Portal lookup uses plain `=`; `created_at` indexes (010) | `3a47118`, `eea8ff3` | `otp.spec`/`otp-hardening.spec`, `schema:check` (declared indexes) |
| C44 | CI: `schema:check`, migrate twice, production migrate, `permissions:`, pinned actions | `0cf6f69` | `schema.spec`, `.github/workflows/ci.yml` |
| C45 | `migrate` writes placeholder files for dev fixtures (dev/test, local storage) | `038fd35` | `low-items.spec` (C45) |
| C46 | Reply delivery status kept before the mail_log purge | `eea8ff3` | `coverage-gaps.spec` (C46) |
| C47 | Unused packages removed; compose ports bound to 127.0.0.1; stale comment fixed | `b6096dc` | — (package.json / docker-compose.yml) |

## Decisions taken where the review left a choice

- **C14:** redirects are cleared into the new live path, rather than the rename being refused.
- **C27 anonymise:** the reference and status stay, for the statistics.
- **C28:** the plaintext column is dropped in its own migration (013) after 012 encrypts.
- **C33 dev fixup:** an explicit, currently empty, allow-list. The dev fixtures seed no staff users, so the old heuristic could only ever hit real invitees.
- **C44 `schema:check`:** a purpose-built checker, because `typeorm schema:log` is ~280 lines of no-ops on MariaDB.
- **Newsletter delete:** stays with admin + support (the `inbox` area), as before. The generated permission matrix showed an earlier doc claiming admin-only.
- **B18 cache tag:** `about_items` (the tag every about-items write already purges), not a new `about-items` tag.
