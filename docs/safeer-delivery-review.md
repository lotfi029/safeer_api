# Safeer — Delivery Review (backend + frontend)

**Date:** 2026-09-27
**Commits reviewed:** `safeer_api` @ `37c593d` and `safeer_web` @ `4d1f4b4`, both `main`.

**How it was checked:**
- I ran every check each repo defines, on a local MariaDB 10.11 and Node 24.21.
- I then ran the frontend's production SSR build and its e2e suite **against the real API**, not the mocks.
- Two independent code reviews, one per repo, verified the fix claims against the code and against live requests.

---

## 1. Verdict

| Repo | Status | Verdict |
|---|---|---|
| **safeer_api** | All planned work done (B1–B19, C1–C47) | ✅ **Deliverable.** Every High fix is verified real. 12 small follow-ups remain (A1–A12, none blocking). |
| **safeer_web** | Session 1 done (Phases 0–6: public site, apply flow, student portal). **Session 2 not started**: all 14 admin screens are missing. | ⚠️ **Not deliverable yet.** Green against its mocks, but **4 pages or flows break against the real API**, plus some UX, security and performance issues (W1–W24). Fix these before starting Session 2. |

**The main lesson:** frontend tests were green only because the mocks disagreed with the real backend in ways nobody noticed. Every test pass so far was against mocks. From now on, **every phase must also pass e2e against the real API** (see the fix prompt).

## 2. What I ran

| Check | safeer_api | safeer_web |
|---|---|---|
| Install / build / lint | ✅ / ✅ / ✅ | ✅ / ✅ (no warnings) / ✅ (eslint + lint-styles + prettier) |
| Migrations | ✅ 15 applied. A second run does nothing. `schema:check` finds 39 tables matching. | — |
| Unit / integration | ✅ **458/458** Jest (37 suites, real DB) | ✅ **163/163** app + **52/52** server (Vitest) |
| Contract / guards | ✅ `openapi:check`, ✅ `check:admin-roles` | ✅ gzip budget **135.9 KB / 150 KB**, ✅ prod artifact has no `/_kit` and no mocks |
| End-to-end | ✅ smoke **14/14** against the running API | ✅ **167/167 against mocks** · ❌ **95 passed / 20 failed against the real API** |

Some of the 20 real-API failures only assert mock fixture data. The real problems behind them are W1–W4 below.

## 3. Backend (`safeer_api`)

### Fix verification

**Verified ✅ against the code, and live against the API where cheap:**
- **B-items:** B1, B2, B3, B16, B17, B18, B19.
- **High C-items:** C1–C11 (C12 is partial, below).
- **Medium and Low C-items:** C13–C15, C18, C19, C23–C25, C27–C29, C37, C42, C44, C47.
- **Docs:** `.env.example` and the deployment doc match `env.ts`, covering `FRONTEND_BASE_URL`, `MIGRATION_DB_*`, S3, Unifonic, UTC, retention, backups and rollback.
- **Spec:** all 14 admin screens have backing endpoints.

**Partial ⚠️:**
- **C12:** the lockout backoff never decays.
- **C20:** editors see the unread-message count.
- **C21:** the OTP request still waits for the SMS to send.
- **C22:** introduced a new lockout abuse.
- **C43:** the new duplicate check uses `LOWER()`.

### Remaining backend issues (A1–A12)

| ID | Sev | Issue | Where | Fix |
|---|---|---|---|---|
| A1 | Med | **Applicant lockout abuse (C22 regression).** A failed verify is counted even when no code was issued. 10 calls lock any applicant out until the next UTC day. | `portal-otp.service.ts:230` | Count a failure only when a live OTP row exists. |
| A2 | Med | **Staff login reveals which emails exist.** Unknown email ≈5 ms, active account ≈145 ms, because the dummy hash uses m=1,t=1. | `auth.service.ts:106`, `users.service.ts:18` | At boot, build the dummy hash with the real `PasswordService` parameters. |
| A3 | Med | **Admins can be kept locked out (C12).** `lock_count` never decays, so each lock doubles up to 16 h. | `auth.service.ts:410` | Decay the count after 24 h without a lock, or cap the lock at 1 h. |
| A4 | Med | **Timing reveals whether an identifier exists (C21).** `request-otp` does its DB writes and waits up to 5 s for the SMS only when the identifier matches an application. | `portal-otp.service.ts:125` | Respond first, then send (with the email fallback) in the background. |
| A5 | Low | **Editors see a count they shouldn't.** The overview shows `unreadMessages` to editors. | `admin-overview.service.ts:67` | `AREA_ROLES.inbox.includes(role)` |
| A6 | Low | **Duplicate check scans and locks.** It uses `LOWER(a.email) … FOR UPDATE`, so it scans the table and locks every open application. | `applications.service.ts:67` | Use plain `=`; the collation is already case-insensitive. |
| A7 | Low | **Migration 012 can encrypt with the wrong key.** It uses whatever `APP_ENCRYPTION_KEY` the migrate process has, then 013 drops the plaintext. | `012_encrypt_id_number.mjs` | Check the key (a check value stored in settings), and document it. |
| A8 | Low | **The dev module is always imported.** Only `NODE_ENV` guards the `__dev/otp/:id` peek hook. | `app.module.ts:111` | Import `DevModule` only when `isDevEnv()`. |
| A9 | Low | **Interview routes can run up the SMS bill.** Booking and cancelling have no route throttle, and each call sends mail + SMS. | `portal-interview.controller.ts:17` | `@Throttle` ~5/h |
| A10 | Low | **The idle-draft purge can delete a live draft's files.** It deletes files before the conditional row delete, so a draft submitted mid-purge loses its files. | `maintenance.service.ts:158` | Delete the row under a lock first, then the files. |
| A11 | Low | **Upgrade-path gaps.** <ul><li>007 doesn't scrub OTP codes already sitting in the logs.</li><li>008 marks brute-force-locked users `disabled`. If that's the only admin, no active admin is left.</li><li>The admin detail shows download links for superseded documents whose files were deleted.</li></ul> | migrations 007/008, admin detail | <ul><li>Scrub old codes in 007.</li><li>008: never disable the last admin.</li><li>Hide the download link for superseded documents.</li></ul> |
| A12 | Low | **No map field for the contact page.** The spec §3 contact screen has a map, but there's no map field in `site_settings`. | `site_settings` | Add `map_embed_url` (safeUrl, allow-listed host) and `map_lat/lng`. |

## 4. Frontend (`safeer_web`, Session 1)

### Broken against the real API (blockers)

| ID | Issue | Evidence | Fix |
|---|---|---|---|
| **W1** | **The board page is blank.** The frontend expects `BoardMember[]`, but the API returns `{ board, executive }`. SSR logs a `TypeError … .filter is not a function`. | `curl :3900/api/v1/board`, `public-api.ts:63`, `mocks/fixtures/board.json` | Type it as `{board, executive}`, fix the fixture, and add a test. |
| **W2** | **The portal update log breaks.** `GET /portal/notifications` returns paged `{data,total,page,limit}`, but the frontend expects an array. The event types also don't match: the frontend uses `DOCUMENTS_REQUESTED/DOCUMENT_UPLOADED/…`, while the API sends `STARTED, DOCS_REQUESTED, DOCS_RECEIVED, APPLICANT_CORRECTED, SUBMITTED, STATUS_CHANGED, DOCUMENT_REJECTED, INTERVIEW_BOOKED, INTERVIEW_CANCELLED`. | `portal-api.ts:69`, `portal-status.ts:28` | Handle the paged shape, align the event set with its i18n keys, and fix the fixtures. |
| **W3** | **Newsletter confirm and unsubscribe always return 400.** The API requires `{email, token}` (strict), and the mailed links carry both. The frontend sends `{token}`. | `public-api.ts:123,128`, `newsletter-token.ts` | Read `email` from the query and send `{email, token}`. |
| **W4** | **Uploads silently replace each other.** `certificate`/`other` allow multiple files, but the API keeps **one current file per type**. A second upload replaces the first while the UI still lists both. The client also DELETEs the rows it replaced. | `apply-documents.ts:31,149-160` | Treat every type as single. Remove the client-side delete. |

### UX and visual (checked with screenshots against the real API)

| ID | Issue | Fix |
|---|---|---|
| **W5** | **The English header breaks at 1440.** The nav uses full page titles ("Scholarships for international students in Saudi universities"), so the logo overlaps "Home", the tagline wraps under it, the Apply button is clipped, and the page scrolls horizontally (8 px). In Arabic the org name truncates to «جمعية س…». | Use short nav labels: add a `navLabel` to `GET /site` nav items or a frontend map keyed by slug. The header must never overflow. Add an e2e overflow check at 1100/1280/1440 with **real** data. |
| **W6** | **Internal CMS labels show publicly.** The hero eyebrow shows «الواجهة الرئيسية» / "Hero", which is the internal section label. | Don't render `label` as an eyebrow, or only for keys that the prototype shows with one. |
| **W7** | **Image placeholders are blank grey boxes.** They lack the labelled `[صورة: …]` text the brief requires. | Render the labelled placeholder (visible and `aria-label`). |
| **W8** | **Touch targets are under 44 px:** footer links (28 px), breadcrumb and news-card title links (24–33 px). | Pad them to ≥44 px. |

### Security, correctness and performance

| ID | Sev | Issue | Fix |
|---|---|---|---|
| **W9** | High | **The transfer cache never hits.** The server keys cache entries on the internal URL (`http://127.0.0.1:3900/…`) and the browser on `/api/v1/…`. So every page fetches its data twice, the HTML carries unused JSON, and the **internal API origin appears in the page source**. | Rewrite the URL beneath the cache, or use `HTTP_TRANSFER_CACHE_ORIGIN_MAP`. Add an e2e test asserting no `/api` requests after hydration. |
| **W10** | Med | **The offline draft is never cleared** on logout or 401 (`onClear` has no listener), so the next applicant in the same tab is offered the previous applicant's data (review item F5). | Register `session.onClear(clearDraft)`. Tie the draft to its `reference`. |
| **W11** | Med | **A transient API error signs the student out.** `ApplicantSessionStore.refresh()` clears the session on *any* error, so a 502/timeout does it. | Clear only on 401. |
| **W12** | Med | **A bad news category returns 500.** `/news?category=unknown` gives an SSR 500, because the API's 400 is mapped to an error. | Validate against the categories (drop the param or 404), or map a 400 to not-found. |
| **W13** | Med | **All 14 font files are preloaded on every page** (~430 KB), because the critical-CSS inliner promotes each `@font-face`. It will fail Lighthouse. | Load `fonts.css` as non-critical CSS, and hand-preload the 1–2 faces used above the fold for each locale. |
| **W14** | Med | **Client validation diverges from the API.** The phone regex rejects Arabic-Indic digits. The name regex allows characters the API (C16) rejects, so English zod messages leak into the Arabic UI. `apply.ts` imports from the contact component (the cross-chunk import the handoff warns against). | Add a shared `core/validation` module that mirrors the backend rules, and normalise digits first. |
| **W15** | Med | **Roles never match the real API.** The role-matrix keys (per collection) don't match the real `GET /admin/roles` (`applications, content, inbox, users, settings, audit, *.delete`), so the guards will fail against the real API. | Adopt the real area keys in the fixture, `role-matrix.ts` and `roleGuard`, before Session 2 starts. |
| **W16** | Med | **Invite and reset links fall through to 404.** There are no `/:lang/admin/accept/:token` or `/:lang/admin/reset/:token` routes, and backend C2 now mails exactly these links. | Add them as Session 2 Phase 7 **first** items (they're already in the plan). Until then, stub pages that explain the step. |
| **W17** | Low | **Some backend error codes show a generic message:** `QUOTA_EXCEEDED` and `DOCUMENT_NOT_REVIEWABLE` are missing from `KNOWN_CODES`. | Add them with translations. |
| **W18** | Low | **Any `?preview=junk` marks a published post as a preview** (banner + noindex). Preview HTML is sent `no-cache`, not `no-store`. | Derive the preview flag from the API response. Send `no-store`. |
| **W19** | Low | **Stale SEO tags after navigation.** `SeoService.noindex()` leaves the previous page's canonical, hreflang, OG and JSON-LD in place. | Clear them. |
| **W20** | Low | **Four social links aren't shown.** The API added YouTube, LinkedIn, WhatsApp and TikTok; the footer ignores them. | Render them when set. |
| **W21** | Low | **Dead code and a stray file:** `sitemapIndex()` is unused, and `shot-tmp.mjs` sits in the repo root. | Remove both. |
| **W22** | Low | **HANDOFF.md is stale.** <ul><li>§3 claims the transfer cache works (it doesn't) and that `onClear` is wired (nothing listens).</li><li>§6 lists B1, B2, B15, B16, B17, B18, C17 and C27 as "mocked", but they're all live.</li><li>The C15 `PATCH /portal/application/corrections` route isn't mentioned.</li></ul> | Refresh it against `safeer_api` HEAD. Session 2 depends on it. |
| **W23** | Low | **The API contract snapshot is stale.** `docs/api/` still describes the pre-fix API: newsletter `{token}`, mocked B-items. | Re-snapshot from `safeer_api` HEAD, including `docs/backend/API-CHANGES.md`. |
| **W24** | Process | **Every e2e pass was against mocks only.** | Add a CI job that runs the e2e suite against the real API: boot `safeer_api` from its repo at a pinned commit with MySQL. Fixture-specific assertions become mock-only; everything else must pass on both. |

### Checked and correct

- **CSP:** a per-response nonce that matches every script and style, including the CSR shell.
- **Host validation.**
- **Proxy:** XFF overwritten, spoofable headers stripped, cookies passed through, 502/504 as problem+json.
- **`returnUrl`** handling is allow-listed.
- **Only one `innerHTML`, and it's re-sanitized.**
- **No per-request state leaks during SSR.**
- **Status codes:** 404, 410, and 503 + `Retry-After` in about 0.2 s when the API is down.
- **Apply payloads:** the F4 null/omit rules match the real schemas. The OTP and interview payloads are correct.
- **Design tokens:** match the spec in light and dark.
- **Hygiene:** no physical left/right CSS, reduced motion respected, no hydration errors.
- **Mobile Arabic:** the home and apply pages render correctly.

## 5. What's left before launch

1. Run `safeer-web-fix-prompt.md` (W1–W24) in `safeer_web`. **Then** start Session 2, the admin dashboard, which has 14 screens still to build.
2. Run `safeer-api-followup-prompt.md` (A1–A12) in `safeer_api`. It can run in parallel.
3. Client inputs still missing: the official logo SVG, real impact numbers and photos, the partner list, the production domain, which SMS provider account to use (Unifonic is implemented), and the Hostinger Node runtime version.
4. Before go-live: Session 2 Phase 10 (full viewport matrix, Lighthouse, deployment). Then a joint staging run with both apps on Hostinger, and one full real student journey: apply → OTP → documents → review → interview → decision.
