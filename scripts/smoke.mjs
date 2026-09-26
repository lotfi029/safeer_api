#!/usr/bin/env node
// scripts/smoke.mjs — end-to-end smoke suite for the Safeer API.
//
// Ported from `african_api`'s reference suite in phase 1 with only
// mechanical renames, so it spent phases 1-7 carrying ~200 lines of cases
// for domains this project never had (governance, library, channels,
// donations, products, languages, posts-as-a-different-shape, …) — deferred
// to this final phase per the project plan. This is a full rewrite against
// Safeer's actual routes: the content CMS, contact/newsletter, the messages
// inbox, the scholarship apply-flow + OTP student portal, and admin
// applications review. It keeps the reference suite's conventions
// (`test(name, fn)` / `assert(cond, msg)`, login as the bootstrap admin,
// `X-CSRF-Token` on writes, each case cleaning up its own rows, a `main()`
// that prints PASS/FAIL and exits 1 on any failure) and its habit of
// connecting directly to the database with mysql2 for setup/assertions an
// HTTP-only test can't otherwise reach (reading a one-time code out of
// sms_log/mail_log, seeding a role-specific user, counting rows before/after).
//
// Usage:
//   npm run build && npm start   (or start:dev) in one terminal
//   node scripts/smoke.mjs       in another   (or: npm run smoke)
//
// Requires BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD in .env and a
// freshly migrated + seeded database (`npm run db:reset`) — several cases
// (legacy-news bulk-delete, the permission matrix) assume the dev sample
// fixtures are exactly as `migrations/dev/003_dev_sample.sql` left them.

import 'dotenv/config';
import mysql from 'mysql2/promise';
import * as argon2 from 'argon2';

const PORT = process.env.PORT ?? '3900';
const BASE = `http://localhost:${PORT}/api/v1`;
const HEALTH_URL = `http://localhost:${PORT}/health`;
const FILES_BASE = `http://localhost:${PORT}/files`;
const EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL;
const PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const STAFF_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'sf_sid';
const APPLICANT_COOKIE_NAME = process.env.APPLICANT_SESSION_COOKIE_NAME || 'sf_app_sid';

// A minimal but genuinely valid PDF — real magic bytes, so `file-type`
// classifies it as `application/pdf` the same way a real upload would (the
// same shape phase 7's own smoke case for meeting-style attachments used).
function tinyPdf(tag) {
  return Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF smoke-${tag}-${Date.now()}`);
}

let admin = { cookie: '', csrfToken: '' };

async function api(method, path, { body, session = admin } = {}) {
  const headers = { Cookie: session.cookie };
  if (method !== 'GET') headers['X-CSRF-Token'] = session.csrfToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function loginAs(email, password) {
  const res = await fetch(`${BASE}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`login failed: ${res.status} ${text}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('login did not set a session cookie');
  const cookie = setCookie.split(';')[0];
  const csrfToken = JSON.parse(text).csrfToken;
  if (!csrfToken) throw new Error('login response carried no csrfToken');
  return { cookie, csrfToken };
}

/**
 * Direct mysql2 connection, mirroring the reference suite's own pattern for
 * setup/assertions an HTTP-only test can't reach: reading a one-time OTP
 * code out of `sms_log`, seeding a role-specific staff user, counting rows
 * before/after a honeypot submission, resolving an application's numeric id
 * from its public reference.
 */
async function withDb(fn) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4_unicode_ci',
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

/**
 * A temporary staff user for a role the seed carries none of, created by a
 * direct row insert rather than the invite/accept-token email flow: the
 * default dev mail settings are `is_enabled=0`/`driver='log'` (002_seed.sql),
 * so `mail_log.payload` — the only place the raw invite token ever appears
 * in plaintext — is written null (mail.service.ts's `send()` only fills
 * `payload` for a `queued` row, and a disabled driver always writes
 * `skipped`), leaving no way for an external script to recover it. The
 * invite endpoint's whole *point* (FR-A-09: admins never type another
 * user's password) does not apply to a script creating its own throwaway
 * fixture account, so hashing a known password directly — the same
 * Argon2id `PasswordService.hash()` uses — and inserting the row is the
 * cleaner mechanism here, mirroring how `users.service.ts`'s
 * `createInvitedUser()` builds a row directly outside the HTTP layer too.
 * Deleted at the end of the owning test; `sessions` cascades on delete
 * (001_schema.sql `fk_session_user ... ON DELETE CASCADE`).
 */
async function createTempUser(role) {
  const password = 'Smoke-Test-P4ssword!';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const email = `smoke-${role}-${Date.now()}@example.com`;
  const id = await withDb(async (conn) => {
    const [result] = await conn.execute(
      'INSERT INTO users (name, email, password_hash, role, is_locked, failed_logins) VALUES (?, ?, ?, ?, 0, 0)',
      [`Smoke ${role}`, email, passwordHash, role],
    );
    return String(result.insertId);
  });
  const session = await loginAs(email, password);
  return { id, email, ...session };
}

async function deleteTempUser(id) {
  await withDb((conn) => conn.execute('DELETE FROM users WHERE id = ?', [id]));
}

/** `cookie` is `"name=value"` (as captured from a `Set-Cookie` header) — the bare token is everything after the first `=`. */
function rawTokenFromCookie(cookie) {
  return cookie.slice(cookie.indexOf('=') + 1);
}

/**
 * `POST applications` (step 1 only) — the public "start an application"
 * entry point. Throttled 5/hour/IP (applications.controller.ts), so every
 * case below that needs one shares as few of these calls as the plan's
 * fixture-sharing convention (`editorSession()` in the reference suite)
 * allows: see `sharedApplicants()`.
 */
async function createApplication(overrides = {}) {
  const email = overrides.email ?? `smoke-app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const body = {
    firstName: overrides.firstName ?? 'Test',
    middleName: overrides.middleName ?? null,
    lastName: overrides.lastName ?? 'Applicant',
    birthDate: overrides.birthDate ?? '2000-01-01',
    phone: overrides.phone ?? `+9665${String(Date.now()).slice(-8)}`,
    nationality: overrides.nationality ?? 'SA',
    idNumber: overrides.idNumber ?? null,
    email,
    currentJob: overrides.currentJob ?? null,
    gender: overrides.gender ?? 'male',
  };
  const res = await fetch(`${BASE}/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`create application failed: ${res.status} ${text}`);
  const json = JSON.parse(text);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('applications did not set a session cookie');
  const cookie = setCookie.split(';')[0];
  const id = await withDb((conn) =>
    conn
      .execute('SELECT id FROM applications WHERE reference = ?', [json.reference])
      .then(([rows]) => rows[0]?.id && String(rows[0].id)),
  );
  if (!id) throw new Error(`could not resolve the numeric id for reference ${json.reference}`);
  return { id, reference: json.reference, cookie, csrfToken: json.csrfToken, email, firstName: body.firstName, lastName: body.lastName };
}

/** Deletes an application (cascades to its documents/notes/events/sessions/OTPs — 001_schema.sql) and any interview slot it booked. */
async function deleteApplication(applicationId) {
  await withDb(async (conn) => {
    await conn.execute('UPDATE interview_slots SET application_id = NULL WHERE application_id = ?', [applicationId]);
    await conn.execute('DELETE FROM applications WHERE id = ?', [applicationId]);
  });
}

async function readSmsOtpCode(applicationId) {
  const message = await withDb((conn) =>
    conn
      .execute(
        "SELECT message FROM sms_log WHERE entity_type = 'applications' AND entity_id = ? AND template_key = 'otp_code' ORDER BY id DESC LIMIT 1",
        [applicationId],
      )
      .then(([rows]) => rows[0]?.message),
  );
  const match = typeof message === 'string' ? message.match(/\d{6}/) : null;
  if (!match) throw new Error(`no 6-digit OTP found in sms_log.message for application ${applicationId}: ${JSON.stringify(message)}`);
  return match[0];
}

/** B1's email-fallback path (portal-otp.service.ts) writes the code into mail_log's rendered payload/subject instead of sms_log. */
async function readMailOtpCode(applicationId) {
  const row = await withDb((conn) =>
    conn
      .execute(
        "SELECT subject, payload FROM mail_log WHERE entity_type = 'applications' AND entity_id = ? AND template_key = 'otp_code' ORDER BY id DESC LIMIT 1",
        [applicationId],
      )
      .then(([rows]) => rows[0]),
  );
  const haystack = `${row?.subject ?? ''} ${JSON.stringify(row?.payload ?? '')}`;
  const match = haystack.match(/\d{6}/);
  if (!match) throw new Error(`no 6-digit OTP found in mail_log for application ${applicationId}: ${JSON.stringify(row)}`);
  return match[0];
}

/**
 * B1: the seed default has SMS disabled (`sms_settings.is_enabled = 0`), so
 * OTP requests fall back to email unless a case explicitly turns SMS on
 * (with the harmless `log` driver) first. Returns a restore function that
 * puts the previous settings back exactly.
 */
async function withSmsEnabled(fn) {
  const before = await api('GET', '/admin/sms/settings');
  assert(before.status === 200, `GET admin/sms/settings failed: ${before.status}`);
  const enabled = await api('PUT', '/admin/sms/settings', { body: { isEnabled: true, driver: 'log' } });
  assert(enabled.status === 200, `enabling SMS (log driver) failed: ${enabled.status}: ${JSON.stringify(enabled.body)}`);
  try {
    return await fn();
  } finally {
    const restored = await api('PUT', '/admin/sms/settings', {
      body: { isEnabled: before.body.isEnabled, driver: before.body.driver },
    });
    assert(restored.status === 200, `restoring sms_settings failed: ${restored.status}`);
  }
}

async function uploadApplicationDocument(session, docType, tag) {
  const form = new FormData();
  form.append('docType', docType);
  form.append('file', new Blob([tinyPdf(tag)], { type: 'application/pdf' }), `${tag}.pdf`);
  const res = await fetch(`${BASE}/portal/documents`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken },
    body: form,
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixtures shared across a handful of cases, to stay well inside
// `POST applications`' 5/hour/IP throttle across one suite run (create,
// reference-sequencing, private-document-isolation and the applicant CSRF
// case all need an applicant session; two applications cover all of them).
// Same caching pattern the reference suite used for its own throttle-shared
// `editorSession()`.

let cachedApplicants = null;
async function sharedApplicants() {
  if (!cachedApplicants) {
    const a = await createApplication({ firstName: 'Sara', lastName: 'Alqahtani' });
    const b = await createApplication({ firstName: 'Noura', lastName: 'Alharbi' });
    cachedApplicants = { a, b };
  }
  return cachedApplicants;
}

// ---------------------------------------------------------------------------
// Permission matrix — the plan's table: editor is applications/reviewer-only
// content is denied to it; support has no access to the editor-only content
// collections; reviewer has no access to admin-only settings.

test('permissions: editor is refused admin/applications, support is refused admin/news, reviewer is refused admin/settings', async () => {
  const editor = await createTempUser('editor');
  const support = await createTempUser('support');
  const reviewer = await createTempUser('reviewer');
  try {
    const asEditor = await api('GET', '/admin/applications', { session: editor });
    assert(asEditor.status === 403, `editor should be refused admin/applications, got ${asEditor.status}`);
    assert(asEditor.body?.code === 'FORBIDDEN', `expected FORBIDDEN, got ${asEditor.body?.code}`);

    const asSupport = await api('GET', '/admin/news', { session: support });
    assert(asSupport.status === 403, `support should be refused admin/news, got ${asSupport.status}`);
    assert(asSupport.body?.code === 'FORBIDDEN', `expected FORBIDDEN, got ${asSupport.body?.code}`);

    const asReviewer = await api('GET', '/admin/settings', { session: reviewer });
    assert(asReviewer.status === 403, `reviewer should be refused admin/settings, got ${asReviewer.status}`);
    assert(asReviewer.body?.code === 'FORBIDDEN', `expected FORBIDDEN, got ${asReviewer.body?.code}`);

    // Sanity: each role IS allowed into its own area, so the 403s above are
    // really about the role, not a broken session.
    const editorOwn = await api('GET', '/admin/news', { session: editor });
    assert(editorOwn.status === 200, `editor should be allowed into admin/news, got ${editorOwn.status}`);
    const reviewerOwn = await api('GET', '/admin/applications', { session: reviewer });
    assert(reviewerOwn.status === 200, `reviewer should be allowed into admin/applications, got ${reviewerOwn.status}`);
    const supportOwn = await api('GET', '/admin/messages', { session: support });
    assert(supportOwn.status === 200, `support should be allowed into admin/messages, got ${supportOwn.status}`);

    // B4/B5 (safeer-backend-fr-review.md): redirects and media are
    // admin+editor only — a reviewer or support account gets refused, an
    // editor gets through.
    const supportRedirects = await api('GET', '/admin/redirects', { session: support });
    assert(supportRedirects.status === 403, `support should be refused admin/redirects (B4), got ${supportRedirects.status}`);
    const editorRedirects = await api('GET', '/admin/redirects', { session: editor });
    assert(editorRedirects.status === 200, `editor should be allowed into admin/redirects (B4), got ${editorRedirects.status}`);

    const reviewerMedia = await api('GET', '/admin/media', { session: reviewer });
    assert(reviewerMedia.status === 403, `reviewer should be refused admin/media (B5), got ${reviewerMedia.status}`);
    const editorMedia = await api('GET', '/admin/media', { session: editor });
    assert(editorMedia.status === 200, `editor should be allowed into admin/media (B5), got ${editorMedia.status}`);
  } finally {
    await deleteTempUser(editor.id);
    await deleteTempUser(support.id);
    await deleteTempUser(reviewer.id);
  }
});

// ---------------------------------------------------------------------------
// Locale collapse — the seed turned out fully bilingual (phase 4's report),
// so there is no pre-existing empty English field to observe the fallback
// on. This PATCHes a real about-item's `titleEn` to null, confirms
// `GET home?lang=en` falls back to the Arabic value for that one item, then
// restores it — the same "patch a field to null and revert" approach phase
// 4 used during its own manual verification.

test('locale collapse: GET home?lang=en falls back to Arabic when titleEn is null, admin views keep both columns', async () => {
  const before = await fetch(`${BASE}/home`).then((r) => r.json());
  const goal = before.aboutItems?.goals?.[0];
  assert(goal, 'expected at least one published "goal" about-item in the seed to run this case against');

  const original = await api('GET', `/admin/about-items/${goal.id}`);
  assert(original.status === 200, `could not read the about-item back from the admin side: ${original.status}`);
  const originalTitleEn = original.body.titleEn;
  const originalTitleAr = original.body.titleAr;

  try {
    const cleared = await api('PATCH', `/admin/about-items/${goal.id}`, { body: { titleEn: null } });
    assert(cleared.status === 200, `clearing titleEn failed: ${cleared.status}`);
    // The admin surface is never collapsed (11-architecture.md §3) — both raw columns must still be there.
    assert(cleared.body.titleAr === originalTitleAr && cleared.body.titleEn === null, 'admin response must keep raw titleAr/titleEn, not collapse them');

    const homeEn = await fetch(`${BASE}/home?lang=en`).then((r) => r.json());
    const itemEn = homeEn.aboutItems.goals.find((g) => g.id === goal.id);
    assert(itemEn, 'the about-item disappeared from GET home?lang=en after clearing titleEn');
    assert(!('titleAr' in itemEn) && !('titleEn' in itemEn), `a public route must collapse titleAr/titleEn into "title", got keys: ${Object.keys(itemEn)}`);
    assert(itemEn.title === originalTitleAr, `expected the Arabic fallback "${originalTitleAr}", got "${itemEn.title}"`);

    // Default locale (no ?lang=) must also read as Arabic — trivially true here, but confirms the fallback isn't only reachable via ?lang=en.
    const homeAr = await fetch(`${BASE}/home`).then((r) => r.json());
    const itemAr = homeAr.aboutItems.goals.find((g) => g.id === goal.id);
    assert(itemAr?.title === originalTitleAr, 'default (Arabic) locale must show the Arabic title');
  } finally {
    const restored = await api('PATCH', `/admin/about-items/${goal.id}`, { body: { titleEn: originalTitleEn } });
    assert(restored.status === 200, `failed to restore the original titleEn: ${restored.status}`);
    const homeRestored = await fetch(`${BASE}/home?lang=en`).then((r) => r.json());
    const restoredItem = homeRestored.aboutItems.goals.find((g) => g.id === goal.id);
    assert(restoredItem?.title === originalTitleEn, 'titleEn was not actually restored — GET home?lang=en still shows the Arabic fallback');
  }
});

// ---------------------------------------------------------------------------
// Apply flow + reference sequencing — two consecutive `POST applications`
// calls must mint sequential reference numbers (applications.service.ts's
// `counters` row, locked `FOR UPDATE`).

test('apply flow: two consecutive POST applications mint sequential references', async () => {
  const { a, b } = await sharedApplicants();
  assert(a.reference !== b.reference, 'two applications minted the same reference');

  const [, yearA, seqA] = a.reference.split('-');
  const [, yearB, seqB] = b.reference.split('-');
  assert(yearA === yearB, `expected both references to share a year, got ${a.reference} / ${b.reference}`);
  assert(Number(seqB) === Number(seqA) + 1, `expected sequential references, got ${a.reference} then ${b.reference}`);

  // application_started mail fired for both (mail is disabled by default in
  // the seed, so this is a 'skipped' row, not 'sent' — its presence is what
  // matters here, delivery is covered by the full review-loop case below).
  const startedRows = await withDb((conn) =>
    conn
      .execute(
        "SELECT entity_id FROM mail_log WHERE entity_type = 'applications' AND template_key = 'application_started' AND entity_id IN (?, ?)",
        [a.id, b.id],
      )
      .then(([rows]) => rows),
  );
  assert(startedRows.length === 2, `expected an application_started mail_log row for each application, found ${startedRows.length}`);
});

// ---------------------------------------------------------------------------
// CSRF — a staff write and an applicant write, both missing X-CSRF-Token,
// must be refused. Guards run before body-validation pipes (Nest's request
// lifecycle), so an intentionally empty/invalid body is fine here — the
// point is that the request never reaches validation at all.

test('CSRF: a staff write and an applicant write without X-CSRF-Token are both refused', async () => {
  const staffRes = await fetch(`${BASE}/admin/board`, {
    method: 'POST',
    headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert(staffRes.status === 403, `staff write without X-CSRF-Token should be refused, got ${staffRes.status}`);
  const staffBody = await staffRes.json();
  assert(staffBody.code === 'FORBIDDEN', `expected FORBIDDEN, got ${staffBody.code}`);

  const { a } = await sharedApplicants();
  const applicantRes = await fetch(`${BASE}/portal/application`, {
    method: 'PATCH',
    headers: { Cookie: a.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert(applicantRes.status === 403, `applicant write without X-CSRF-Token should be refused, got ${applicantRes.status}`);
  const applicantBody = await applicantRes.json();
  assert(applicantBody.code === 'FORBIDDEN', `expected FORBIDDEN, got ${applicantBody.code}`);
});

// ---------------------------------------------------------------------------
// Private document isolation — a document uploaded by applicant A must be
// unreachable via /files/:publicId (it was never given a media_assets row,
// let alone a publicId), unreachable through applicant B's own portal
// session, and a staff cookie must be rejected on an @ApplicantRoute()
// endpoint and vice versa (SessionGuard's two entirely separate resolution
// paths — session.guard.ts).

test('private documents: unreachable via /files, via another applicant, and staff/applicant cookies are never cross-accepted', async () => {
  const { a, b } = await sharedApplicants();

  const uploaded = await uploadApplicationDocument(a, 'id_copy', 'isolation');
  assert(uploaded.status === 201, `upload failed: ${uploaded.status}: ${JSON.stringify(uploaded.body)}`);
  const doc = uploaded.body;

  // Never reachable through the public media pipeline — it was never
  // recorded in media_assets, so no publicId exists for it at all; a probe
  // with its own checksum (the only asset-shaped identifier the API ever
  // hands back for it) is treated as a plain unknown id.
  const filesRes = await fetch(`${FILES_BASE}/${doc.checksum}`);
  assert(filesRes.status === 404, `a private application document must never be reachable via /files, got ${filesRes.status}`);

  // Applicant B's own portal session must not be able to read A's document.
  const crossRes = await api('GET', `/portal/documents/${doc.id}/file`, { session: b });
  assert(crossRes.status === 404, `applicant B should get 404 reading applicant A's document, got ${crossRes.status}`);

  // A staff cookie value presented as the applicant cookie on an
  // @ApplicantRoute() endpoint must be rejected (it won't hash to any row in
  // applicant_sessions).
  const staffOnPortal = await fetch(`${BASE}/portal/me`, {
    headers: { Cookie: `${APPLICANT_COOKIE_NAME}=${rawTokenFromCookie(admin.cookie)}` },
  });
  assert(staffOnPortal.status === 401, `a staff cookie on a portal route must be rejected, got ${staffOnPortal.status}`);

  // And the reverse: an applicant cookie value presented as the staff
  // cookie on a staff-authenticated route must also be rejected.
  const applicantOnStaff = await fetch(`${BASE}/admin/me`, {
    headers: { Cookie: `${STAFF_COOKIE_NAME}=${rawTokenFromCookie(a.cookie)}` },
  });
  assert(applicantOnStaff.status === 401, `an applicant cookie on a staff route must be rejected, got ${applicantOnStaff.status}`);
});

// ---------------------------------------------------------------------------
// Shared applicant fixtures cleanup — must run after every case above that
// uses sharedApplicants(). Declared as its own case, at this point in the
// array, rather than cleaned up inside each of those (they share the
// fixture specifically to avoid re-creating it), matching the file's
// documented "each case cleans up its own rows" convention as closely as a
// shared, throttle-conserving fixture allows.

test('cleanup: remove the shared apply-flow/isolation/CSRF fixture applications', async () => {
  if (!cachedApplicants) return; // no case above actually needed the fixture (shouldn't happen, but keep this case itself never-failing)
  await deleteApplication(cachedApplicants.a.id);
  await deleteApplication(cachedApplicants.b.id);
  cachedApplicants = null;
});

// ---------------------------------------------------------------------------
// OTP (B1/B2, safeer-backend-fr-review.md) — everything here shares one
// applicant and stays within the 5/hour/IP throttle on both `POST
// applications` and `POST portal/auth/request-otp` (scripts/smoke.mjs's own
// long-standing convention — see `sharedApplicants()` above): request via
// reference with SMS on (`log` driver) → verify; request again via the
// *local* `05...` form of the same phone number (B2's phone identifier,
// resolving to the same application as its E.164 form) → 5 wrong guesses
// lock out even the right code; a bogus identifier is a silent {ok:true}
// no-op; with SMS back off (the seed default), a request falls back to
// email and channelHint still doesn't depend on whether the identifier
// matches anything; finally, a second `POST applications` for this same
// applicant's email is refused (B2's duplicate-application check) and
// sends it an `application_resume` notice.

test('OTP (B1/B2): SMS + phone identifier + lockout + bogus no-op + email fallback + duplicate application', async () => {
  const localPhone = `05${String(Date.now()).slice(-8)}`;
  const applicant = await createApplication({ firstName: 'Khalid', lastName: 'Alotaibi', phone: localPhone });
  try {
    const otpCountBefore = await withDb((conn) =>
      conn.execute('SELECT COUNT(*) AS c FROM applicant_otps WHERE application_id = ?', [applicant.id]).then(([r]) => Number(r[0].c)),
    );

    await withSmsEnabled(async () => {
      const req1 = await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference, channel: 'sms' } });
      assert(req1.status === 200 || req1.status === 201, `request-otp failed: ${req1.status}`);
      assert(req1.body.ok === true, 'request-otp must always resolve {ok:true}');
      assert(req1.body.channelHint === 'sms', `channel:'sms' should echo channelHint 'sms', got ${req1.body.channelHint}`);

      const code1 = await readSmsOtpCode(applicant.id);
      const verify1 = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: code1 } });
      assert(verify1.status === 200 || verify1.status === 201, `verify-otp with the right code failed: ${verify1.status}: ${JSON.stringify(verify1.body)}`);
      assert(typeof verify1.body.csrfToken === 'string' && verify1.body.csrfToken.length > 0, 'verify-otp must return a csrfToken');

      // B2: the *local* form of the same phone (createApplication stored it
      // as `05...`, normalized to `+9665...` on save) — a second,
      // independent code, also used to exercise the attempt limit without
      // touching the already-consumed first one.
      const req2 = await api('POST', '/portal/auth/request-otp', { body: { identifier: localPhone, channel: 'sms' } });
      assert(req2.body.ok === true, 'request-otp by the local phone form must also resolve {ok:true}');
      const code2 = await readSmsOtpCode(applicant.id);
      const wrongCode = code2 === '000000' ? '111111' : '000000';

      for (let i = 1; i <= 5; i++) {
        const wrong = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: wrongCode } });
        assert(wrong.status === 401, `wrong-code attempt #${i} should be 401, got ${wrong.status}`);
        assert(wrong.body?.code === 'OTP_INVALID', `expected OTP_INVALID, got ${wrong.body?.code}`);
      }
      // The 6th attempt, now with the CORRECT code, must still be rejected —
      // the attempt cap is checked before the code comparison.
      const lockedOut = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: code2 } });
      assert(lockedOut.status === 401, `the right code after 5 wrong attempts should still be 401, got ${lockedOut.status}`);
      assert(lockedOut.body?.code === 'OTP_INVALID', `expected OTP_INVALID, got ${lockedOut.body?.code}`);

      // A bogus identifier: the same non-committal {ok:true}, and no row created for it.
      const bogus = await api('POST', '/portal/auth/request-otp', { body: { identifier: `SA-2099-${Math.floor(Math.random() * 90000 + 10000)}` } });
      assert(bogus.body.ok === true, 'a bogus identifier must resolve the same {ok:true} as a real one');
      const otpCountAfterSms = await withDb((conn) =>
        conn.execute('SELECT COUNT(*) AS c FROM applicant_otps WHERE application_id = ?', [applicant.id]).then(([r]) => Number(r[0].c)),
      );
      assert(
        otpCountAfterSms === otpCountBefore + 2,
        `expected exactly 2 new applicant_otps rows for this application (one per real request-otp call), got ${otpCountAfterSms - otpCountBefore}`,
      );
    });

    // B1: sms_settings is back to disabled (withSmsEnabled restores it) —
    // the same identifier now falls back to email, and channelHint reflects
    // that default whether or not the identifier resolves to anything.
    const reqEmail = await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    assert(reqEmail.status === 200 || reqEmail.status === 201, `request-otp (email fallback) failed: ${reqEmail.status}`);
    assert(reqEmail.body.channelHint === 'email', `SMS disabled should default channelHint to 'email', got ${reqEmail.body.channelHint}`);

    const channel = await withDb((conn) =>
      conn
        .execute('SELECT channel FROM applicant_otps WHERE application_id = ? ORDER BY id DESC LIMIT 1', [applicant.id])
        .then(([rows]) => rows[0]?.channel),
    );
    assert(channel === 'email', `expected the applicant_otps row to record channel 'email' when SMS is disabled, got ${channel}`);

    const emailCode = await readMailOtpCode(applicant.id);
    const verifyEmail = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: emailCode } });
    assert(
      verifyEmail.status === 200 || verifyEmail.status === 201,
      `verify-otp after email fallback failed: ${verifyEmail.status}: ${JSON.stringify(verifyEmail.body)}`,
    );

    const bogusHint = await api('POST', '/portal/auth/request-otp', { body: { identifier: `SA-2099-${Math.floor(Math.random() * 90000 + 10000)}` } });
    assert(
      bogusHint.body.channelHint === reqEmail.body.channelHint,
      `channelHint for a bogus identifier (${bogusHint.body.channelHint}) must match a real one (${reqEmail.body.channelHint})`,
    );

    // B2: a second POST applications for this same applicant's email is
    // refused, and sends *this* application an application_resume notice —
    // never the newly submitted (fake) contact details.
    const resumeMailBefore = await withDb((conn) =>
      conn
        .execute("SELECT COUNT(*) AS c FROM mail_log WHERE entity_type = 'applications' AND entity_id = ? AND template_key = 'application_resume'", [
          applicant.id,
        ])
        .then(([r]) => Number(r[0].c)),
    );

    const dup = await fetch(`${BASE}/applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Someone',
        lastName: 'Else',
        birthDate: '2000-01-01',
        phone: `+9665${String(Date.now()).slice(-8)}`,
        nationality: 'SA',
        email: applicant.email,
        gender: 'male',
      }),
    });
    const dupBody = await dup.json();
    assert(dup.status === 409, `duplicate application should be refused with 409, got ${dup.status}: ${JSON.stringify(dupBody)}`);
    assert(dupBody.code === 'APPLICATION_EXISTS', `expected APPLICATION_EXISTS, got ${dupBody.code}`);

    const resumeMailAfter = await withDb((conn) =>
      conn
        .execute("SELECT COUNT(*) AS c FROM mail_log WHERE entity_type = 'applications' AND entity_id = ? AND template_key = 'application_resume'", [
          applicant.id,
        ])
        .then(([r]) => Number(r[0].c)),
    );
    assert(
      resumeMailAfter === resumeMailBefore + 1,
      `expected one new application_resume mail_log row for the existing application, got ${resumeMailAfter - resumeMailBefore}`,
    );
  } finally {
    await deleteApplication(applicant.id);
  }
});

// ---------------------------------------------------------------------------
// Full review loop — create, upload the 3 required docs, submit; admin
// rejects one document, the portal's actionNeeded reflects it; re-upload;
// admin accepts; admin drives status through interview; applicant books a
// slot; admin accepts → the portal timeline reads as complete and mail_log
// carries the expected trail. The application's name is Arabic on purpose,
// so this case doubles as the CSV/UTF-8/Arabic-decoding check (admin
// applications export.csv) without spending a second `POST applications`
// call against its 5/hour/IP throttle.

test('full review loop: apply → 3 docs → submit → reject/re-upload/accept a document → interview → book → accept; CSV export decodes Arabic', async () => {
  const applicant = await createApplication({ firstName: 'أحمد', middleName: 'بن', lastName: 'المطيري' });
  let slotId;
  try {
    // --- CSV export: UTF-8 BOM + correct Arabic decoding -----------------
    const csvRes = await fetch(`${BASE}/admin/applications/export.csv?q=${encodeURIComponent(applicant.reference)}`, {
      headers: { Cookie: admin.cookie },
    });
    assert(csvRes.status === 200, `export.csv failed: ${csvRes.status}`);
    const csvBytes = Buffer.from(await csvRes.arrayBuffer());
    assert(csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, 'export.csv must start with a UTF-8 BOM (EF BB BF)');
    const csvText = csvBytes.toString('utf8');
    assert(csvText.includes(applicant.reference), 'export.csv (filtered by ?q=reference) did not include the expected row');
    assert(csvText.includes('أحمد') && csvText.includes('المطيري'), 'export.csv did not decode the Arabic name correctly');

    // --- Autosave (PATCH), then the 3 required documents -----------------
    const autosave = await api('PATCH', '/portal/application', {
      body: { university: 'جامعة الملك سعود', major: 'هندسة الحاسب' },
      session: applicant,
    });
    assert(autosave.status === 200, `autosave PATCH failed: ${autosave.status}: ${JSON.stringify(autosave.body)}`);

    for (const docType of ['id_copy', 'certificate', 'admission_letter']) {
      const up = await uploadApplicationDocument(applicant, docType, `review-${docType}`);
      assert(up.status === 201, `uploading ${docType} failed: ${up.status}: ${JSON.stringify(up.body)}`);
    }

    // --- Submit ------------------------------------------------------------
    const submitBody = {
      firstName: applicant.firstName,
      middleName: 'بن',
      lastName: applicant.lastName,
      birthDate: '2000-01-01',
      phone: `+9665${String(Date.now()).slice(-8)}`,
      nationality: 'SA',
      email: applicant.email,
      gender: 'male',
      university: 'جامعة الملك سعود',
      major: 'هندسة الحاسب',
      degreeLevel: 'bachelor',
      consent: true,
    };
    const submitted = await api('POST', '/portal/application/submit', { body: submitBody, session: applicant });
    assert(submitted.status === 200 || submitted.status === 201, `submit failed: ${submitted.status}: ${JSON.stringify(submitted.body)}`);
    assert(submitted.body.status === 'new', `expected status 'new' after submit, got ${submitted.body.status}`);

    // --- Admin: under_review, then reject one document --------------------
    const toUnderReview = await api('PATCH', `/admin/applications/${applicant.id}`, { body: { status: 'under_review' } });
    assert(toUnderReview.status === 200, `status → under_review failed: ${toUnderReview.status}: ${JSON.stringify(toUnderReview.body)}`);

    const detail1 = await api('GET', `/admin/applications/${applicant.id}`);
    const idCopyDoc = detail1.body.documents.find((d) => d.docType === 'id_copy');
    assert(idCopyDoc, 'id_copy document not found on the application detail');

    const rejected = await api('PATCH', `/admin/applications/${applicant.id}/documents/${idCopyDoc.id}`, {
      body: { status: 'rejected', reason: 'Scan is unreadable — please re-upload a clearer copy.' },
    });
    assert(rejected.status === 200, `document rejection failed: ${rejected.status}: ${JSON.stringify(rejected.body)}`);

    const meAfterReject = await api('GET', '/portal/me', { session: applicant });
    assert(meAfterReject.body.actionNeeded?.type === 'document_rejected', `expected actionNeeded.type 'document_rejected', got ${JSON.stringify(meAfterReject.body.actionNeeded)}`);
    assert(meAfterReject.body.actionNeeded.docType === 'id_copy', `expected the rejected docType to be id_copy, got ${meAfterReject.body.actionNeeded.docType}`);

    // --- B3 (safeer-backend-fr-review.md): rejecting a document does NOT
    // itself unlock re-upload — the application is still 'under_review',
    // and upload() only allows 'draft' or 'docs_missing'. A re-upload
    // attempt here must be refused.
    const blockedReupload = await uploadApplicationDocument(applicant, 'id_copy', 'review-id-copy-blocked');
    assert(blockedReupload.status === 409, `re-upload while still under_review should be 409 APPLICATION_LOCKED, got ${blockedReupload.status}`);
    assert(blockedReupload.body?.code === 'APPLICATION_LOCKED', `expected APPLICATION_LOCKED, got ${blockedReupload.body?.code}`);

    // Staff explicitly asks for the rejected document — this is what
    // actually unlocks re-upload (docs_missing, id_copy requested/rejected).
    const requestDocs = await api('POST', `/admin/applications/${applicant.id}/request-documents`, {
      body: { docTypes: ['id_copy'], message: 'Please re-upload a clearer copy of your ID.' },
    });
    assert(requestDocs.status === 200 || requestDocs.status === 201, `request-documents failed: ${requestDocs.status}: ${JSON.stringify(requestDocs.body)}`);

    // A type that was neither requested nor currently rejected is still refused.
    const wrongTypeReupload = await uploadApplicationDocument(applicant, 'certificate', 'review-cert-blocked');
    assert(wrongTypeReupload.status === 409, `re-uploading a type that wasn't requested/rejected should be 409, got ${wrongTypeReupload.status}`);
    assert(wrongTypeReupload.body?.code === 'APPLICATION_LOCKED', `expected APPLICATION_LOCKED, got ${wrongTypeReupload.body?.code}`);

    // --- Re-upload (now allowed) and accept ---------------------------------
    const reupload = await uploadApplicationDocument(applicant, 'id_copy', 'review-id-copy-2');
    assert(reupload.status === 201, `re-upload failed: ${reupload.status}: ${JSON.stringify(reupload.body)}`);

    const detail2 = await api('GET', `/admin/applications/${applicant.id}`);
    const newIdCopyDoc = detail2.body.documents.find((d) => d.docType === 'id_copy');
    assert(newIdCopyDoc && newIdCopyDoc.id !== idCopyDoc.id, 're-upload should supersede the rejected document with a new row');
    assert(
      detail2.body.events.some((e) => e.type === 'DOCS_RESUBMITTED'),
      'expected a DOCS_RESUBMITTED event once the only requested/rejected type (id_copy) had a fresh replacement',
    );
    const listAfterResubmit = await api('GET', '/admin/applications?q=' + encodeURIComponent(applicant.reference));
    const listItem = listAfterResubmit.body.data.find((r) => r.id === applicant.id);
    assert(listItem?.hasUnreviewedResubmission === true, 'the admin list should badge this application as having an unreviewed resubmission');

    const accepted = await api('PATCH', `/admin/applications/${applicant.id}/documents/${newIdCopyDoc.id}`, { body: { status: 'accepted' } });
    assert(accepted.status === 200, `document acceptance failed: ${accepted.status}: ${JSON.stringify(accepted.body)}`);

    const meAfterAccept = await api('GET', '/portal/me', { session: applicant });
    assert(meAfterAccept.body.actionNeeded === null, `actionNeeded should clear once the rejected document is replaced and accepted, got ${JSON.stringify(meAfterAccept.body.actionNeeded)}`);

    // Back to under_review (docs_missing's only outgoing edge) — request-documents
    // itself only accepts 'new'/'under_review'/'interview' as a starting point.
    const backToReview = await api('PATCH', `/admin/applications/${applicant.id}`, { body: { status: 'under_review' } });
    assert(backToReview.status === 200, `status docs_missing → under_review failed: ${backToReview.status}: ${JSON.stringify(backToReview.body)}`);

    // B3: an accepted document can never be superseded, even by a caseworker
    // re-requesting the same type — request-documents lets it through (a
    // caseworker's own mistake), but upload() itself refuses it.
    const requestAcceptedAgain = await api('POST', `/admin/applications/${applicant.id}/request-documents`, {
      body: { docTypes: ['id_copy'] },
    });
    assert(requestAcceptedAgain.status === 200 || requestAcceptedAgain.status === 201, `request-documents (re-request) failed: ${requestAcceptedAgain.status}`);
    const blockedAcceptedReupload = await uploadApplicationDocument(applicant, 'id_copy', 'review-id-copy-blocked-2');
    assert(blockedAcceptedReupload.status === 409, `re-uploading an already-accepted document should be 409, got ${blockedAcceptedReupload.status}`);
    assert(blockedAcceptedReupload.body?.code === 'APPLICATION_LOCKED', `expected APPLICATION_LOCKED, got ${blockedAcceptedReupload.body?.code}`);

    // Back to under_review again before interview.
    const backToReview2 = await api('PATCH', `/admin/applications/${applicant.id}`, { body: { status: 'under_review' } });
    assert(backToReview2.status === 200, `status docs_missing → under_review failed: ${backToReview2.status}: ${JSON.stringify(backToReview2.body)}`);

    // --- interview → book → accept ------------------------------------------
    const toInterview = await api('PATCH', `/admin/applications/${applicant.id}`, { body: { status: 'interview' } });
    assert(toInterview.status === 200, `status → interview failed: ${toInterview.status}: ${JSON.stringify(toInterview.body)}`);

    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const endsAt = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    const slot = await api('POST', '/admin/interview-slots', { body: { startsAt, endsAt, locationAr: 'قاعة الاجتماعات — المقر الرئيسي' } });
    assert(slot.status === 201, `creating an interview slot failed: ${slot.status}: ${JSON.stringify(slot.body)}`);
    slotId = slot.body.id;

    const openSlots = await api('GET', '/portal/interview-slots', { session: applicant });
    assert(openSlots.status === 200 && openSlots.body.some((s) => s.id === slotId), 'the new slot should be listed as open for the applicant');

    const booked = await api('POST', '/portal/interview', { body: { slotId }, session: applicant });
    assert(booked.status === 200 || booked.status === 201, `booking failed: ${booked.status}: ${JSON.stringify(booked.body)}`);

    const toAccepted = await api('PATCH', `/admin/applications/${applicant.id}`, { body: { status: 'accepted' } });
    assert(toAccepted.status === 200, `status → accepted failed: ${toAccepted.status}: ${JSON.stringify(toAccepted.body)}`);

    // --- Portal timeline reads as complete -----------------------------------
    const meFinal = await api('GET', '/portal/me', { session: applicant });
    assert(meFinal.body.status === 'accepted', `expected final status 'accepted', got ${meFinal.body.status}`);
    for (const step of meFinal.body.timeline) {
      assert(step.state === 'done', `expected every timeline step to be 'done' once accepted, but "${step.key}" is "${step.state}"`);
    }

    // --- mail_log carries the expected trail ---------------------------------
    const mailRows = await withDb((conn) =>
      conn
        .execute("SELECT template_key FROM mail_log WHERE entity_type = 'applications' AND entity_id = ?", [applicant.id])
        .then(([rows]) => rows.map((r) => r.template_key)),
    );
    for (const expected of ['application_started', 'application_submitted', 'document_rejected']) {
      assert(mailRows.includes(expected), `expected a ${expected} mail_log row, found: ${mailRows.join(', ')}`);
    }
    const statusChangedCount = mailRows.filter((k) => k === 'application_status_changed').length;
    assert(statusChangedCount >= 3, `expected at least 3 application_status_changed mail_log rows (under_review, interview, accepted), found ${statusChangedCount}`);
  } finally {
    // Deleting the application first un-books the slot (interview_slots.application_id
    // is ON DELETE SET NULL — deleteApplication() already NULLs it defensively too),
    // which is what admin-interview-slots.controller.ts's own RESOURCE_IN_USE guard
    // requires before a booked slot can be removed at all.
    await deleteApplication(applicant.id);
    if (slotId) await withDb((conn) => conn.execute('DELETE FROM interview_slots WHERE id = ?', [slotId]));
  }
});

// ---------------------------------------------------------------------------
// Messages — contact-form honeypot silently no-ops with zero new rows; a
// real submission creates one; admin replies (confirm mail_log); admin
// converts a message to a testimonial (confirm it lands pending).

test('messages: honeypot no-ops, a real submission creates a message, admin replies and converts it to a testimonial', async () => {
  const countBefore = await withDb((conn) => conn.execute('SELECT COUNT(*) AS c FROM contact_messages').then(([r]) => Number(r[0].c)));

  const honeypot = await fetch(`${BASE}/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Bot',
      email: 'smoke-bot@example.com',
      subject: 'other',
      body: 'spam',
      website: 'http://spam.example', // the honeypot field — a real visitor never fills this
      formRenderedAt: Date.now() - 10_000,
    }),
  });
  assert(honeypot.status === 200 || honeypot.status === 201, `honeypot submit itself should still report success, got ${honeypot.status}`);
  const countAfterHoneypot = await withDb((conn) => conn.execute('SELECT COUNT(*) AS c FROM contact_messages').then(([r]) => Number(r[0].c)));
  assert(countAfterHoneypot === countBefore, `a honeypot-tripped submission must create zero rows, went from ${countBefore} to ${countAfterHoneypot}`);

  const email = `smoke-msg-${Date.now()}@example.com`;
  const real = await fetch(`${BASE}/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Smoke Sender',
      email,
      subject: 'feedback',
      body: 'Smoke test message — please ignore.',
      formRenderedAt: Date.now() - 5_000,
    }),
  });
  assert(real.status === 200 || real.status === 201, `real contact submission failed: ${real.status}`);

  const messageId = await withDb((conn) =>
    conn
      .execute('SELECT id FROM contact_messages WHERE email = ? ORDER BY id DESC LIMIT 1', [email])
      .then(([rows]) => rows[0]?.id && String(rows[0].id)),
  );
  assert(messageId, 'no contact_messages row found for the real submission');

  try {
    const reply = await api('POST', `/admin/messages/${messageId}/reply`, { body: { body: 'Thank you for reaching out — smoke test reply.' } });
    assert(reply.status === 200 || reply.status === 201, `reply failed: ${reply.status}: ${JSON.stringify(reply.body)}`);

    const replyMailRow = await withDb((conn) =>
      conn
        .execute("SELECT id FROM mail_log WHERE entity_type = 'contact_messages' AND entity_id = ? AND template_key = 'message_reply' ORDER BY id DESC LIMIT 1", [messageId])
        .then(([rows]) => rows[0]),
    );
    assert(replyMailRow, 'expected a message_reply mail_log row for this reply');

    const converted = await api('POST', `/admin/messages/${messageId}/convert-to-testimonial`, {
      body: { quoteAr: 'شهادة تجريبية من رسالة تواصل', authorName: 'Smoke Sender' },
    });
    assert(converted.status === 200 || converted.status === 201, `convert-to-testimonial failed: ${converted.status}: ${JSON.stringify(converted.body)}`);
    assert(converted.body.status === 'pending', `expected the converted testimonial to land 'pending', got ${converted.body.status}`);

    await api('DELETE', `/admin/testimonials/${converted.body.id}`);
  } finally {
    await api('DELETE', `/admin/messages/${messageId}`);
  }
});

// ---------------------------------------------------------------------------
// Content — reorder + hide a page_sections row via the admin API and
// confirm the public GET home reflects it immediately (the in-process LRU
// cache's purgeTag() runs synchronously inside the same request that writes
// the change — cache.service.ts/crud.factory.ts's purge() — so no delay is
// needed). Also bulk-delete legacy news and confirm exactly the seeded
// count is removed.

test('content: hiding/reordering a home page_section is reflected on GET home with no delay', async () => {
  const pagesRes = await api('GET', '/admin/pages?q=home&limit=50');
  const homePage = pagesRes.body.data.find((p) => p.slug === 'home');
  assert(homePage, 'could not find the "home" page via admin/pages');

  const sectionsRes = await api('GET', `/admin/page-sections?pageId=${homePage.id}&limit=50`);
  const sections = sectionsRes.body.data.filter((s) => s.isPublished);
  assert(sections.length > 0, 'expected at least one published section on the home page to run this case against');
  const target = sections[sections.length - 1];
  const originalSortOrder = target.sortOrder;

  try {
    const hidden = await api('PATCH', `/admin/page-sections/${target.id}/publish`, { body: { isPublished: false } });
    assert(hidden.status === 200 && hidden.body.isPublished === false, `hiding the section failed: ${hidden.status}`);

    const homeAfterHide = await fetch(`${BASE}/home`).then((r) => r.json());
    assert(!homeAfterHide.sections.some((s) => s.id === target.id), 'a hidden section still appears on GET home — cache purge did not take effect');

    const republished = await api('PATCH', `/admin/page-sections/${target.id}/publish`, { body: { isPublished: true } });
    assert(republished.status === 200 && republished.body.isPublished === true, `re-publishing the section failed: ${republished.status}`);

    const reordered = await api('POST', '/admin/page-sections/reorder', { body: [{ id: target.id, sortOrder: -1 }] });
    assert(reordered.status === 200 || reordered.status === 201, `reorder failed: ${reordered.status}`);

    const homeAfterReorder = await fetch(`${BASE}/home`).then((r) => r.json());
    assert(homeAfterReorder.sections[0]?.id === target.id, 'reordering to sortOrder -1 did not move the section to the front of GET home');
  } finally {
    await api('POST', '/admin/page-sections/reorder', { body: [{ id: target.id, sortOrder: originalSortOrder }] });
    await api('PATCH', `/admin/page-sections/${target.id}/publish`, { body: { isPublished: true } });
  }
});

test('content: DELETE admin/news/legacy removes exactly the legacy-flagged rows', async () => {
  const legacyCountBefore = await withDb((conn) => conn.execute('SELECT COUNT(*) AS c FROM posts WHERE is_legacy = 1').then(([r]) => Number(r[0].c)));

  const result = await api('DELETE', '/admin/news/legacy');
  assert(result.status === 200 || result.status === 201, `DELETE admin/news/legacy failed: ${result.status}`);
  assert(result.body.deleted === legacyCountBefore, `expected deleted: ${legacyCountBefore}, got ${JSON.stringify(result.body)}`);

  const legacyCountAfter = await withDb((conn) => conn.execute('SELECT COUNT(*) AS c FROM posts WHERE is_legacy = 1').then(([r]) => Number(r[0].c)));
  assert(legacyCountAfter === 0, `expected zero legacy posts remaining, found ${legacyCountAfter}`);

  // Calling it again (idempotent-ish re-run, e.g. during local iteration
  // without a fresh db:reset) must report 0, not error.
  const second = await api('DELETE', '/admin/news/legacy');
  assert(second.body.deleted === 0, `a second call with nothing legacy left should report deleted: 0, got ${JSON.stringify(second.body)}`);
});

// ---------------------------------------------------------------------------

async function main() {
  if (!EMAIL || !PASSWORD) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD must be set (see .env)');
  }
  admin = await loginAs(EMAIL, PASSWORD);

  let failed = 0;
  for (const { name, fn } of cases) {
    process.stdout.write(`${name} ... `);
    try {
      await fn();
      console.log('PASS');
    } catch (err) {
      failed++;
      console.log('FAIL');
      console.log(`    ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

await main();
