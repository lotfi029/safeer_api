# Prompt — safeer_api: delivery-review follow-ups (A1–A12)

> Run Claude Code on the `safeer_api` repo and paste everything below the line.

---

You are finishing **safeer_api**. All items B1–B19 and C1–C47 were fixed and verified by a delivery review:
- 458 Jest tests
- smoke 14/14
- `schema:check`
- `openapi:check`
- `check:admin-roles`

The review found 12 follow-ups: 4 of the fixes are partial or regressed, plus small gaps. Fix them without breaking anything.

## Read first
- `docs/safeer-delivery-review.md` §3: items **A1–A12**, with location, evidence and fix for each.
- `docs/backend/FIX-PLAN-STATUS.md` and `docs/backend/API-CHANGES.md`: what the previous pass did. Keep its conventions: new numbered migrations only, entities in sync, `ProblemException` codes, tests per item.

## Tasks

**A1–A4 (Medium).** Each needs a regression test that reproduces the abuse first, then passes.
- **A1:** count a failed OTP verify only when a live code exists. Test: 10 verifies against an application with no live code must leave `otp_fail_count` at 0.
- **A2:** equal-cost login for unknown, disabled and active emails.
  - Build the dummy hash at boot with the real `PasswordService` parameters.
  - Test the timing ratio loosely, allowing for CI noise. Assert that the same Argon2 parameters are used, rather than asserting on milliseconds.
- **A3:** `lock_count` decays: reset it once 24 h pass since the last lock, and cap any single lock at 1 h. Update the C12 tests.
- **A4:** `request-otp` answers before any SMS send.
  - The DB write and the send (with the email fallback) run in the background for matches only, with the same response time for matches and misses.
  - Keep B1's guarantee: the OTP row is committed before any send.

**A5–A12 (Low).** As described in the review:
- **A5:** overview inbox figures use `AREA_ROLES.inbox`.
- **A6:** the duplicate check uses plain `=`. Confirm with `EXPLAIN` in a test comment that it uses `ix_applications_email`.
- **A7:** `APP_ENCRYPTION_KEY` guard.
  - Store a key check value (an HMAC of a constant) in `site_settings` on first use.
  - Migrations and the app refuse to start when the key doesn't match.
  - Document it in `DEPLOYMENT-HOSTINGER.md`.
- **A8:** import `DevModule` only when `isDevEnv()`. Test that the route doesn't exist in `production` or `staging`.
- **A9:** `@Throttle` (~5/h) on interview book and cancel.
- **A10:** the idle-draft purge deletes the row under a lock first, then its files.
- **A11:**
  - A new migration scrubs OTP codes from old `sms_log.message` and `mail_log.subject` rows.
  - Migration 008's successor ensures at least one `active` admin remains.
  - The admin application detail hides download links for superseded documents.
- **A12:** add `map_embed_url` (`safeUrl`, host allow-list: `www.google.com/maps/embed`, `www.openstreetmap.org`) and `map_lat`/`map_lng` to `site_settings`. Expose them in `GET /site` and the admin settings DTO. Record the contract change in `API-CHANGES.md`.

## Rules
- Branch `fix/delivery-followups`, one draft PR against `main`. Never merge, never force-push.
- Gate: `npm run build && npm run lint && npm test && npm run openapi:check && npm run check:admin-roles`, then `npm run migrate` twice (the second run must do nothing) and `npm run smoke -- --confirm=<db>`.
- Update `docs/backend/FIX-PLAN-STATUS.md` with an A-items table: item → fix → commit → test.
- If a fix changes the API contract (A12, and A4's response timing), add it to `docs/backend/API-CHANGES.md` so `safeer_web` can pick it up.

Start with A1–A4, then report before doing A5–A12.
