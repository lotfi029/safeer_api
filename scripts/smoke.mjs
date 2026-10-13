#!/usr/bin/env node
// scripts/smoke.mjs — end-to-end smoke suite for the Safeer API.
//
// Ported from `african_api`'s reference suite in phase 1 with only
// mechanical renames, so it spent phases 1-7 carrying ~200 lines of cases
// for domains this project never had (governance, library, channels,
// donations, products, languages, posts-as-a-different-shape, …) — deferred
// to this final phase per the project plan. This is a full rewrite against
// Safeer's actual routes: the content CMS, the governance register and
// licences, contact/newsletter and the messages inbox. (The scholarship
// apply flow, the OTP student portal, application review and SMS were
// removed with migration 021.) It keeps the reference suite's conventions
// (`test(name, fn)` / `assert(cond, msg)`, login as the bootstrap admin,
// `X-CSRF-Token` on writes, each case cleaning up its own rows, a `main()`
// that prints PASS/FAIL and exits 1 on any failure) and its habit of
// connecting directly to the database with mysql2 for setup/assertions an
// HTTP-only test can't otherwise reach (seeding a role-specific user,
// counting rows before/after).
//
// Usage:
//   npm run build && npm start                       (or start:dev) in one terminal
//   npm run smoke -- --confirm=<DB_NAME>             in another
//
// C8: it inserts and deletes rows directly in DB_NAME, so it refuses to run
// unless NODE_ENV is development/test and --confirm names that database
// (scripts/lib/dev-db-guard.mjs).
//
// Requires BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD in .env and a
// freshly migrated + seeded database (`npm run db:reset -- --confirm=<DB_NAME>`) — several cases
// (legacy-news bulk-delete, the permission matrix) assume the dev sample
// fixtures are exactly as `migrations/dev/003_dev_sample.sql` left them.

import 'dotenv/config';
import mysql from 'mysql2/promise';
import * as argon2 from 'argon2';
import { requireDevDbConfirmation } from './lib/dev-db-guard.mjs';
import { UTC_SESSION_SQL } from './lib/db-connection.mjs';

requireDevDbConfirmation('smoke');

const PORT = process.env.PORT ?? '3900';
const BASE = `http://localhost:${PORT}/api/v1`;
const HEALTH_URL = `http://localhost:${PORT}/health`;
const FILES_BASE = `http://localhost:${PORT}/files`;
const EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL;
const PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const STAFF_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'sf_sid';

// A minimal but genuinely valid PDF — real magic bytes, so `file-type`
// classifies it as `application/pdf` the same way a real upload would (the
// same shape phase 7's own smoke case for meeting-style attachments used).
// Used for the licence document in the governance case.
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
 * setup/assertions an HTTP-only test can't reach: seeding a role-specific
 * staff user, counting rows before/after a honeypot submission.
 */
async function withDb(fn) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z', // C9: same clock as the app (src/database/utc.ts)
  });
  await conn.query(UTC_SESSION_SQL);
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
      "INSERT INTO users (name, email, password_hash, role, status, failed_logins) VALUES (?, ?, ?, ?, 'active', 0)",
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

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Permission matrix — editor owns content but not the inbox or settings;
// support owns the inbox but not content; only admin sees the audit feed.

test('permissions: editor is refused admin/messages and admin/settings, support is refused admin/news and admin/licences', async () => {
  const editor = await createTempUser('editor');
  const support = await createTempUser('support');
  try {
    for (const path of ['/admin/messages', '/admin/settings']) {
      const res = await api('GET', path, { session: editor });
      assert(res.status === 403, `editor should be refused ${path}, got ${res.status}`);
      assert(res.body?.code === 'FORBIDDEN', `expected FORBIDDEN, got ${res.body?.code}`);
    }
    for (const path of ['/admin/news', '/admin/licences', '/admin/redirects', '/admin/media']) {
      const res = await api('GET', path, { session: support });
      assert(res.status === 403, `support should be refused ${path}, got ${res.status}`);
    }

    // Sanity: each role IS allowed into its own area, so the 403s above are
    // really about the role, not a broken session.
    for (const path of ['/admin/news', '/admin/licences', '/admin/doc-categories', '/admin/redirects', '/admin/media']) {
      const res = await api('GET', path, { session: editor });
      assert(res.status === 200, `editor should be allowed into ${path}, got ${res.status}`);
    }
    const supportOwn = await api('GET', '/admin/messages', { session: support });
    assert(supportOwn.status === 200, `support should be allowed into admin/messages, got ${supportOwn.status}`);

    // The reviewer role is gone (021): an invite naming it is a 400.
    const reviewerInvite = await api('POST', '/admin/auth/invite', { body: { email: `smoke-reviewer-${Date.now()}@example.com`, name: 'Smoke Reviewer', role: 'reviewer' } });
    assert(reviewerInvite.status === 400, `inviting a reviewer should be 400, got ${reviewerInvite.status}`);

    // B6: recentAuditLog is admin-only; the overview carries no application blocks.
    const overviewAsAdmin = await api('GET', '/admin/overview');
    assert(
      Array.isArray(overviewAsAdmin.body.recentAuditLog) && overviewAsAdmin.body.recentAuditLog.length > 0,
      'admin should see a non-empty recentAuditLog',
    );
    assert(
      !('series' in overviewAsAdmin.body) && !('latestApplications' in overviewAsAdmin.body) && !('newApplications' in overviewAsAdmin.body.statCards),
      `the overview should carry no application blocks: ${JSON.stringify(Object.keys(overviewAsAdmin.body))}`,
    );
    const overviewAsSupport = await api('GET', '/admin/overview', { session: support });
    assert(
      Array.isArray(overviewAsSupport.body.recentAuditLog) && overviewAsSupport.body.recentAuditLog.length === 0,
      'support should see an empty recentAuditLog (B6)',
    );
  } finally {
    await deleteTempUser(editor.id);
    await deleteTempUser(support.id);
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
// CSRF — a staff write missing X-CSRF-Token must be refused. Guards run
// before body-validation pipes (Nest's request lifecycle), so an empty body
// is fine here — the request never reaches validation at all.

test('CSRF: a staff write without X-CSRF-Token is refused', async () => {
  const staffRes = await fetch(`${BASE}/admin/board`, {
    method: 'POST',
    headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert(staffRes.status === 403, `staff write without X-CSRF-Token should be refused, got ${staffRes.status}`);
  const staffBody = await staffRes.json();
  assert(staffBody.code === 'FORBIDDEN', `expected FORBIDDEN, got ${staffBody.code}`);
});

// ---------------------------------------------------------------------------
// Removed routes stay removed (021): the apply flow, the portal and SMS.

test('removed: applications, portal, interview slots and SMS routes are gone', async () => {
  for (const [method, path] of [
    ['POST', '/applications'],
    ['POST', '/portal/auth/request-otp'],
    ['GET', '/portal/me'],
  ]) {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert(res.status === 404, `${method} ${path} should be 404, got ${res.status}`);
  }
  for (const path of ['/admin/applications', '/admin/interview-slots', '/admin/sms/settings']) {
    const res = await api('GET', path);
    assert(res.status === 404, `GET ${path} should be 404, got ${res.status}`);
  }
  const scholarships = await fetch(`${BASE}/pages/scholarships`);
  assert(scholarships.status === 404, `the scholarships page should be gone, got ${scholarships.status}`);
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

test('B9: the seeded placeholder testimonial is pending/unfeatured; home section buttons use locale-agnostic paths, not #/ hash routes', async () => {
  const home = await fetch(`${BASE}/home`).then((r) => r.json());
  const buttonUrls = home.sections.flatMap((s) => [s.primaryButtonUrl, s.secondaryButtonUrl]).filter(Boolean);
  assert(buttonUrls.length > 0, 'expected at least one home section with a button URL to check');
  for (const url of buttonUrls) {
    assert(!url.startsWith('#'), `home section button URL should be a locale-agnostic path, not a hash route: ${url}`);
    assert(url.startsWith('/'), `home section button URL should start with '/': ${url}`);
  }

  const testimonials = await fetch(`${BASE}/testimonials`).then((r) => r.json());
  const allPublic = [...testimonials.featured, ...testimonials.list];
  assert(
    !allPublic.some((t) => t.quote?.includes('يُستكمل')),
    'the placeholder-text testimonial must not appear on the public site (should be status=pending)',
  );
});

test('B10-B15: pages sectionsCount, work-area-item publish toggle, board bio, sitemap-index, escaped news search', async () => {
  // B10: GET admin/pages returns sectionsCount (and updatedAt, already there).
  const pagesRes = await api('GET', '/admin/pages?limit=50');
  assert(pagesRes.status === 200, `admin/pages failed: ${pagesRes.status}`);
  const homePage = pagesRes.body.data.find((p) => p.slug === 'home');
  assert(homePage, 'could not find the "home" page via admin/pages');
  assert(typeof homePage.sectionsCount === 'number' && homePage.sectionsCount > 0, `expected home.sectionsCount > 0, got ${homePage.sectionsCount}`);
  assert(homePage.updatedAt, 'expected admin/pages rows to carry updatedAt');

  // B11: unpublishing a work-area item removes it from the public /work-areas list; publish restores it.
  const itemsRes = await api('GET', '/admin/work-area-items?limit=1');
  const item = itemsRes.body.data[0];
  assert(item, 'expected at least one seeded work-area item');
  try {
    const unpublish = await api('PATCH', `/admin/work-area-items/${item.id}/publish`, { body: { isPublished: false } });
    assert(unpublish.status === 200, `unpublish failed: ${unpublish.status}: ${JSON.stringify(unpublish.body)}`);
    const publicAfterUnpublish = await fetch(`${BASE}/work-areas`).then((r) => r.json());
    const idsAfterUnpublish = publicAfterUnpublish.flatMap((a) => a.items.map((i) => i.id));
    assert(!idsAfterUnpublish.includes(item.id), 'an unpublished work-area item (B11) should not appear on the public /work-areas list');
  } finally {
    const republish = await api('PATCH', `/admin/work-area-items/${item.id}/publish`, { body: { isPublished: true } });
    assert(republish.status === 200, `republish failed: ${republish.status}`);
  }

  // B12: board_members.bioAr/bioEn round-trip through the admin API and collapse to `bio` publicly.
  const boardRes = await api('GET', '/admin/board?limit=1');
  const member = boardRes.body.data[0];
  assert(member, 'expected at least one seeded board member');
  const bioText = 'سيرة تجريبية للاختبار الآلي';
  try {
    const setBio = await api('PATCH', `/admin/board/${member.id}`, { body: { bioAr: bioText } });
    assert(setBio.status === 200, `setting bioAr failed: ${setBio.status}: ${JSON.stringify(setBio.body)}`);
    const publicBoard = await fetch(`${BASE}/board`).then((r) => r.json());
    const publicMember = [...publicBoard.board, ...publicBoard.executive].find((m) => m.id === member.id);
    assert(publicMember?.bio === bioText, `expected the public board endpoint to expose the new bio, got ${JSON.stringify(publicMember?.bio)}`);
  } finally {
    await api('PATCH', `/admin/board/${member.id}`, { body: { bioAr: member.bioAr ?? null } });
  }

  // B13: a '%'/'_' in a news search term is treated literally, not as a SQL wildcard (no 500, no over-broad match).
  const wildcardSearch = await fetch(`${BASE}/news?q=${encodeURIComponent('%')}`).then((r) => r.json());
  assert(Array.isArray(wildcardSearch.data) && wildcardSearch.data.length === 0, `searching news for a literal '%' should match nothing, got ${wildcardSearch.data?.length}`);

  // B15: the sitemap index lists only published pages/posts, each with a slug and updatedAt.
  const sitemap = await fetch(`${BASE}/sitemap-index`).then((r) => r.json());
  assert(Array.isArray(sitemap.pages) && sitemap.pages.length > 0, 'expected at least one page in the sitemap index');
  assert(Array.isArray(sitemap.posts), 'expected sitemap.posts to be an array');
  assert(Array.isArray(sitemap.categories) && sitemap.categories.length > 0, 'expected at least one category in the sitemap index');
  for (const entry of sitemap.pages) {
    assert(typeof entry.slug === 'string' && entry.updatedAt, `malformed sitemap page entry: ${JSON.stringify(entry)}`);
  }
});

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

test('fix plan phases 4–6: role matrix, about items, unknown filters, readiness', async () => {
  // B17: the matrix RolesGuard enforces, readable by any staff member.
  const roles = await api('GET', '/admin/roles');
  assert(roles.status === 200 && roles.body.matrix?.content?.includes('editor'), `GET admin/roles: ${roles.status} ${JSON.stringify(roles.body)}`);
  const editor = await createTempUser('editor');
  try {
    const asEditor = await api('GET', '/admin/roles', { session: editor });
    assert(asEditor.status === 200, `an editor could not read admin/roles: ${asEditor.status}`);
  } finally {
    await deleteTempUser(editor.id);
  }

  // B18 + C26: grouped, published, rendered.
  const items = await fetch(`${BASE}/about-items?kind=vision,goal`).then((r) => r.json());
  assert(items.vision?.length === 1 && items.goal?.length >= 1, `GET about-items: ${JSON.stringify(items).slice(0, 200)}`);
  assert(String(items.vision[0].body ?? '').startsWith('<p>'), 'about-item bodies should be rendered HTML');
  const about = await fetch(`${BASE}/pages/about`).then((r) => r.json());
  assert(about.sections?.some((s) => s.sectionKey === 'governance'), 'the about page should carry its seeded sections (migration 014)');

  // C42: a made-up filter value is a 400, not a cached empty list.
  const bogus = await fetch(`${BASE}/news?category=smoke-${Date.now()}`);
  assert(bogus.status === 400, `an unknown news category should be 400, got ${bogus.status}`);

  // C30 / Phase 6: readiness includes the storage driver's own check.
  const ready = await fetch(`${BASE.replace(/\/api\/v1$/, '')}/health/ready`).then((r) => r.json());
  assert(ready.checks?.storage === 'up', `readiness: ${JSON.stringify(ready)}`);
});

// ---------------------------------------------------------------------------
// Governance (022): the sections list, one section, a contact subject, and
// a licence whose primary status reaches GET /site and whose file is public
// once published.

test('governance: sections with counts, a section by slug, contact subjects, licences written through to GET /site', async () => {
  const sections = await fetch(`${BASE}/documents/sections?lang=en`).then((r) => r.json());
  assert(Array.isArray(sections) && sections[0]?.slug === 'bylaws-policies', `GET documents/sections: ${JSON.stringify(sections).slice(0, 200)}`);
  assert(sections.every((s) => s.sectionGroup === 'governance' && typeof s.count === 'number'), 'every section should be governance and carry a count');
  const bylaws = await fetch(`${BASE}/documents/sections/bylaws-policies`).then((r) => r.json());
  assert(bylaws.category?.slug === 'bylaws-policies' && Array.isArray(bylaws.documents), `GET documents/sections/bylaws-policies: ${JSON.stringify(bylaws).slice(0, 200)}`);
  assert(bylaws.documents.length === sections[0].count, 'the section count should match its documents');
  const missing = await fetch(`${BASE}/documents/sections/smoke-${Date.now()}`);
  assert(missing.status === 404, `an unknown section should be 404, got ${missing.status}`);
  const nav = await fetch(`${BASE}/site`).then((r) => r.json());
  assert(nav.nav.some((n) => n.slug === 'governance') && !nav.nav.some((n) => n.slug === 'documents'), 'the nav should list governance, not documents');

  const enums = await fetch(`${BASE}/meta/enums?lang=en`).then((r) => r.json());
  assert(enums.contactSubject.map((o) => o.value).join(',') === 'inquiry,partnership,support,feedback,other', `contact subjects: ${JSON.stringify(enums.contactSubject)}`);
  const scholarship = await fetch(`${BASE}/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke Sender', email: `smoke-subject-${Date.now()}@example.com`, subject: 'scholarship', body: 'x', formRenderedAt: Date.now() - 5_000 }),
  });
  assert(scholarship.status === 400, `the scholarship subject should be refused, got ${scholarship.status}`);

  const form = new FormData();
  form.append('file', new Blob([tinyPdf('licence')], { type: 'application/pdf' }), 'smoke-licence.pdf');
  const upload = await fetch(`${BASE}/admin/media`, { method: 'POST', headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrfToken }, body: form });
  const asset = await upload.json();
  assert(upload.status === 201, `uploading the licence document failed: ${upload.status}`);
  let licenceId;
  try {
    const created = await api('POST', '/admin/licences', {
      body: { titleAr: 'ترخيص تجريبي', number: 'SMOKE-1', issuerAr: 'جهة تجريبية', assetId: asset.id, isPublished: false },
    });
    assert(created.status === 201, `creating a licence failed: ${created.status}: ${JSON.stringify(created.body)}`);
    licenceId = created.body.id;
    const hiddenFile = await fetch(`${FILES_BASE}/${asset.publicId}`);
    assert(hiddenFile.status === 404, `an unpublished licence's file should be 404 anonymously, got ${hiddenFile.status}`);

    assert((await api('PATCH', `/admin/licences/${licenceId}/publish`, { body: { isPublished: true } })).status === 200, 'publishing the licence failed');
    assert((await api('PATCH', `/admin/licences/${licenceId}/primary`)).status === 200, 'making the licence primary failed');
    const licences = await fetch(`${BASE}/licences`).then((r) => r.json());
    assert(licences[0]?.id === licenceId && licences[0].isPrimary === true, `GET licences should list the primary first: ${JSON.stringify(licences).slice(0, 200)}`);
    const site = await fetch(`${BASE}/site`).then((r) => r.json());
    assert(site.settings.licenceNo === 'SMOKE-1' && site.settings.licenceIssuer === 'جهة تجريبية', `GET /site licence: ${JSON.stringify(site.settings)}`);
    const publicFile = await fetch(`${FILES_BASE}/${asset.publicId}`);
    assert(publicFile.status === 200, `a published licence's file should be public, got ${publicFile.status}`);
    const inUse = await api('DELETE', `/admin/media/${asset.id}`);
    assert(inUse.status === 409 && inUse.body.code === 'ASSET_IN_USE', `deleting a licence's file should be 409 ASSET_IN_USE, got ${inUse.status}`);
  } finally {
    if (licenceId) await api('DELETE', `/admin/licences/${licenceId}`);
    await api('DELETE', `/admin/media/${asset.id}`);
  }
  const cleared = await fetch(`${BASE}/site`).then((r) => r.json());
  assert(cleared.settings.licenceNo === null, 'deleting the primary licence should clear GET /site licenceNo');
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
