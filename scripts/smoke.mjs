#!/usr/bin/env node
// scripts/smoke.mjs — grows one case per completion-plan fix (18-completion-plan.md),
// instead of being written from scratch at the end. Each case hits the running
// API over HTTP as an authenticated admin and asserts one documented
// behaviour. Not a full test suite: no fixtures, no isolation between runs,
// created rows are deleted by each case itself on the way out.
//
// Usage:
//   npm run build && npm start   (or start:dev) in one terminal
//   node scripts/smoke.mjs       in another
//
// Requires BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD in .env and a
// migrated + seeded database.

import 'dotenv/config';
import { crc32 } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import mysql from 'mysql2/promise';

const PORT = process.env.PORT ?? '3900';
const BASE = `http://localhost:${PORT}/api/v1`;
const HEALTH_URL = `http://localhost:${PORT}/health`;
const EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL;
const PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD;

// A minimal, valid 1x1 transparent PNG — real magic bytes, so `file-type`
// classifies it as `image/png` the same way a real upload would.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/**
 * `MediaService.upload()` dedupes by checksum (trap 4) — re-uploading the
 * exact same bytes returns the *existing* asset, alt text and all. Every
 * case that needs a fresh, alt-less asset must upload genuinely unique
 * bytes, or it silently inherits state an earlier case already mutated.
 * Inserts a spec-compliant `tEXt` chunk (correct length + CRC32) before
 * `IEND` so the PNG stays valid for both `file-type`'s magic-byte sniff and
 * sharp's real decode, just no longer byte-identical between calls.
 */
function uniquePng() {
  const type = Buffer.from('tEXt', 'ascii');
  const data = Buffer.from(`smoke:${Date.now()}:${Math.random()}`, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0);
  const chunk = Buffer.concat([length, type, data, crc]);
  const iendStart = TINY_PNG.length - 12; // IEND is always the trailing 4(length)+4(type)+0(data)+4(crc)
  return Buffer.concat([TINY_PNG.subarray(0, iendStart), chunk, TINY_PNG.subarray(iendStart)]);
}

// `admin` is the default session every existing case implicitly used before
// B0-4 needed a second, non-admin one — kept as a mutable object (not the
// old bare `let cookie`/`let csrfToken`) so `api()` can default its
// `session` parameter to it without every call site changing.
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

// /admin/auth/login carries its own @Throttle (5/min per IP, independent of
// AuthService's per-email limiter — see M1/5.2's comment). Across a full
// suite run, every real login-route hit shares that one budget: the initial
// admin login in main(), B0-6's pending-invitee attempt, M1/5.2's two raw
// logins around the reset, and (without this) two separate loginAs() calls
// for the same seeded editor in the 7.4/7.5 and B0-4 tests — six total,
// enough to 429 the last one on a fast run where the whole suite finishes
// inside one 60s window. The editor's credentials and role don't change
// between those two tests (both run before M1/5.2 resets that account), so
// caching the session here removes one of the six.
let cachedEditorSession;
async function editorSession() {
  cachedEditorSession ??= await loginAs('editor@safeer-sa.org', PASSWORD);
  return cachedEditorSession;
}

async function uploadTinyPng(session = admin) {
  const form = new FormData();
  form.append('file', new Blob([uniquePng()], { type: 'image/png' }), `smoke-${Date.now()}.png`);
  const res = await fetch(`${BASE}/admin/media`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken },
    body: form,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/**
 * 7.6: GET /admin/media is now genuinely paginated (max 100/page, NFR-12),
 * so a specific known asset is no longer guaranteed to be on the first
 * page once the library accumulates enough rows — this repo's dev
 * database alone has passed 200 from repeated test runs. No `GET /:id` on
 * media.controller.ts, so paging through is the correct way to look one up
 * (bounded at 20 pages / 2000 assets, well beyond anything a dev run
 * accumulates).
 */
async function findMediaById(id) {
  for (let page = 1; page <= 20; page++) {
    const res = await api('GET', `/admin/media?page=${page}&limit=100`);
    const found = res.body.data.find((a) => a.id === id);
    if (found) return found;
    if (res.body.data.length < 100) return null; // last page
  }
  return null;
}

/**
 * M1/5.2's lockout-then-reset flow needs a raw, single-use reset token
 * bound to a specific account, and the only way that token is ever handed
 * out is by email — there is no HTTP endpoint that returns one. Seeding
 * one directly mirrors exactly what `AuthService.forgotPassword()` does
 * internally (`INSERT INTO auth_tokens`, `hashToken()` is a bare SHA-256),
 * which is the standard way to test a token-delivery flow without a real
 * mailbox. Every other smoke case in this file is HTTP-only by design;
 * this is the one exception, scoped to setup, not to performing the reset
 * itself (still a real `POST /admin/auth/reset/:token` over HTTP).
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

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A flat-color PNG at the given dimensions, heavily compressed so the file
 * size stays tiny regardless of pixel count — this is exactly
 * 26-backend-code-review.md H4's "a 2 MB PNG at 16000x16000px" shape (a
 * small file that decodes to an enormous pixel buffer), generated on the
 * fly instead of checking in a multi-hundred-KB fixture.
 */
async function hugePng(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } } })
    .png({ compressionLevel: 9, effort: 10 })
    .toBuffer();
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// C1

test('I-1: alt-text gate blocks an attach with no altAr, allows it once set', async () => {
  const asset = await uploadTinyPng();

  const blocked = await api('POST', '/admin/channels', {
    body: { type: 'phone', labelAr: `smoke ${Date.now()}`, iconAssetId: asset.id },
  });
  assert(blocked.status === 409, `expected 409, got ${blocked.status}: ${JSON.stringify(blocked.body)}`);
  assert(blocked.body?.code === 'ALT_TEXT_REQUIRED', `expected ALT_TEXT_REQUIRED, got ${blocked.body?.code}`);

  const altSet = await api('PATCH', `/admin/media/${asset.id}`, { body: { altAr: 'نص بديل تجريبي' } });
  assert(altSet.status === 200, `setAltText failed: ${altSet.status}`);

  const allowed = await api('POST', '/admin/channels', {
    body: { type: 'phone', labelAr: `smoke ${Date.now()}`, iconAssetId: asset.id },
  });
  assert(allowed.status === 201, `expected 201 once alt text is set, got ${allowed.status}: ${JSON.stringify(allowed.body)}`);

  await api('DELETE', `/admin/channels/${allowed.body.id}`);
});

test('I-1: the meeting_attachments bypass controller enforces the same gate', async () => {
  const meetings = await api('GET', '/admin/meetings?limit=1');
  if (!meetings.body?.data?.length) {
    console.log('    (skipped — no meetings in the seed to attach to)');
    return;
  }
  const meetingId = meetings.body.data[0].id;
  const asset = await uploadTinyPng();

  const blocked = await api('POST', `/admin/meetings/${meetingId}/attachments`, { body: { assetId: asset.id } });
  assert(blocked.status === 409, `expected 409, got ${blocked.status}: ${JSON.stringify(blocked.body)}`);
  assert(blocked.body?.code === 'ALT_TEXT_REQUIRED', `expected ALT_TEXT_REQUIRED, got ${blocked.body?.code}`);
});

test('H4: an image over the pixel budget is refused with a typed 422, not a crash', async () => {
  // 12000x12000 = 144 MP, well over image-pipeline.ts's 50 MP
  // limitInputPixels, but a tiny file — the process must reject this fast
  // and stay alive, not decode ~1.7 GB of RGBA and OOM.
  const buffer = await hugePng(12000, 12000);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/png' }), `huge-${Date.now()}.png`);
  const res = await fetch(`${BASE}/admin/media`, {
    method: 'POST',
    headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrfToken },
    body: form,
  });
  const body = await res.json();
  assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(body)}`);
  assert(body.code === 'VALIDATION_FAILED', `expected VALIDATION_FAILED, got ${body.code}`);

  const health = await fetch(HEALTH_URL);
  assert(health.status === 200, `process did not survive the rejected upload: ${health.status}`);
});

test('H4: an image within the pixel budget but exceeding the SMALLINT dimension column is also a typed 422', async () => {
  // 70000x700 = 49 MP (under the pixel budget) but 70000px wide — over
  // media_assets.width_px's SMALLINT UNSIGNED range (max 65535).
  const buffer = await hugePng(70000, 700);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/png' }), `thin-${Date.now()}.png`);
  const res = await fetch(`${BASE}/admin/media`, {
    method: 'POST',
    headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrfToken },
    body: form,
  });
  const body = await res.json();
  assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(body)}`);
});

test('I-4: an update that would invalidate a published row is refused', async () => {
  const asset = await uploadTinyPng();
  await api('PATCH', `/admin/media/${asset.id}`, { body: { altAr: 'غلاف تجريبي' } });

  const created = await api('POST', '/admin/library', {
    body: { type: 'image', titleAr: `عنصر تجريبي ${Date.now()}`, languageCode: 'ar', coverAssetId: asset.id },
  });
  assert(created.status === 201, `create failed: ${created.status}: ${JSON.stringify(created.body)}`);
  const id = created.body.id;

  const published = await api('PATCH', `/admin/library/${id}/publish`, { body: { isPublished: true } });
  assert(published.status === 200 && published.body.isPublished === true, 'publish failed');

  const invalidated = await api('PATCH', `/admin/library/${id}`, { body: { coverAssetId: null } });
  assert(invalidated.status === 409, `expected 409, got ${invalidated.status}: ${JSON.stringify(invalidated.body)}`);
  assert(invalidated.body?.code === 'PUBLISH_BLOCKED', `expected PUBLISH_BLOCKED, got ${invalidated.body?.code}`);

  const stillPublished = await api('GET', `/admin/library/${id}`);
  assert(stillPublished.body.isPublished === true, 'row must remain published after a rejected update');

  await api('DELETE', `/admin/library/${id}`);
});

test('I-3: a mail delivery failure does not take the process down', async () => {
  const before = await api('GET', '/admin/mail/settings');
  await api('PUT', '/admin/mail/settings', {
    body: { isEnabled: true, driver: 'smtp', host: '127.0.0.1', port: 1, encryption: 'none' },
  });
  try {
    const res = await fetch('http://localhost:' + PORT + '/api/v1/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Smoke Test',
        email: 'smoke@example.com',
        message: 'smoke test — please ignore',
        formRenderedAt: Date.now() - 5000,
      }),
    });
    assert(res.status === 201 || res.status === 200, `contact submit itself failed: ${res.status}`);
    // give attemptDelivery's fire-and-forget call a moment to run and fail
    await new Promise((r) => setTimeout(r, 800));
    const health = await fetch(HEALTH_URL);
    assert(health.status === 200, `server did not stay up: /health returned ${health.status}`);
  } finally {
    await api('PUT', '/admin/mail/settings', {
      body: {
        isEnabled: before.body.isEnabled,
        driver: before.body.driver,
        host: before.body.host,
        port: before.body.port,
        encryption: before.body.encryption,
      },
    });
  }
});

test('I-6: mail_log.payload is cleared once a delivery reaches a terminal state', async () => {
  // The seeded mail_settings row is disabled by default (12-database.md §4)
  // — send() marks a disabled-mail message 'skipped' without ever touching
  // `payload`, so this needs mail enabled first to actually exercise the
  // queued -> attemptDelivery -> terminal path I-6 is about. Deliberately
  // *not* setting host/port: MailTransportService.build() returns a null
  // transporter whenever they're unset, which attemptDelivery treats as
  // forceTerminal=true immediately — deterministic, no retry-backoff wait
  // needed (a reachable-but-refused host like 127.0.0.1:1 fails but isn't
  // terminal until MAX_ATTEMPTS, which is a 1+5+15 minute window — too slow
  // for a smoke case to wait out).
  const before = await api('GET', '/admin/mail/settings');
  await api('PUT', '/admin/mail/settings', { body: { isEnabled: true, driver: 'smtp' } });
  try {
    const email = `smoke-i6-${Date.now()}@example.com`;
    const res = await fetch('http://localhost:' + PORT + '/api/v1/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Smoke Test I-6',
        email,
        message: 'smoke test — please ignore',
        formRenderedAt: Date.now() - 5000,
      }),
    });
    assert(res.status === 200 || res.status === 201, `contact submit failed: ${res.status}`);

    await new Promise((r) => setTimeout(r, 800));
    const log = await api('GET', '/admin/mail/log?template=contact_ack&limit=20');
    assert(log.status === 200, `mail log fetch failed: ${log.status}`);
    const row = log.body.data.find((r) => r.toEmail === email);
    assert(row, 'no mail_log row found for this submission — did the request even reach ContactService.submit?');
    assert(row.status === 'sent' || row.status === 'failed', `expected a terminal status, got ${row.status}`);
    // H3: the API no longer returns `payload` at all (it could contain a
    // live reset/invite link) — `hasPayload` is the projection's stand-in,
    // and it must still reflect the same nulled-at-terminal-state fact.
    assert('payload' in row === false, `expected "payload" to be absent from the API response entirely, got ${JSON.stringify(row)}`);
    assert(row.hasPayload === false, `expected hasPayload to be false once terminal, got ${JSON.stringify(row.hasPayload)}`);
  } finally {
    await api('PUT', '/admin/mail/settings', {
      body: {
        isEnabled: before.body.isEnabled,
        driver: before.body.driver,
        host: before.body.host,
        port: before.body.port,
        encryption: before.body.encryption,
      },
    });
  }
});

test('B1-4: an unrecognised library link is refused at save, not saved as a silent draft', async () => {
  // No network needed — matchProviderUrl() rejects this purely on shape,
  // before resolveProvider() would ever attempt an oEmbed call.
  const created = await api('POST', '/admin/library', {
    body: {
      type: 'video',
      titleAr: `فيديو تجريبي ${Date.now()}`,
      languageCode: 'ar',
      sourceUrl: 'https://example.com/not-a-supported-provider',
    },
  });
  assert(created.status === 422, `expected 422, got ${created.status}: ${JSON.stringify(created.body)}`);
  assert(created.body?.code === 'UNSUPPORTED_PROVIDER', `expected UNSUPPORTED_PROVIDER, got ${created.body?.code}`);

  // The preview endpoint must throw the identical thing — that consistency
  // is the whole point of B1-4.
  const previewed = await api('POST', '/admin/library/resolve', { body: { url: 'https://example.com/not-a-supported-provider' } });
  assert(previewed.status === created.status && previewed.body?.code === created.body?.code,
    `resolve() and create() disagree on an unsupported link: ${previewed.status}/${previewed.body?.code} vs ${created.status}/${created.body?.code}`);
});

test('I-2/I-5: a resolved library item never gets a null-alt cover (best-effort, needs network)', async () => {
  const resolved = await api('POST', '/admin/library/resolve', {
    body: { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' }, // Blender's "Big Buck Bunny" trailer — public, stable
  });
  if (resolved.status !== 201 && resolved.status !== 200) {
    console.log(`    (skipped — resolver call failed, likely no network in this environment: ${resolved.status})`);
    return;
  }
  const created = await api('POST', '/admin/library', {
    body: {
      type: 'video',
      titleAr: `فيديو تجريبي ${Date.now()}`,
      languageCode: 'ar',
      sourceUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    },
  });
  assert(created.status === 201, `create failed: ${created.status}: ${JSON.stringify(created.body)}`);
  try {
    if (!created.body.coverAssetId) {
      console.log('    (skipped — resolver did not return artwork this time)');
      return;
    }
    const cover = await findMediaById(created.body.coverAssetId);
    assert(cover, 'resolved cover asset not found in media list');
    assert(cover.altAr, 'resolved cover asset has a null altAr — I-2 regressed');
  } finally {
    await api('DELETE', `/admin/library/${created.body.id}`);
  }
});

// ---------------------------------------------------------------------------
// Task 1 (26-backend-code-review.md / 28-caching-review.md) — the library
// public cache tag mismatch: writes purged `library_items` (the table
// name) and `home`, but the public routes are stored under `'library'`, so
// nothing ever purged the tag the public site actually reads from. Fixed by
// adding 'library' to the collection's extraPurgeTags (library-items.
// controller.ts) plus a boot-time assertion (CacheTagAssertion) that makes
// this category of mistake unshippable. Uses an `image` item, not a
// provider link, so this needs no network call — `publishRules` only
// requires a coverAssetId for that type.

test('cache: publishing, reordering and unpublishing a library item is immediately visible on the public site', async () => {
  const asset = await uploadTinyPng();
  await api('PATCH', `/admin/media/${asset.id}`, { body: { altAr: 'غلاف تجريبي' } });

  const created = await api('POST', '/admin/library', {
    body: {
      type: 'image',
      titleAr: `صورة تجريبية ${Date.now()}`,
      languageCode: 'ar',
      coverAssetId: asset.id,
      isPublished: false,
    },
  });
  assert(created.status === 201, `create failed: ${created.status}: ${JSON.stringify(created.body)}`);
  const id = created.body.id;

  try {
    // publish → must appear on the public list immediately, not after the TTL.
    const published = await api('PATCH', `/admin/library/${id}/publish`, { body: { isPublished: true } });
    assert(published.status === 200, `publish failed: ${published.status}: ${JSON.stringify(published.body)}`);

    const afterPublish = await fetch(`${BASE}/library/images`).then((r) => r.json());
    assert(
      afterPublish.data.some((i) => i.id === id),
      'a freshly published library item did not appear on GET /library/images — the "library" cache tag is not being purged',
    );

    // reorder → the new order must be visible immediately.
    const reordered = await api('POST', '/admin/library/reorder', { body: [{ id, sortOrder: -1 }] });
    assert(reordered.status === 200 || reordered.status === 201, `reorder failed: ${reordered.status}`);
    const afterReorder = await fetch(`${BASE}/library/images`).then((r) => r.json());
    assert(
      afterReorder.data[0]?.id === id,
      'reordering to sortOrder -1 did not move the item to the front of the public list — reorder is not purging "library"',
    );

    // unpublish → the content-safety case: must disappear immediately, not
    // stay visible for up to CACHE_TTL_SECONDS * 10 behind a CDN.
    const unpublished = await api('PATCH', `/admin/library/${id}/publish`, { body: { isPublished: false } });
    assert(unpublished.status === 200, `unpublish failed: ${unpublished.status}`);
    const afterUnpublish = await fetch(`${BASE}/library/images`).then((r) => r.json());
    assert(
      !afterUnpublish.data.some((i) => i.id === id),
      'an unpublished library item is still visible on GET /library/images — this is the content-safety case Task 1 exists for',
    );
  } finally {
    await api('DELETE', `/admin/library/${id}`);
  }
});

// ---------------------------------------------------------------------------
// Task 2 (26-backend-code-review.md / 28-caching-review.md §3) — error
// responses on a cached route used to inherit the "public, max-age=..."
// header CacheInterceptor set unconditionally at the top of intercept(),
// before the handler had run. HttpExceptionFilter's response.status()...
// never cleared it, so a transient 500 (a MySQL blip during a deploy) would
// be cached by a CDN as fresh for the full TTL and served stale for up to
// 10x that afterwards. Fixed by moving the header writes into the only
// paths that are actually known-cacheable (a hit, and tap() on success),
// plus a route-independent `Cache-Control: no-store` in the exception
// filter for every response >=400.
//
// Correction to 26-backend-code-review.md H2/3.3: that finding assumes
// Express's `qs`-style query parser turns `?q[x]=y` into an object
// (`query.q = {x:'y'}`). Verified directly against this app (Express 5.2.1,
// no `app.set('query parser', 'extended')` anywhere in main.ts): Express 5's
// *default* query parser is `'simple'` (Node's built-in `querystring`), not
// `qs` — `qs` is present in package-lock.json only as some other package's
// transitive dependency. `querystring.parse('lang[a]=b')` produces the flat
// key `{'lang[a]': 'b'}`, not a nested object, and a live `?lang[a]=b` /
// `?q[x]=y` request against this app returns a normal 200. The underlying
// H2 severity claim was still correct, via a different, real mechanism:
// `querystring.parse` turns a *repeated* key into an array
// (`?q=a&q=b` → `{q:['a','b']}`), and `normalizeAr(['a','b'])` threw the
// same "s.toLowerCase is not a function" — and, more broadly than H2 named,
// the identical shape crashed `LocaleInterceptor.resolveLocale()` on a
// repeated `?lang=` key, which — being a global `APP_INTERCEPTOR` — was
// reachable from *every* route in the app, not only the ones H2 lists.
// Task 3.3's `readString()`/`asString()` guards (`typeof value === 'string'`)
// now cover every one of these call sites, including that global one, so
// `?q=a&q=b` and `?lang=a&lang=b` are both a plain 200 today — which means
// this Task 2 test can no longer use either as its forcing mechanism.

test('cache: an error response on a cached route is never served with a public Cache-Control', async () => {
  // An unknown library `:type` is a permanent, un-fixable-away 404
  // (ProblemException) on the same cached, @CacheTags('library') route —
  // unlike the query-parsing bugs above, there is no future fix that turns
  // this into a 200, so it is a stable forcing mechanism for this
  // assertion regardless of what else changes in this controller.
  const res = await fetch(`${BASE}/library/not-a-real-library-type`);
  assert(res.status === 404, `expected 404 for an unknown library type, got ${res.status}`);
  const cacheControl = res.headers.get('cache-control');
  assert(cacheControl === 'no-store', `error response on a cached route must be Cache-Control: no-store, got: ${cacheControl}`);

  // And the success path must still be genuinely cacheable — the fix must
  // not have accidentally suppressed the header on the happy path.
  const ok = await fetch(`${BASE}/library/videos`);
  assert(ok.status === 200, `sanity check failed: ${ok.status}`);
  const okCacheControl = ok.headers.get('cache-control');
  assert(okCacheControl?.includes('public') && okCacheControl?.includes('max-age'), `expected a public Cache-Control on success, got: ${okCacheControl}`);
});

// ---------------------------------------------------------------------------

test('H1/H2: an absurd page number and a non-string query value never 500 on either public list controller', async () => {
  // H1: a huge page must clamp to an empty page, not a multi-billion-row
  // OFFSET query against MySQL.
  for (const path of ['/library/videos', '/news']) {
    const res = await fetch(`${BASE}${path}?page=900000000&limit=48`);
    assert(res.status === 200, `${path}?page=900000000 must not error, got ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body.data) && body.data.length === 0, `${path}?page=900000000 must return an empty page, got ${JSON.stringify(body).slice(0, 200)}`);
  }

  // H2: bracket notation does NOT reproduce on this app (Express 5's
  // default 'simple' query parser, not qs — see the correction above) but
  // must still never 500 even if that assumption changes later.
  for (const suffix of ['q%5Bx%5D=y', 'lang%5Ba%5D=b']) {
    const res = await fetch(`${BASE}/library/videos?${suffix}`);
    assert(res.status < 500, `?${suffix} must not 500, got ${res.status}`);
  }

  // H2, the real mechanism: a repeated key becomes an array under
  // querystring.parse. Must never 500 on either public list controller,
  // and — the case that actually broke, since LocaleInterceptor is global —
  // must not 500 on completely unrelated routes either.
  for (const path of ['/library/videos?q=a&q=b', '/library/videos?lang=a&lang=b', '/news?page=a&page=b', '/home?lang=a&lang=b', '/languages?lang=a&lang=b']) {
    const res = await fetch(`${BASE}${path}`);
    assert(res.status < 500, `${path} must not 500, got ${res.status}`);
  }
});

// ---------------------------------------------------------------------------
// H5

test('H5: /files/:publicId is gated on the owning row\'s publish state', async () => {
  // A fresh, unpublished item this case owns (finding D in 29-backend-
  // fix-prompt.md's plan: the dev fixtures already contain 40 orphaned
  // assets referencing no row at all — never hardcode an asset id from
  // fixture data, since it may be one of those and prove nothing).
  const asset = await uploadTinyPng();
  await api('PATCH', `/admin/media/${asset.id}`, { body: { altAr: 'غلاف تجريبي H5' } });
  const created = await api('POST', '/admin/library', {
    body: {
      type: 'image',
      titleAr: `صورة H5 ${Date.now()}`,
      languageCode: 'ar',
      coverAssetId: asset.id,
      isPublished: false,
    },
  });
  assert(created.status === 201, `create failed: ${created.status}: ${JSON.stringify(created.body)}`);
  const itemId = created.body.id;

  // /files/* is deliberately excluded from the versioned /api/v1 prefix
  // (main.ts's setGlobalPrefix `exclude` list) — BASE must not be used here.
  const filesUrl = `http://localhost:${PORT}/files/${asset.publicId}`;

  try {
    // Anonymous, unpublished: 404, indistinguishable from a missing asset,
    // and never cached.
    let res = await fetch(filesUrl);
    assert(res.status === 404, `anonymous fetch of an unpublished asset must 404, got ${res.status}`);
    assert(res.headers.get('cache-control') === 'no-store', `a 404 here must be no-store, got: ${res.headers.get('cache-control')}`);

    // Signed-in (editor previewing their own draft): 200, but private/
    // no-store — must never be handed the year-long immutable header.
    res = await fetch(filesUrl, { headers: { Cookie: admin.cookie } });
    assert(res.status === 200, `signed-in fetch of an unpublished asset must succeed, got ${res.status}`);
    assert(res.headers.get('cache-control') === 'private, no-store', `expected private/no-store, got: ${res.headers.get('cache-control')}`);

    // Publish it — now anonymous access must succeed, with the normal
    // public/immutable header.
    const published = await api('PATCH', `/admin/library/${itemId}/publish`, { body: { isPublished: true } });
    assert(published.status === 200, `publish failed: ${published.status}`);
    res = await fetch(filesUrl);
    assert(res.status === 200, `anonymous fetch of a now-published asset must succeed, got ${res.status}`);
    assert(res.headers.get('cache-control') === 'public, max-age=31536000, immutable', `expected the public immutable header, got: ${res.headers.get('cache-control')}`);
  } finally {
    await api('DELETE', `/admin/library/${itemId}`);
  }
});

// ---------------------------------------------------------------------------
// Task 4 (unblock the frontend)

test('4.1/3a: ?itemLang= narrows the library list (incl. on a second cache-key request); ?lang= (the UI locale) must not', async () => {
  const unfiltered = await api('GET', '/library/videos');
  const languages = new Set(unfiltered.body.data.map((i) => i.languageCode));
  if (languages.size < 2) {
    console.log('    (skipped — seed data spans fewer than 2 languages for this type)');
    return;
  }
  const [lang] = languages;

  const first = await api('GET', `/library/videos?itemLang=${lang}`);
  assert(first.status === 200, `first itemLang request failed: ${first.status}`);
  assert(first.body.data.every((i) => i.languageCode === lang), `itemLang=${lang} did not narrow the list: ${JSON.stringify(first.body.data.map((i) => i.languageCode))}`);
  assert(first.body.total < unfiltered.body.total, 'itemLang filter did not reduce the total — is it being applied at all?');

  // Same query again — if the cache key doesn't include itemLang, this
  // would silently return whatever the *first* cached itemLang value was.
  const second = await api('GET', `/library/videos?itemLang=${lang}`);
  assert(second.body.data.every((i) => i.languageCode === lang), 'second request with the same itemLang returned a different (stale/wrong) list — the cache key is not keyed on itemLang');

  // 30-backend-finishing-prompt.md §2 task 3a: `?lang=` is the UI locale
  // (the frontend's HTTP interceptor appends it to *every* request) and
  // must never be read as this endpoint's content-language facet — the
  // fallback this replaces (`itemLang ?? lang`) silently facet-filtered
  // every library page by the visitor's UI locale. `en` is deliberately
  // not among this type's seeded languageCodes (ar/ha only), so the old
  // fallback would have narrowed this to an empty list; the fix must
  // return the same total as no filter at all.
  const viaUiLocale = await api('GET', '/library/videos?lang=en');
  assert(viaUiLocale.body.total === unfiltered.body.total, `?lang= (UI locale) must be ignored as a content filter, got total ${viaUiLocale.body.total} vs unfiltered ${unfiltered.body.total}`);
});

test('4.2: /home carries governance counts that match the database', async () => {
  const home = await api('GET', '/home');
  assert(home.status === 200, `GET /home failed: ${home.status}`);
  const gov = home.body.governance;
  assert(gov, 'GET /home is missing "governance"');
  for (const section of ['documents', 'members', 'meetings']) {
    assert(section in gov, `governance.${section} is missing`);
  }
  assert(typeof gov.documents.total === 'number', 'governance.documents.total must be a number');
  const sumByCategory = Object.values(gov.documents.byCategory).reduce((a, b) => a + b, 0);
  assert(sumByCategory === gov.documents.total, `governance.documents.total (${gov.documents.total}) must equal the sum of byCategory (${sumByCategory})`);
  for (const body of ['assembly', 'board']) {
    assert(typeof gov.members[body] === 'number', `governance.members.${body} must be a number`);
    assert(typeof gov.meetings[body] === 'number', `governance.meetings.${body} must be a number`);
  }
});

test('4.3: GET /redirects/resolve serves a legacy path and increments hits, with per-path cache isolation', async () => {
  const list = await api('GET', '/admin/redirects?limit=1');
  if (list.body.data.length < 1) {
    console.log('    (skipped — no seeded redirects to resolve against)');
    return;
  }
  const row = list.body.data[0];
  const hitsBefore = row.hits;

  const encodedPath = encodeURIComponent(row.fromPath);
  const resolved = await fetch(`${BASE}/redirects/resolve?path=${encodedPath}`);
  assert(resolved.status === 200, `resolve failed: ${resolved.status}`);
  const body = await resolved.json();
  assert(body.toPath === row.toPath, `expected toPath ${row.toPath}, got ${body.toPath}`);
  assert(body.statusCode === row.statusCode, `expected statusCode ${row.statusCode}, got ${body.statusCode}`);

  // Missing/unknown path — a typed 4xx, never a 500 or a silent match.
  const unknown = await fetch(`${BASE}/redirects/resolve?path=/this-path-does-not-exist-${Date.now()}`);
  assert(unknown.status === 404, `expected 404 for an unknown path, got ${unknown.status}`);
  const missingParam = await fetch(`${BASE}/redirects/resolve`);
  assert(missingParam.status === 400, `expected 400 with no path param, got ${missingParam.status}`);

  await new Promise((r) => setTimeout(r, 300)); // the hits increment is fire-and-forget
  const after = await api('GET', `/admin/redirects/${row.id}`);
  assert(after.body.hits === hitsBefore + 1, `expected hits to increment from ${hitsBefore} to ${hitsBefore + 1}, got ${after.body.hits}`);
});

// ---------------------------------------------------------------------------

test('7.1: FR-H-10 feature icons — a valid token round-trips through /home, an invalid one is rejected', async () => {
  const created = await api('POST', '/admin/about-items', {
    body: { kind: 'feature', icon: 'globe', titleAr: `ميزة تجريبية ${Date.now()}`, isPublished: true },
  });
  assert(created.status === 201, `create failed: ${created.status}: ${JSON.stringify(created.body)}`);
  const id = created.body.id;

  try {
    assert(created.body.icon === 'globe', `expected icon 'globe' on create, got ${created.body.icon}`);

    const invalid = await api('PATCH', `/admin/about-items/${id}`, { body: { icon: 'not-a-real-icon' } });
    assert(invalid.status === 400, `expected 400 for an unknown icon token, got ${invalid.status}`);

    const home = await api('GET', '/home');
    const feature = home.body.aboutItems.feature.find((f) => f.id === id);
    assert(feature, 'newly created published feature not found on /home');
    assert(feature.icon === 'globe', `expected /home to carry the icon, got ${JSON.stringify(feature.icon)}`);
  } finally {
    await api('DELETE', `/admin/about-items/${id}`);
  }
});

test('7.2: FR-V-02 hasMinutes reports whether a meeting has minutes attached, on the list and the detail route', async () => {
  const meetings = await api('GET', '/admin/meetings?limit=1');
  if (meetings.body.data.length < 1) {
    console.log('    (skipped — no seeded meetings to attach minutes to)');
    return;
  }
  const meeting = meetings.body.data[0];
  const originalMinutesAssetId = meeting.minutesAssetId ?? null;
  const bodies = await api('GET', '/admin/bodies');
  const body = bodies.body.data.find((b) => b.id === meeting.bodyId);
  assert(body, `could not find the governance body (${meeting.bodyId}) owning this meeting`);

  // A PDF, not an image: assertAltTextReady's ALT_TEXT_REQUIRED gate (crud.
  // factory.ts) only blocks kind='image' assets with no altAr — a real
  // minutes attachment is a PDF and is exempt, same as media.service.ts's
  // magic-byte check requires.
  const pdfBuffer = Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF smoke-7.2-${Date.now()}`);
  const form = new FormData();
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), `minutes-${Date.now()}.pdf`);
  const uploadRes = await fetch(`${BASE}/admin/media`, {
    method: 'POST',
    headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrfToken },
    body: form,
  });
  const asset = await uploadRes.json();
  assert(uploadRes.status === 201, `PDF upload failed: ${uploadRes.status}: ${JSON.stringify(asset)}`);

  try {
    const patched = await api('PATCH', `/admin/meetings/${meeting.id}`, { body: { minutesAssetId: asset.id } });
    assert(patched.status === 200, `attaching minutes failed: ${patched.status}: ${JSON.stringify(patched.body)}`);

    const list = await fetch(`${BASE}/governance/bodies/${body.slug}/meetings`).then((r) => r.json());
    const listRow = list.meetings.find((m) => m.id === meeting.id);
    assert(listRow, 'meeting not found on its own public list after attaching minutes');
    assert(listRow.hasMinutes === true, `expected hasMinutes: true on the list, got ${JSON.stringify(listRow.hasMinutes)}`);

    const detail = await fetch(`${BASE}/governance/meetings/${meeting.id}`).then((r) => r.json());
    assert(detail.meeting.hasMinutes === true, `expected hasMinutes: true on the detail route, got ${JSON.stringify(detail.meeting.hasMinutes)}`);
    assert(detail.meeting.minutesAsset !== null, 'detail route should also have a populated minutesAsset');
  } finally {
    // Detach before deleting — media.service.ts's remove() refuses
    // (ASSET_IN_USE) while any row still references it.
    await api('PATCH', `/admin/meetings/${meeting.id}`, { body: { minutesAssetId: originalMinutesAssetId } });
    await api('DELETE', `/admin/media/${asset.id}`);
    const restored = await fetch(`${BASE}/governance/bodies/${body.slug}/meetings`).then((r) => r.json());
    const restoredRow = restored.meetings.find((m) => m.id === meeting.id);
    assert(restoredRow?.hasMinutes === (originalMinutesAssetId !== null), 'hasMinutes did not revert to the original state after restoring minutesAssetId');
  }
});

test('7.4/7.5/NFR-09/task4: FR-E-04 notifyStatus (incl. notify_email unset with mail otherwise enabled), PDPL delete cascades to mail_log, and neither handle() nor remove() ever writes the submitter\'s name/email into audit_log', async () => {
  // Combined into one test, one /contact submission: contact.controller.ts
  // throttles the public endpoint to 3/hour/IP, and I-3 and I-6 already
  // spend two of those three on a single smoke run. A fourth call here
  // (this used to be two separate tests, 7.4 and 7.5) deterministically
  // 429s on every run, clean server or not — not a flaky timing issue, an
  // arithmetic one. One submission is enough to prove all of: it's
  // un-notified (7.4, and 30-backend-finishing-prompt.md §2.4's task 4 —
  // see below); PATCH .../handle and DELETE are both audited without ever
  // recording the name/email (the PDPL fix — handle() is the routine click
  // that runs on every submission, not just a deletion); DELETE is
  // admin-only (7.5); and the delete cascades to mail_log (NFR-09), so the
  // submitter's address doesn't outlive the row it came from by up to 90
  // more days.
  const before = await api('GET', '/admin/mail/settings');
  // task 4: mail *enabled* (not the pre-existing "mail globally disabled"
  // skip cause I-3/I-6 already exercise) but notify_email cleared — the
  // scenario contact.service.ts used to skip the contact_notify send
  // entirely for, writing no mail_log row at all, so notifyStatus read
  // `null`, indistinguishable from a message that predates mail logging.
  await api('PUT', '/admin/mail/settings', { body: { isEnabled: true, driver: before.body.driver, notifyEmail: null } });
  try {
    const fullName = 'Smoke Test 7.4 PDPL';
    const email = `smoke-74-${Date.now()}@example.com`;
    const res = await fetch(`${BASE}/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName, email, message: 'un-notified test', formRenderedAt: Date.now() - 5000 }),
    });
    assert(res.status === 200 || res.status === 201, `contact submit failed: ${res.status}`);

    await new Promise((r) => setTimeout(r, 300));
    const subs = await api('GET', '/admin/submissions?limit=20');
    const row = subs.body.data.find((s) => s.email === email);
    assert(row, 'submission not found in the admin list');
    assert(row.notifyStatus === 'skipped', `expected notifyStatus 'skipped' with notify_email unset, got ${JSON.stringify(row.notifyStatus)}`);

    // NFR-09 precondition: the /contact submission above left at least one
    // mail_log row for this message. Confirmed present now so its absence
    // after the delete below is actually evidence of the cascade, not just
    // of there never having been a row.
    const mailLogBefore = await api('GET', '/admin/mail/log?limit=200');
    const mailRowsBefore = mailLogBefore.body.data.filter((m) => m.entityType === 'contact_messages' && m.entityId === row.id);
    assert(mailRowsBefore.length > 0, 'expected at least one mail_log row for this submission before deletion');

    // task 4: the contact_notify row specifically must exist (not just
    // contact_ack) and carry an error naming the missing recipient — before
    // this fix, mail.service.ts's send() was never even called for
    // contact_notify when notifyEmail was unset, so this row would not
    // exist at all.
    const notifyRow = mailRowsBefore.find((m) => m.templateKey === 'contact_notify');
    assert(notifyRow, 'expected a contact_notify mail_log row even though notify_email is unset — send() must not be skipped by the caller');
    assert(notifyRow.status === 'skipped', `expected the contact_notify row to be 'skipped', got ${notifyRow.status}`);
    assert(notifyRow.error && notifyRow.error.length > 0, 'expected the skipped contact_notify row to carry an error naming the missing recipient');

    // PDPL: mark it handled first — the routine editorial click, and the
    // write most submissions actually go through (unlike the deletion
    // below). Must audit without the name.
    const handled = await api('PATCH', `/admin/submissions/${row.id}/handle`);
    assert(handled.status === 200, `handle failed: ${handled.status}: ${JSON.stringify(handled.body)}`);

    // 7.5: same row, editor is refused, admin succeeds and the deletion is audited.
    let editor;
    try {
      editor = await editorSession();
    } catch {
      editor = null;
    }
    if (editor) {
      const asEditor = await api('DELETE', `/admin/submissions/${row.id}`, { session: editor });
      assert(asEditor.status === 403, `editor deleted a submission (status ${asEditor.status}): ${JSON.stringify(asEditor.body)}`);
    } else {
      console.log('    (editor-role check skipped — no signed-in-able seeded editor)');
    }

    const asAdmin = await api('DELETE', `/admin/submissions/${row.id}`);
    assert(asAdmin.status === 200, `admin delete failed: ${asAdmin.status}: ${JSON.stringify(asAdmin.body)}`);
    assert(asAdmin.body?.deleted === true, `expected { deleted: true }, got ${JSON.stringify(asAdmin.body)}`);

    // NFR-09 cascade: the mail_log row(s) for this entity must be gone too,
    // not just the contact_messages row — otherwise the submitter's address
    // (and, while queued, the rendered name/email/phone/message in
    // `payload`) would sit in mail_log for up to 90 more days.
    const mailLogAfter = await api('GET', '/admin/mail/log?limit=200');
    const mailRowsAfter = mailLogAfter.body.data.filter((m) => m.entityType === 'contact_messages' && m.entityId === row.id);
    assert(mailRowsAfter.length === 0, `expected mail_log rows for this entity to be deleted alongside the message, found ${mailRowsAfter.length}`);

    // audit.interceptor.ts writes the row fire-and-forget (`.insert(...).catch(...)`,
    // never awaited into the response pipeline) — deliberately, so an
    // audit-log failure can never surface as the write's own failure. That
    // means the DELETE's response can reach us before the insert commits;
    // same reasoning as the 300ms wait after the /contact POST above.
    await new Promise((r) => setTimeout(r, 300));
    const audit = await api(`GET`, `/admin/audit?entity=contact_messages&limit=10`);
    const auditRows = audit.body.data.filter((a) => a.entityId === row.id);
    assert(auditRows.some((a) => a.action === 'delete'), 'no delete audit row found for the removed submission');
    assert(auditRows.some((a) => a.action === 'update'), 'no update audit row found for the handle() call');
    // PDPL: neither write (the routine handle(), or the deletion) may put
    // the submitter's name or email anywhere in audit_log — not in the
    // diff, and not in entityLabel, which held the full name before this
    // fix and is otherwise easy to overlook since JSON.stringify(diff)
    // alone wouldn't catch it.
    for (const a of auditRows) {
      const rowText = JSON.stringify(a);
      assert(!rowText.includes(email), `audit row (action=${a.action}) must not preserve the deleted message's email, found it in: ${rowText}`);
      assert(!rowText.includes(fullName), `audit row (action=${a.action}) must not preserve the submitter's name, found it in: ${rowText}`);
    }
  } finally {
    await api('PUT', '/admin/mail/settings', {
      body: {
        isEnabled: before.body.isEnabled,
        driver: before.body.driver,
        host: before.body.host,
        port: before.body.port,
        encryption: before.body.encryption,
        notifyEmail: before.body.notifyEmail,
      },
    });
  }
});

test('7.6: GET /admin/media and the public governance routes are paginated', async () => {
  const media = await api('GET', '/admin/media?page=1&limit=5');
  assert(media.status === 200, `GET /admin/media failed: ${media.status}`);
  for (const key of ['data', 'total', 'page', 'limit']) {
    assert(key in media.body, `/admin/media is missing "${key}" — expected the standard envelope`);
  }
  assert(media.body.data.length <= 5, `expected at most 5 rows for limit=5, got ${media.body.data.length}`);

  // Additive pagination on governance's existing {body,...}/{category,...}
  // shapes — the pre-existing keys must survive untouched (african_web
  // reads them directly) alongside the new total/page/limit.
  const members = await fetch(`${BASE}/governance/bodies/assembly/members?limit=2`).then((r) => r.json());
  assert('body' in members && 'members' in members, 'governance members response lost its existing body/members keys');
  for (const key of ['total', 'page', 'limit']) {
    assert(key in members, `governance members response is missing "${key}"`);
  }
  assert(members.members.length <= 2, `expected at most 2 rows for limit=2, got ${members.members.length}`);
});

test('7.7: FR-M-08 GET /admin/overview gives per-collection counts and a recent-changes feed, to editors too', async () => {
  const res = await api('GET', '/admin/overview');
  assert(res.status === 200, `GET /admin/overview failed: ${res.status}`);
  assert(Array.isArray(res.body.collections) && res.body.collections.length > 0, 'expected a non-empty collections array');
  const libraryItems = res.body.collections.find((c) => c.collection === 'library_items');
  assert(libraryItems, 'expected a library_items row in the collection counts');
  assert(typeof libraryItems.total === 'number' && typeof libraryItems.published === 'number', 'total/published must be numbers, not strings — dataSource.query() returns COUNT/SUM as strings');
  assert(libraryItems.published <= libraryItems.total, `published (${libraryItems.published}) cannot exceed total (${libraryItems.total})`);
  // redirects has no isPublished column — must not appear as a false 0/0 row.
  assert(!res.body.collections.some((c) => c.collection === 'redirects'), 'redirects has no publish concept and should be excluded, not shown as a fake published/total row');

  assert(Array.isArray(res.body.recentActivity) && res.body.recentActivity.length > 0, 'expected a non-empty recentActivity array');
  const entry = res.body.recentActivity[0];
  for (const key of ['entityType', 'action', 'entityLabel', 'createdAt']) {
    assert(key in entry, `recentActivity row is missing "${key}"`);
  }
  // B0-4: audit.controller.ts's actorId/ip_hash/diff are admin-only for a
  // reason (PII in a diff, who-did-what in actorId) — this dashboard route
  // must not leak them back out to every editor through a side door.
  for (const key of ['actorId', 'ipHash', 'diff']) {
    assert(!(key in entry), `recentActivity must not carry "${key}" — B0-4 restricts that to the admin-only audit log`);
  }

  let editor;
  try {
    editor = await editorSession();
  } catch {
    console.log('    (editor-role check skipped — no signed-in-able seeded editor)');
    return;
  }
  const asEditor = await api('GET', '/admin/overview', { session: editor });
  assert(asEditor.status === 200, `FR-M-08 says editors see this dashboard too, got ${asEditor.status}`);
});

test('7.8: FR-G-05 a preview token unlocks exactly the (collection,id) row it was minted for, and is never cached', async () => {
  const asset = await uploadTinyPng();
  await api('PATCH', `/admin/media/${asset.id}`, { body: { altAr: 'غلاف معاينة' } });

  const created = await api('POST', '/admin/library', {
    body: { type: 'image', titleAr: `عنصر معاينة ${Date.now()}`, languageCode: 'ar', coverAssetId: asset.id },
  });
  assert(created.status === 201, `create failed: ${created.status}: ${JSON.stringify(created.body)}`);
  assert(created.body.isPublished === false, 'a freshly created item must start unpublished for this test to prove anything');
  const { id, slug } = created.body;

  // A second, unrelated row — proves a token only unlocks the exact
  // (collection, id) it was minted for, not just "some valid token".
  const otherPost = await api('POST', '/admin/news', { body: { titleAr: `خبر آخر ${Date.now()}`, publishedOn: '2026-01-01' } });
  assert(otherPost.status === 201, `unrelated post create failed: ${otherPost.status}: ${JSON.stringify(otherPost.body)}`);

  try {
    const noToken = await fetch(`${BASE}/library/items/${slug}`);
    assert(noToken.status === 404, `unpublished item must 404 with no ?preview=, got ${noToken.status}`);

    const badCollection = await api('GET', `/admin/preview-token?collection=nonsense&id=${id}`);
    assert(badCollection.status === 400, `an unknown collection must be rejected at mint time, got ${badCollection.status}`);

    const wrongResource = await api('GET', `/admin/preview-token?collection=posts&id=${otherPost.body.id}`);
    assert(wrongResource.status === 200, `minting a token for a real, different row should succeed, got ${wrongResource.status}`);
    const wrongTokenRes = await fetch(`${BASE}/library/items/${slug}?preview=${wrongResource.body.token}`);
    assert(wrongTokenRes.status === 404, `a token minted for posts/${otherPost.body.id} must not unlock library_items/${id}, got ${wrongTokenRes.status}`);

    const garbage = await fetch(`${BASE}/library/items/${slug}?preview=garbage.garbage`);
    assert(garbage.status === 404, `a malformed token must not unlock preview, got ${garbage.status}`);

    const minted = await api('GET', `/admin/preview-token?collection=library_items&id=${id}`);
    assert(minted.status === 200, `mint failed: ${minted.status}: ${JSON.stringify(minted.body)}`);
    assert(typeof minted.body.token === 'string' && minted.body.token.length > 0, 'expected a non-empty token');

    const previewRes = await fetch(`${BASE}/library/items/${slug}?preview=${minted.body.token}`);
    assert(previewRes.status === 200, `a valid token must unlock the exact row it was minted for, got ${previewRes.status}`);
    assert(previewRes.headers.get('cache-control') === 'private, no-store', `a preview response must never be publicly cacheable, got: ${previewRes.headers.get('cache-control')}`);
    const previewBody = await previewRes.json();
    assert(previewBody.slug === slug, 'preview response is not the row the token was minted for');

    // The trap: a preview request must never poison the shared cache — the
    // very next anonymous request for the same slug, with no token, must
    // still 404, not silently start serving what the preview just saw.
    const stillHidden = await fetch(`${BASE}/library/items/${slug}`);
    assert(stillHidden.status === 404, `a plain request right after a preview must still 404 — the preview must not have been cached, got ${stillHidden.status}`);
  } finally {
    await api('DELETE', `/admin/library/${id}`);
    await api('DELETE', `/admin/news/${otherPost.body.id}`);
  }
});

// ---------------------------------------------------------------------------
// C4

test('C4: POST /reorder on a sortable collection works, PATCH /reorder no longer does', async () => {
  const list = await api('GET', '/admin/channels?limit=2');
  assert(list.status === 200, `list failed: ${list.status}`);
  if (list.body.data.length < 1) {
    console.log('    (skipped — no channels in the seed to reorder)');
    return;
  }
  const body = list.body.data.map((c, i) => ({ id: c.id, sortOrder: i }));
  const reordered = await api('POST', '/admin/channels/reorder', { body });
  assert(reordered.status === 200 || reordered.status === 201, `expected 200/201, got ${reordered.status}: ${JSON.stringify(reordered.body)}`);
  assert(reordered.body?.reordered === body.length, `expected reordered:${body.length}, got ${JSON.stringify(reordered.body)}`);

  // Proves the method split is what's doing the work, not an accident of
  // route order: PATCH now falls through to `update` with id='reorder'
  // instead of performing a reorder — a reorder array isn't a valid update
  // body, so the zod pipe rejects it with 400 before an id lookup even
  // happens (an authenticated request past that point would 404, per
  // findOrNotFound). Either way, it must not succeed as a reorder.
  const oldVerb = await api('PATCH', '/admin/channels/reorder', { body });
  assert(oldVerb.status !== 200 && oldVerb.status !== 201, `PATCH /reorder must not succeed as a reorder, got ${oldVerb.status}: ${JSON.stringify(oldVerb.body)}`);
  assert(oldVerb.body?.reordered === undefined, `PATCH /reorder must not report a reordered count, got ${JSON.stringify(oldVerb.body)}`);
});

// ---------------------------------------------------------------------------

test('B0-0: GET /news/:slug never exposes the author\'s credentials or asset storage internals', async () => {
  const asset = await uploadTinyPng();
  await api('PATCH', `/admin/media/${asset.id}`, { body: { altAr: 'غلاف تجريبي' } });

  const created = await api('POST', '/admin/news', {
    body: {
      titleAr: `خبر تجريبي ${Date.now()}`,
      publishedOn: '2026-01-01',
      coverAssetId: asset.id,
    },
  });
  assert(created.status === 201, `create failed: ${created.status}: ${JSON.stringify(created.body)}`);

  try {
    const published = await api('PATCH', `/admin/news/${created.body.id}/publish`, { body: {} });
    assert(published.status === 200, `publish failed: ${published.status}: ${JSON.stringify(published.body)}`);

    // Anonymous — no cookie, no CSRF header. Two fetches: the first hits
    // the database, the second must come back from CacheInterceptor's LRU
    // (@CacheTags('news')) — the leak this case guards against was cached,
    // not just served once.
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${BASE}/news/${created.body.slug}`);
      assert(res.status === 200, `public read #${attempt + 1} failed: ${res.status}`);
      const raw = await res.text();
      for (const leak of ['passwordHash', 'password_hash', '$argon2', 'isLocked', 'failedLogins', 'lastLoginAt', 'author', 'storageKey', 'checksumSha256', 'uploadedBy', 'originalName']) {
        assert(!raw.includes(leak), `public news payload (attempt ${attempt + 1}) leaks "${leak}"`);
      }
      const body = JSON.parse(raw);
      assert(body.coverAsset?.publicId, 'coverAsset.publicId must survive the projection — the frontend renders from it');
      assert(typeof body.title === 'string', 'the bilingual collapse must still produce `title`');
    }

    const list = await api('GET', '/news');
    assert(list.status === 200, `news list failed: ${list.status}`);
    const raw = JSON.stringify(list.body);
    assert(!raw.includes('storageKey') && !raw.includes('checksumSha256'), 'GET /news list leaks asset storage internals');
  } finally {
    await api('DELETE', `/admin/news/${created.body.id}`);
  }
});

// ---------------------------------------------------------------------------

test('B0-1: the process refuses to boot without NODE_ENV, and refuses NODE_ENV=production + ALLOW_DEV_PASSWORD_FIXUP=true', async () => {
  const { spawnSync } = await import('node:child_process');

  // loadEnv() needs the rest of the schema to parse before its own checks
  // matter — a minimal but complete set, independent of whatever .env this
  // machine actually has.
  const REQUIRED = {
    DB_HOST: 'x', DB_USER: 'x', DB_PASSWORD: 'x', DB_NAME: 'x',
    APP_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    BOOTSTRAP_ADMIN_EMAIL: 'a@b.com', BOOTSTRAP_ADMIN_PASSWORD: 'longenoughpw',
    IP_HASH_SALT: 'x', CORS_ORIGINS: 'http://x', PUBLIC_BASE_URL: 'http://x',
  };

  function probe(overrides) {
    const env = { ...REQUIRED, ...overrides };
    const script = `
      import { loadEnv } from '../dist/config/env.js';
      loadEnv(${JSON.stringify(env)});
      console.log('LOADED_OK');
    `;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: import.meta.dirname, encoding: 'utf8' });
  }

  const missing = probe({});
  assert(missing.status === 1, `missing NODE_ENV must be a startup failure, got status ${missing.status}`);
  assert(/NODE_ENV/.test(missing.stderr), `the error must name NODE_ENV, got: ${missing.stderr}`);

  const combo = probe({ NODE_ENV: 'production', ALLOW_DEV_PASSWORD_FIXUP: 'true' });
  assert(combo.status === 1, `production + ALLOW_DEV_PASSWORD_FIXUP=true must be refused at boot, got status ${combo.status}`);
  assert(/ALLOW_DEV_PASSWORD_FIXUP/.test(combo.stderr), `the error must name the offending key, got: ${combo.stderr}`);

  const validDev = probe({ NODE_ENV: 'development' });
  assert(validDev.status === 0 && validDev.stdout.includes('LOADED_OK'), `a valid dev env must still load: ${validDev.stderr}`);

  const validProd = probe({ NODE_ENV: 'production' });
  assert(validProd.status === 0 && validProd.stdout.includes('LOADED_OK'), `NODE_ENV=production without the fixup flag must still load: ${validProd.stderr}`);
});

// ---------------------------------------------------------------------------

test('B0-6: a pending invitee is never given BOOTSTRAP_ADMIN_PASSWORD by the dev fixup', async () => {
  // The fixup itself only runs once, in BootstrapService.onApplicationBootstrap
  // — it cannot be re-triggered over HTTP. This case asserts the invariant
  // it must hold (an invitee's password is never BOOTSTRAP_ADMIN_PASSWORD);
  // the regression it guards against — every unfiltered restart handing out
  // that password — only reproduces across an actual restart. Full manual
  // check: invite, restart the API, then run `npm run smoke` again and
  // confirm this case still passes.
  const email = `smoke-invite-${Date.now()}@example.com`;
  const invited = await api('POST', '/admin/auth/invite', { body: { email, name: 'Smoke Invitee', role: 'editor' } });
  assert(invited.status === 201 || invited.status === 200, `invite failed: ${invited.status}: ${JSON.stringify(invited.body)}`);

  try {
    const res = await fetch(`${BASE}/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    assert(res.status === 401, `a pending invitee signed in with BOOTSTRAP_ADMIN_PASSWORD (status ${res.status}) — B0-6 regressed`);
  } finally {
    await api('DELETE', `/admin/users/${invited.body.id}`);
  }
});

// ---------------------------------------------------------------------------

test('B0-5: a production migrate never sees migrations/dev/, and refuses to run with no NODE_ENV', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (overrides) => {
    const env = { ...process.env, ...overrides };
    return spawnSync(process.execPath, ['scripts/migrate.mjs', '--status'], { env, encoding: 'utf8' });
  };

  const prod = run({ NODE_ENV: 'production' });
  assert(prod.status === 0, `--status failed under NODE_ENV=production: ${prod.stderr}`);
  assert(!prod.stdout.includes('003_dev_sample.sql'), `production migrate still sees the dev sample:\n${prod.stdout}`);
  assert(prod.stdout.includes('001_schema.sql') && prod.stdout.includes('002_seed.sql'), `real migrations must still be listed:\n${prod.stdout}`);

  const dev = run({ NODE_ENV: 'development' });
  assert(dev.status === 0, `--status failed under NODE_ENV=development: ${dev.stderr}`);
  assert(dev.stdout.includes('003_dev_sample.sql'), `dev migrate must still include migrations/dev/:\n${dev.stdout}`);
  assert(dev.stdout.includes('[applied] 003_dev_sample.sql'),
    `the pre-move schema_migrations row must still match after the migrations/dev/ move (bare-basename version key):\n${dev.stdout}`);

  // A deleted key plus a nonexistent DOTENV_CONFIG_PATH is what makes this
  // "no NODE_ENV" rather than "empty string" — migrate.mjs's own `import
  // 'dotenv/config'` would otherwise re-populate NODE_ENV from this repo's
  // .env, which every dev machine running this suite has.
  const noEnvEnv = { ...process.env, DOTENV_CONFIG_PATH: 'does-not-exist.env' };
  delete noEnvEnv.NODE_ENV;
  const noEnv = spawnSync(process.execPath, ['scripts/migrate.mjs', '--status'], { env: noEnvEnv, encoding: 'utf8' });
  assert(noEnv.status === 1, `migrate must refuse to run with no NODE_ENV, got status ${noEnv.status}`);
  assert(/NODE_ENV/.test(noEnv.stderr), `the error must name NODE_ENV, got: ${noEnv.stderr}`);
});

// ---------------------------------------------------------------------------

test('B0-4: an editor cannot delete content, delete media, or read the audit log', async () => {
  // Needs the seeded editor (003_dev_sample.sql) to actually be able to
  // sign in, which only happens when ALLOW_DEV_PASSWORD_FIXUP=true. Skip
  // cleanly rather than fail when that isn't this environment's setup.
  let editor;
  try {
    editor = await editorSession();
  } catch {
    console.log('    (skipped — no signed-in-able seeded editor; needs migrations/dev + ALLOW_DEV_PASSWORD_FIXUP=true)');
    return;
  }

  const created = await api('POST', '/admin/channels', { body: { type: 'phone', labelAr: `smoke b0-4 ${Date.now()}` } });
  assert(created.status === 201, `admin create failed: ${created.status}: ${JSON.stringify(created.body)}`);
  const asset = await uploadTinyPng();

  try {
    const del = await api('DELETE', `/admin/channels/${created.body.id}`, { session: editor });
    assert(del.status === 403, `editor deleted a content row (status ${del.status}): ${JSON.stringify(del.body)}`);
    assert(del.body?.code === 'FORBIDDEN', `expected FORBIDDEN, got ${del.body?.code}`);

    const media = await api('DELETE', `/admin/media/${asset.id}`, { session: editor });
    assert(media.status === 403, `editor deleted a media asset (status ${media.status}): ${JSON.stringify(media.body)}`);

    const audit = await api('GET', '/admin/audit?limit=1', { session: editor });
    assert(audit.status === 403, `editor read the audit log (status ${audit.status}): ${JSON.stringify(audit.body)}`);

    // The gate must be scoped to `remove`, not the whole controller — an
    // editor still needs list/create/update/upload to do their actual job.
    const patched = await api('PATCH', `/admin/channels/${created.body.id}`, { session: editor, body: { labelAr: 'تعديل محرر' } });
    assert(patched.status === 200, `editor can no longer edit content (status ${patched.status}) — the delete gate is too wide`);
    const list = await api('GET', '/admin/media', { session: editor });
    assert(list.status === 200, `editor can no longer list media (status ${list.status}) — media gating must be per-handler, not class-level`);

    // M4/5.1: two spots B0-4 missed. AdminDonationsController had no
    // @Roles at all; MeetingAttachmentsController.remove is hand-written
    // and bypasses the kernel's deleteRoles default.
    const donations = await api('GET', '/admin/donations', { session: editor });
    assert(donations.status === 403, `editor read donor PII (status ${donations.status}): ${JSON.stringify(donations.body)}`);

    const meetings = await api('GET', '/admin/meetings?limit=1');
    const meetingId = meetings.body.data[0]?.id;
    if (meetingId) {
      const meetingAsset = await uploadTinyPng();
      await api('PATCH', `/admin/media/${meetingAsset.id}`, { body: { altAr: 'مرفق تجريبي M4' } });
      const attachment = await api('POST', `/admin/meetings/${meetingId}/attachments`, { body: { assetId: meetingAsset.id } });
      if (attachment.status === 201) {
        try {
          const attDel = await api('DELETE', `/admin/meetings/${meetingId}/attachments/${attachment.body.id}`, { session: editor });
          assert(attDel.status === 403, `editor deleted a meeting attachment (status ${attDel.status}): ${JSON.stringify(attDel.body)}`);
        } finally {
          await api('DELETE', `/admin/meetings/${meetingId}/attachments/${attachment.body.id}`);
        }
      }
    }
  } finally {
    await api('DELETE', `/admin/channels/${created.body.id}`);
    await api('DELETE', `/admin/media/${asset.id}`);
  }
});

// ---------------------------------------------------------------------------

test('M1/5.2: a locked-out account can recover via password reset', async () => {
  // Same underlying requirement as B0-4 (the seeded editor must be able to
  // sign in with BOOTSTRAP_ADMIN_PASSWORD) — checked via the env flag
  // rather than an extra login call: /admin/auth/login carries its own
  // @Throttle (5/min per IP, independent of AuthService's per-email
  // limiter — a NestJS route throttle, not reset by a successful login),
  // and this test already needs two login calls of its own on top of
  // whatever the rest of the suite has already spent from the same IP.
  if (process.env.ALLOW_DEV_PASSWORD_FIXUP !== 'true') {
    console.log('    (skipped — needs migrations/dev + ALLOW_DEV_PASSWORD_FIXUP=true)');
    return;
  }

  const EMAIL = 'editor@safeer-sa.org';
  await withDb(async (conn) => {
    const [[before]] = await conn.query('SELECT is_locked, failed_logins FROM users WHERE email = ?', [EMAIL]);
    try {
      // Simulate the locked state directly — tripping it via 10 real HTTP
      // failures would also have to survive AuthService's own 5-per-60s
      // per-email rate limit (a *separate* mechanism from the 10-failure
      // account lock, checkEmailRateLimit), which would make this take
      // minutes to run. The fix under test only cares that resetPassword()
      // clears isLocked/failedLogins, not how the account got locked.
      await conn.query('UPDATE users SET is_locked = 1, failed_logins = 10 WHERE email = ?', [EMAIL]);

      const lockedLogin = await fetch(`${BASE}/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      });
      assert(lockedLogin.status === 401, `expected 401 for a locked account even with the correct password, got ${lockedLogin.status}`);

      const [[user]] = await conn.query('SELECT id FROM users WHERE email = ?', [EMAIL]);
      const rawToken = randomBytes(32).toString('base64url');
      await conn.query(
        'INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 60 MINUTE))',
        [user.id, 'reset', hashToken(rawToken)],
      );

      const resetRes = await fetch(`${BASE}/admin/auth/reset/${rawToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert(resetRes.status === 200 || resetRes.status === 201, `reset failed: ${resetRes.status}: ${JSON.stringify(await resetRes.text())}`);

      const [[after]] = await conn.query('SELECT is_locked, failed_logins FROM users WHERE email = ?', [EMAIL]);
      assert(Number(after.is_locked) === 0, `expected isLocked cleared after reset, got is_locked=${after.is_locked}`);
      assert(Number(after.failed_logins) === 0, `expected failedLogins cleared after reset, got failed_logins=${after.failed_logins}`);

      const finalLogin = await fetch(`${BASE}/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      });
      assert(finalLogin.status === 200 || finalLogin.status === 201, `login after reset should succeed, got ${finalLogin.status}`);
    } finally {
      await conn.query('UPDATE users SET is_locked = ?, failed_logins = ? WHERE email = ?', [before.is_locked, before.failed_logins, EMAIL]);
    }
  });
});

// ---------------------------------------------------------------------------

test('B0-2: /api/docs is served only outside production', async () => {
  // /api/docs sits outside setGlobalPrefix (main.ts), and outside the guard
  // chain too — that's the whole point of gating it at bootstrap instead.
  const res = await fetch(`http://localhost:${PORT}/api/docs`, { redirect: 'manual' });
  const json = await fetch(`http://localhost:${PORT}/api/docs-json`);
  if (process.env.NODE_ENV === 'production') {
    assert(res.status === 404, `Swagger UI is reachable in production (status ${res.status})`);
    assert(json.status === 404, `the OpenAPI JSON is reachable in production (status ${json.status})`);
  } else {
    assert(res.status === 200 || res.status === 301, `Swagger UI should still be available outside production, got ${res.status}`);
    assert(json.status === 200, `the OpenAPI JSON should still be available outside production, got ${json.status}`);
  }
});

// ---------------------------------------------------------------------------

test('B3-1: the OpenAPI document has the /api/v1 server prefix and no array-of-string leftovers', async () => {
  if (process.env.NODE_ENV === 'production') {
    console.log('    (skipped — /api/docs-json is gated off in production, per B0-2)');
    return;
  }
  const doc = await (await fetch(`http://localhost:${PORT}/api/docs-json`)).json();

  assert(Array.isArray(doc.servers) && doc.servers.some((s) => s.url === '/api/v1'),
    `servers must include /api/v1, got ${JSON.stringify(doc.servers)}`);

  let brokenCount = 0;
  const brokenExamples = [];
  for (const [schemaName, schema] of Object.entries(doc.components?.schemas ?? {})) {
    for (const [propName, prop] of Object.entries(schema.properties ?? {})) {
      if (prop.type === 'array' && prop.items?.type === 'string' && prop['x-nestjs_zod-empty-type']) {
        brokenCount++;
        brokenExamples.push(`${schemaName}.${propName}`);
      }
    }
  }
  assert(brokenCount === 0, `${brokenCount} propert${brokenCount === 1 ? 'y' : 'ies'} still shaped as a broken array-of-string: ${brokenExamples.slice(0, 5).join(', ')}`);
});

// ---------------------------------------------------------------------------

test('B2: cached public routes set Cache-Control and Vary: Accept-Language', async () => {
  // NFR-02 — without this, a CDN or Nginx cache in front of the API would
  // serve whichever locale answered first to every visitor for the TTL.
  for (const path of ['/home', '/news', '/library/videos']) {
    const res = await fetch(`${BASE}${path}`);
    assert(res.status === 200, `${path} failed: ${res.status}`);
    const cacheControl = res.headers.get('cache-control');
    assert(cacheControl?.includes('max-age') && cacheControl?.includes('public'), `${path} missing a public Cache-Control, got: ${cacheControl}`);
    const vary = res.headers.get('vary');
    assert(vary?.includes('Accept-Language'), `${path} missing Vary: Accept-Language, got: ${vary}`);
  }
});

// ---------------------------------------------------------------------------

test('B2: FR-G-12 cache admin — stats and purge (whole and per-tag)', async () => {
  // Warm the cache under a known tag, then confirm a targeted purge drops
  // it and a full clear drops everything.
  await api('GET', '/news');

  const stats = await api('GET', '/admin/cache/stats');
  assert(stats.status === 200, `stats failed: ${stats.status}`);
  for (const key of ['entries', 'maxEntries', 'hits', 'misses', 'hitRate', 'uptimeSeconds']) {
    assert(key in stats.body, `cache stats missing "${key}"`);
  }
  assert(stats.body.entries >= 1, `expected at least the warmed /news entry, got ${stats.body.entries}`);

  const purgedTag = await api('DELETE', '/admin/cache?tag=news');
  assert(purgedTag.status === 200, `tag purge failed: ${purgedTag.status}`);
  assert(purgedTag.body.purged >= 1, `expected at least 1 purged entry, got ${JSON.stringify(purgedTag.body)}`);

  await api('GET', '/library/videos');
  const cleared = await api('DELETE', '/admin/cache');
  assert(cleared.status === 200, `full clear failed: ${cleared.status}`);

  const afterClear = await api('GET', '/admin/cache/stats');
  assert(afterClear.body.entries === 0, `cache should be empty after a full clear, got ${afterClear.body.entries}`);
});

// ---------------------------------------------------------------------------

test('task 5: a repeated ?tag= on DELETE /admin/cache purges nothing — and never falls through to a full clear', async () => {
  // 30-backend-finishing-prompt.md §2.5: `?tag=a&tag=b` used to arrive as
  // `['a', 'b']` (querystring.parse) and reach `purgeTag()` directly,
  // reporting a misleading "successful" purge of 0 entries. The fix
  // (`asString`) must land on the *same* branch as a valid single tag —
  // report 0 and touch nothing — never on the full-clear branch, which
  // would be a worse regression (a malformed request wiping the whole
  // cache).
  await api('GET', '/news');
  await api('GET', '/library/videos');
  const before = await api('GET', '/admin/cache/stats');
  assert(before.body.entries >= 2, `expected at least 2 warmed entries, got ${before.body.entries}`);

  const malformed = await api('DELETE', '/admin/cache?tag=a&tag=b');
  assert(malformed.status === 200, `malformed purge failed: ${malformed.status}`);
  assert(malformed.body.purged === 0, `expected purged:0 for a repeated tag, got ${JSON.stringify(malformed.body)}`);

  const after = await api('GET', '/admin/cache/stats');
  assert(after.body.entries === before.body.entries, `a malformed ?tag= must not change entry count, went from ${before.body.entries} to ${after.body.entries}`);
});

test('task 5: a page past the last one reports the real total, not 0', async () => {
  // 30-backend-finishing-prompt.md §2.5: MAX_OFFSET used to sit exactly at
  // NFR-12's 10,000-item ceiling, and every `beyondMaxOffset` short-circuit
  // reported `total: 0` instead of the real (possibly non-zero) total.
  // Checked against two independent call shapes: a TypeORM query builder
  // (audit) and a raw-SQL UNION (submissions) — the fix touched both.
  const audit = await api('GET', '/admin/audit?page=999999&limit=200');
  assert(audit.status === 200, `audit list failed: ${audit.status}`);
  assert(audit.body.data.length === 0, 'expected an empty data page past the last real page');
  assert(audit.body.total > 0, `expected a real (non-zero) total, got ${audit.body.total}`);

  const submissions = await api('GET', '/admin/submissions?page=999999&limit=100');
  assert(submissions.status === 200, `submissions list failed: ${submissions.status}`);
  assert(submissions.body.data.length === 0, 'expected an empty data page past the last real page');
  assert(submissions.body.total > 0, `expected a real (non-zero) total, got ${submissions.body.total}`);
});

test('task 5: /home projects every governance body/document-category slug, not just the six frontend-contract ones', async () => {
  const home = await api('GET', '/home');
  assert(home.status === 200, `GET /home failed: ${home.status}`);
  const gov = home.body.governance;
  // The frontend-contract slugs must always be present (possibly 0).
  for (const slug of ['assembly', 'board']) {
    assert(slug in gov.members, `governance.members missing frontend-contract slug "${slug}"`);
    assert(slug in gov.meetings, `governance.meetings missing frontend-contract slug "${slug}"`);
  }
  for (const slug of ['plans', 'reports', 'policies', 'governance']) {
    assert(slug in gov.documents.byCategory, `governance.documents.byCategory missing frontend-contract slug "${slug}"`);
  }
  // documents.total must equal the sum of every category actually
  // returned, not just the four contract ones — otherwise a category
  // outside that list would be counted then silently dropped from the total.
  const sum = Object.values(gov.documents.byCategory).reduce((a, b) => a + b, 0);
  assert(gov.documents.total === sum, `documents.total (${gov.documents.total}) must equal the sum of byCategory (${sum})`);
});

// ---------------------------------------------------------------------------

test('3: /home?path=<n> cannot mint unbounded cache keys and evict the LRU (run this suite with CACHE_TTL_SECONDS >= 600)', async () => {
  // 30-backend-finishing-prompt.md §2.3: before this fix, buildCacheKey()
  // read one fixed allowlist shared by every cached route — which included
  // `path` (added for /redirects/resolve's 4.3 fix) even on routes that
  // never read it, so `GET /home?path=<n>` minted a distinct entry per
  // `n`. ~500 of those (CACHE_MAX_ENTRIES' default) evicted every other
  // cached response, including /library/videos below. `/home` now
  // declares `@CacheKeyParams()` (no query dimension), so every one of
  // these 600 distinct `?path=` requests collapses onto the same cache
  // key as a bare `GET /home`.
  //
  // Run this case (and ideally the whole suite) with CACHE_TTL_SECONDS
  // raised well above how long 600 requests take — at the default 60s,
  // the flood itself could outlast the TTL and the final assertion would
  // fail for the wrong reason (a real expiry, not an eviction).
  await api('DELETE', '/admin/cache'); // clean slate so the entry count below is exact

  // Warm the entry this flood must not evict.
  const warm = await api('GET', '/library/videos');
  assert(warm.status === 200, `warm /library/videos failed: ${warm.status}`);

  const before = await api('GET', '/admin/cache/stats');
  const entriesBefore = before.body.entries;

  // 600 distinct ?path= values against the deliberately @SkipThrottle()d
  // /home route, in batches so as not to open 600 concurrent sockets.
  const FLOOD_SIZE = 600;
  const BATCH = 40;
  for (let i = 0; i < FLOOD_SIZE; i += BATCH) {
    const batch = [];
    for (let j = i; j < Math.min(i + BATCH, FLOOD_SIZE); j++) {
      batch.push(api('GET', `/home?path=${j}`));
    }
    const results = await Promise.all(batch);
    for (const r of results) assert(r.status === 200, `GET /home?path= failed: ${r.status}`);
  }

  const afterFlood = await api('GET', '/admin/cache/stats');
  // With no query dimension declared for /home, all 600 requests above
  // collapsed onto the *same* cache key — the LRU should have grown by at
  // most 1 entry (the /home entry itself), not by hundreds.
  assert(
    afterFlood.body.entries <= entriesBefore + 1,
    `expected the /home flood to add at most 1 entry, went from ${entriesBefore} to ${afterFlood.body.entries} — the cache key is not bounded`,
  );

  // Direct residency proof (stats() exposes no key list, so this is the
  // closest thing to one): a hit here, with zero additional misses, is
  // only possible if /library/videos's entry from the warm-up above
  // survived the flood untouched.
  const beforeCheck = await api('GET', '/admin/cache/stats');
  const check = await api('GET', '/library/videos');
  assert(check.status === 200, `residency check request failed: ${check.status}`);
  const afterCheck = await api('GET', '/admin/cache/stats');
  assert(
    afterCheck.body.hits === beforeCheck.body.hits + 1 && afterCheck.body.misses === beforeCheck.body.misses,
    `expected /library/videos to still be cached (hits +1, misses +0), got hits ${beforeCheck.body.hits}->${afterCheck.body.hits}, misses ${beforeCheck.body.misses}->${afterCheck.body.misses}`,
  );
});

// ---------------------------------------------------------------------------

test('B2: FR-L-18 GET /admin/library/broken lists only published+unavailable items', async () => {
  // Exercises the endpoint's shape, not the nightly job itself — that only
  // runs on its @Cron schedule (maintenance.service.ts), nothing here can
  // trigger it on demand. This just proves the route exists, doesn't
  // collide with GET /admin/library/:id (route-order note in the
  // controller), and the filter is correct against whatever the database
  // already has.
  const res = await api('GET', '/admin/library/broken');
  assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert(Array.isArray(res.body), `expected an array, got ${typeof res.body}`);
  for (const item of res.body) {
    assert(item.isPublished === true, `broken list included an unpublished item: ${item.id}`);
    assert(item.isAvailable === false, `broken list included an available item: ${item.id}`);
  }

  // The route-collision guard, explicitly: a real numeric id must still
  // reach get(':id'), not fall through to broken()'s handler.
  const notFound = await api('GET', '/admin/library/999999999');
  assert(notFound.status === 404, `a nonexistent numeric id should 404 via get(':id'), got ${notFound.status}`);
});

// ---------------------------------------------------------------------------

test('M3/B2: NFR-11 structured JSON logging redacts header-shaped secrets, in string and object form', async () => {
  // Standalone — the logger has no DB dependency, so this checks the
  // compiled module directly rather than the running server's own stdout
  // (which this script has no access to anyway).
  const { spawnSync } = await import('node:child_process');
  const script = `
    import { RedactingJsonLogger } from '../dist/common/logging/redacting-json-logger.js';
    import { Logger } from '@nestjs/common';
    Logger.overrideLogger(new RedactingJsonLogger());
    const logger = new Logger('SmokeTest');
    logger.log('Bootstrap admin created: admin@safeer-sa.org');
    logger.warn('dump: Cookie: sf_sid=abcdef1234567890 more');
    // The JSON-quoted shape this logger's own { json: true } mode actually
    // emits — the original patterns required the delimiter immediately
    // after the bare key name, which this never satisfies.
    logger.warn('payload: "cookie":"sf_sid=jsonformvalue" end');
    // M3(b): the gap the original review flagged as the most likely future
    // regression — passing a raw object (not a pre-stringified string).
    // redact() used to return non-strings untouched.
    logger.error({ headers: { cookie: 'sf_sid=objectform', authorization: 'Bearer topsecret', accept: 'application/json' }, requestId: 'abc-123' });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: import.meta.dirname, encoding: 'utf8' });
  assert(result.status === 0, `logger probe failed: ${result.stderr}`);

  // log()/warn() go to stdout, error() to stderr (ConsoleLogger's own
  // documented split) — read both rather than assuming one stream or a
  // fixed line order across them.
  const lines = [...result.stdout.trim().split('\n'), ...result.stderr.trim().split('\n')]
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert(lines.length === 4, `expected 4 JSON log lines total, got ${lines.length}: stdout=${result.stdout} stderr=${result.stderr}`);

  const bootstrapLine = lines.find((l) => typeof l.message === 'string' && l.message.includes('admin@safeer-sa.org'));
  assert(bootstrapLine, 'a non-sensitive message must survive untouched');

  const cookieLine = lines.find((l) => typeof l.message === 'string' && l.message.includes('dump:'));
  assert(cookieLine && !cookieLine.message.includes('abcdef1234567890'), `cookie value leaked: ${cookieLine?.message}`);
  assert(cookieLine.message.includes('[REDACTED]'), `cookie line should show [REDACTED]: ${cookieLine.message}`);

  const jsonFormLine = lines.find((l) => typeof l.message === 'string' && l.message.includes('payload:'));
  assert(jsonFormLine && !jsonFormLine.message.includes('jsonformvalue'), `JSON-quoted cookie value leaked: ${jsonFormLine?.message}`);
  assert(jsonFormLine.message.includes('[REDACTED]'), `JSON-form cookie line should show [REDACTED]: ${jsonFormLine.message}`);

  // Hostinger's log reader needs `message` to be a string, so an object
  // message is JSON-encoded (after redaction) rather than nested.
  const objectLine = lines.find((l) => l.level === 'ERROR');
  assert(objectLine, 'expected the object-message error line');
  const raw = objectLine.message;
  assert(typeof raw === 'string', `object message should be JSON-encoded into a string, got: ${typeof raw}`);
  assert(!raw.includes('objectform'), `object-form cookie leaked: ${raw}`);
  assert(!raw.includes('topsecret'), `object-form authorization token leaked: ${raw}`);
  const parsed = JSON.parse(raw);
  assert(parsed.headers.cookie === '[REDACTED]', `expected headers.cookie to be redacted, got: ${parsed.headers.cookie}`);
  assert(parsed.headers.authorization === '[REDACTED]', `expected headers.authorization to be redacted, got: ${parsed.headers.authorization}`);
  assert(parsed.headers.accept === 'application/json', 'a non-sensitive nested key must survive untouched');
  assert(parsed.requestId === 'abc-123', 'a non-sensitive top-level key must survive untouched');

  // The shape Hostinger's runtime-log reader accepts: every line JSON with
  // a string ISO timestamp, an upper-case level and a string message.
  for (const line of lines) {
    for (const key of ['level', 'pid', 'timestamp', 'message']) {
      assert(key in line, `log line missing "${key}": ${JSON.stringify(line)}`);
    }
    assert(typeof line.message === 'string', `message must be a string: ${JSON.stringify(line)}`);
    assert(line.level === line.level.toUpperCase(), `level must be upper-case: ${line.level}`);
    assert(!Number.isNaN(Date.parse(line.timestamp)) && typeof line.timestamp === 'string', `timestamp must be an ISO string: ${line.timestamp}`);
  }
});

// ---------------------------------------------------------------------------

test('B0-3: public reads never leak media-asset storage internals, and keep the fields the frontend declares', async () => {
  const LEAKS = ['storageKey', 'storage_key', 'checksumSha256', 'checksum_sha256', 'uploadedBy', 'uploaded_by', 'originalName', 'original_name'];

  async function checkPublic(path, label, requiredKeysRaw) {
    const res = await fetch(`${BASE}${path}`);
    assert(res.status === 200, `${label} failed: ${res.status}`);
    const raw = await res.text();
    for (const leak of LEAKS) {
      assert(!raw.includes(leak), `${label} leaks "${leak}"`);
    }
    return JSON.parse(raw);
  }

  // library — sourceUrl/isAvailable/sortOrder must survive: the frontend's
  // check-contract.mjs declares them required, and D-12 only forbids
  // building an iframe from sourceUrl, it doesn't make the field private.
  const library = await checkPublic('/library/videos?limit=1', 'GET /library/videos');
  if (library.data.length > 0) {
    const item = library.data[0];
    for (const key of ['sourceUrl', 'isAvailable', 'sortOrder', 'embedUrl', 'sourceType']) {
      assert(key in item, `library item is missing "${key}" — B0-3's projection must not drop frontend-required fields`);
    }
    for (const key of ['searchText', 'createdBy', 'providerRef', 'checkedAt']) {
      assert(!(key in item), `library item still exposes internal-only field "${key}"`);
    }
  }

  // governance — closes KNOWN-ISSUES.md #3 (termFromYear missing from the wire)
  const members = await checkPublic('/governance/bodies/assembly/members', 'GET /governance/bodies/assembly/members');
  assert('termFromYear' in (members.members[0] ?? { termFromYear: null }), 'body member is missing termFromYear (KNOWN-ISSUES #3)');

  await checkPublic('/governance/bodies/board/meetings', 'GET /governance/bodies/board/meetings');
  await checkPublic('/governance/documents/reports', 'GET /governance/documents/reports');

  // home — the four asset-joining arrays (news/products/partners/library.latest)
  const home = await checkPublic('/home', 'GET /home');
  for (const key of ['settings', 'stats', 'aboutItems', 'news', 'products', 'partners', 'channels', 'languages', 'library', 'governance']) {
    assert(key in home, `GET /home is missing "${key}" — the payload shape must not change`);
  }
});

// ---------------------------------------------------------------------------

test('B3-4: FEATURE_LIBRARY_SEARCH is actually read, not just validated at boot', async () => {
  // Was previously read nowhere — `?q=` worked unconditionally regardless
  // of the flag. Only asserts the enabled path (the default), since flipping
  // it off needs a restart; the disabled path is a one-line env.ts read.
  const res = await api('GET', '/library/videos?q=test&limit=1');
  assert(res.status === 200, `search query failed with FEATURE_LIBRARY_SEARCH default (enabled): ${res.status}`);
  assert(Array.isArray(res.body?.data), 'expected a paginated result even for a query with no matches');
});

// ---------------------------------------------------------------------------

test('B3-2: the CRUD kernel and the audit log use the same pagination envelope as the public routes', async () => {
  const kernel = await api('GET', '/admin/channels?limit=1');
  assert(kernel.status === 200, `kernel list failed: ${kernel.status}`);
  for (const key of ['data', 'total', 'page', 'limit']) {
    assert(key in kernel.body, `admin/channels is missing "${key}" — expected {data,total,page,limit}`);
  }
  assert(!('pageSize' in kernel.body), 'admin/channels still returns the old "pageSize" field');
  assert(!('rows' in kernel.body), 'admin/channels unexpectedly returns "rows"');

  const audit = await api('GET', '/admin/audit?limit=1');
  assert(audit.status === 200, `audit list failed: ${audit.status}`);
  for (const key of ['data', 'total', 'page', 'limit']) {
    assert(key in audit.body, `admin/audit is missing "${key}" — expected {data,total,page,limit}`);
  }
  assert(!('rows' in audit.body), 'admin/audit still returns the old "rows" field');
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
      console.log(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

await main();
