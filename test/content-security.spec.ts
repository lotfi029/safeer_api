// test/content-security.spec.ts — Phase 3 of the fix plan, content:
//   B4/B5 sweep: every admin/* route is role-gated (check-admin-roles in Jest)
//   C7  image originals re-encoded: no EXIF/GPS, orientation applied, post-rotation size;
//       scripts/reprocess-media.mjs backfills older assets
//   C10 stored URLs limited to safe schemes; redirects are site paths, no chains
//   C24 ?preview only bypasses the cache on preview-aware routes, with a valid token
//   C25 short cache for originals/PDFs; a document in an unpublished category isn't public

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { adminApi, api, BASE, withDb } from './helpers';
import { runScript, ROOT } from './scripts.helpers';

const ORIGIN = new URL(BASE).origin;
const STORAGE_ROOT = path.resolve(ROOT, process.env.TEST_STORAGE_ROOT ?? './var/assets-test');

let adminCookie = '';
async function adminSessionCookie(): Promise<string> {
  if (adminCookie) return adminCookie;
  const res = await fetch(`${BASE}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_ADMIN_EMAIL, password: process.env.TEST_ADMIN_PASSWORD }),
  });
  adminCookie = res.headers.get('set-cookie')!.split(';')[0];
  const csrf = (await res.json()).csrfToken;
  adminCsrf = csrf;
  return adminCookie;
}
let adminCsrf = '';

/** A 40×20 JPEG carrying EXIF orientation 6 (rotate 90°) and an identifying EXIF field. */
async function exifJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({ IFD0: { Copyright: `jest-exif-${randomUUID()}` } })
    .toBuffer();
}

async function uploadMedia(buffer: Buffer, filename: string, type: string) {
  const cookie = await adminSessionCookie();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type }), filename);
  const res = await fetch(`${BASE}/admin/media`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': adminCsrf }, body: form });
  return { status: res.status, body: await res.json() };
}

describe('content security', () => {
  it('B4/B5/B17 sweep: every admin/* route is gated by its role-matrix area or explicitly allow-listed', () => {
    const result = runScript('scripts/check-admin-roles.mjs', {
      ...process.env,
      DOTENV_CONFIG_PATH: '/dev/null',
      NODE_ENV: 'test',
      DB_NAME: process.env.TEST_DB_NAME,
      DB_HOST: process.env.TEST_DB_HOST,
      DB_PORT: process.env.TEST_DB_PORT,
      DB_USER: process.env.TEST_DB_USER,
      DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? '',
      STORAGE_ROOT: STORAGE_ROOT,
    });
    expect(result.output).toContain('Every admin/* route is gated by its role-matrix area or explicitly allow-listed.');
    expect(result.status).toBe(0);
  });

  describe('C7: image originals', () => {
    it('are re-encoded on upload: EXIF gone, orientation applied, post-rotation size stored', async () => {
      const input = await exifJpeg();
      const inputMeta = await sharp(input).metadata();
      expect(inputMeta.exif).toBeDefined();
      expect(inputMeta.orientation).toBe(6);

      const uploaded = await uploadMedia(input, 'photo.jpg', 'image/jpeg');
      expect(uploaded.status).toBe(201);
      const asset = uploaded.body.asset ?? uploaded.body;
      expect(asset.widthPx).toBe(20);
      expect(asset.heightPx).toBe(40);

      const [row]: any = await withDb((conn) => conn.execute('SELECT storage_key FROM media_assets WHERE id = ?', [asset.id]).then(([r]: any) => r));
      const stored = await sharp(readFileSync(path.join(STORAGE_ROOT, row.storage_key))).metadata();
      expect(stored.exif).toBeUndefined();
      expect(stored.orientation ?? 1).toBe(1);
      expect([stored.width, stored.height]).toEqual([20, 40]);
    });

    it('scripts/reprocess-media.mjs backfills an asset stored before the change', async () => {
      const input = await exifJpeg();
      const publicId = randomUUID();
      const storageKey = `assets/legacy/${publicId}.jpg`;
      mkdirSync(path.join(STORAGE_ROOT, 'assets/legacy'), { recursive: true });
      writeFileSync(path.join(STORAGE_ROOT, storageKey), input);
      const assetId = await withDb(async (conn) => {
        const [res]: any = await conn.execute(
          `INSERT INTO media_assets (public_id, kind, mime_type, size_bytes, original_name, storage_key, checksum_sha256, width_px, height_px)
           VALUES (?, 'image', 'image/jpeg', ?, 'legacy.jpg', ?, ?, 40, 20)`,
          [publicId, input.length, storageKey, publicId.replace(/-/g, '').padEnd(64, '0')],
        );
        return String(res.insertId);
      });

      const env = {
        ...process.env,
        DOTENV_CONFIG_PATH: '/dev/null',
        NODE_ENV: 'test',
        DB_NAME: process.env.TEST_DB_NAME,
        DB_HOST: process.env.TEST_DB_HOST,
        DB_PORT: process.env.TEST_DB_PORT,
        DB_USER: process.env.TEST_DB_USER,
        DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? '',
        STORAGE_ROOT,
        STORAGE_DRIVER: 'local',
      };
      const dry = runScript('scripts/reprocess-media.mjs', env);
      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain(`would reprocess asset ${assetId}`);
      expect((await sharp(readFileSync(path.join(STORAGE_ROOT, storageKey))).metadata()).exif).toBeDefined();

      const applied = runScript('scripts/reprocess-media.mjs', env, ['--apply']);
      expect(applied.status).toBe(0);
      const after = await sharp(readFileSync(path.join(STORAGE_ROOT, storageKey))).metadata();
      expect(after.exif).toBeUndefined();
      expect([after.width, after.height]).toEqual([20, 40]);
      const [row]: any = await withDb((conn) => conn.execute('SELECT width_px, height_px FROM media_assets WHERE id = ?', [assetId]).then(([r]: any) => r));
      expect([row.width_px, row.height_px]).toEqual([20, 40]);
      await withDb((conn) => conn.execute('DELETE FROM media_assets WHERE id = ?', [assetId]));
    });
  });

  describe('C10: stored URLs', () => {
    it.each(['javascript:alert(1)', 'data:text/html,x', '//evil.example'])('rejects %j for a partner url and a social link', async (url) => {
      const partner = await adminApi('POST', '/admin/partners', { body: { nameAr: 'شريك', url } });
      expect(partner.status).toBe(400);
      const settings = await adminApi('PUT', '/admin/settings', { body: { facebookUrl: url } });
      expect(settings.status).toBe(400);
    });

    it('page-section buttons accept a site path or http(s), not javascript:', async () => {
      const sections = await adminApi('GET', '/admin/page-sections?limit=1');
      const id = sections.body.data[0].id;
      const original = sections.body.data[0].primaryButtonUrl;
      expect((await adminApi('PATCH', `/admin/page-sections/${id}`, { body: { primaryButtonUrl: 'javascript:alert(1)' } })).status).toBe(400);
      expect((await adminApi('PATCH', `/admin/page-sections/${id}`, { body: { primaryButtonUrl: '/apply' } })).status).toBe(200);
      await adminApi('PATCH', `/admin/page-sections/${id}`, { body: { primaryButtonUrl: original } });
    });

    it('redirects: site paths only, from ≠ to, no chains', async () => {
      const suffix = Date.now();
      const bad = [
        { fromPath: `/a-${suffix}`, toPath: 'https://evil.example' },
        { fromPath: `/a-${suffix}`, toPath: '//evil.example' },
        { fromPath: `/a-${suffix}`, toPath: `/a-${suffix}` },
      ];
      for (const body of bad) expect((await adminApi('POST', '/admin/redirects', { body })).status).toBe(400);

      const first = await adminApi('POST', '/admin/redirects', { body: { fromPath: `/a-${suffix}`, toPath: `/b-${suffix}` } });
      expect(first.status).toBe(201);
      try {
        const onward = await adminApi('POST', '/admin/redirects', { body: { fromPath: `/b-${suffix}`, toPath: `/c-${suffix}` } });
        expect(onward.status).toBe(409);
        expect(onward.body.code).toBe('REDIRECT_CHAIN');
        const into = await adminApi('POST', '/admin/redirects', { body: { fromPath: `/z-${suffix}`, toPath: `/a-${suffix}` } });
        expect(into.status).toBe(409);
      } finally {
        await adminApi('DELETE', `/admin/redirects/${first.body.id}`);
      }
    });
  });

  describe('C24: preview and the cache', () => {
    it('?preview on a route that has no preview is served from the cache like any request', async () => {
      await api('GET', '/site');
      const [settings]: any = await withDb((conn) => conn.execute('SELECT phone FROM site_settings WHERE id = 1').then(([r]: any) => r));
      await withDb((conn) => conn.execute("UPDATE site_settings SET phone = '+966-jest-uncached' WHERE id = 1"));
      try {
        const withPreview = await api('GET', '/site?preview=anything');
        expect(withPreview.body.contact.phone).not.toBe('+966-jest-uncached');
      } finally {
        await withDb((conn) => conn.execute('UPDATE site_settings SET phone = ? WHERE id = 1', [settings.phone]));
      }
    });

    it('news detail: a valid token shows the draft privately; a bad token is a 404', async () => {
      const slug = `jest-preview-${Date.now()}`;
      const postId = await withDb(async (conn) => {
        const [res]: any = await conn.execute(
          "INSERT INTO posts (slug, title_ar, body_ar, is_published, category_id) VALUES (?, 'مسودة', 'نص', 0, (SELECT id FROM news_categories ORDER BY id LIMIT 1))",
          [slug],
        );
        return String(res.insertId);
      });
      try {
        const token = (await adminApi('GET', `/admin/preview-token?collection=posts&id=${postId}`)).body.token;
        const ok = await fetch(`${BASE}/news/${slug}?preview=${encodeURIComponent(token)}`);
        expect(ok.status).toBe(200);
        expect(ok.headers.get('cache-control')).toBe('private, no-store');
        expect((await fetch(`${BASE}/news/${slug}?preview=bad`)).status).toBe(404);
        expect((await fetch(`${BASE}/news/${slug}`)).status).toBe(404);
      } finally {
        await withDb((conn) => conn.execute('DELETE FROM posts WHERE id = ?', [postId]));
      }
    });
  });

  it('C25: originals/PDFs get a short cache; a document in an unpublished category is not public', async () => {
    const pdf = Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF jest-c25-${Date.now()}`);
    const uploaded = await uploadMedia(pdf, 'report.pdf', 'application/pdf');
    expect(uploaded.status).toBe(201);
    const asset = uploaded.body.asset ?? uploaded.body;

    const category = await adminApi('POST', '/admin/doc-categories', { body: { slug: `jest-cat-${Date.now()}`, nameAr: 'فئة', isPublished: true } });
    expect(category.status).toBe(201);
    const doc = await adminApi('POST', '/admin/documents', {
      body: { categoryId: category.body.id, titleAr: 'تقرير', assetId: asset.id, isPublished: true },
    });
    expect(doc.status).toBe(201);
    try {
      const pub = await fetch(`${ORIGIN}/files/${asset.publicId}`);
      expect(pub.status).toBe(200);
      expect(pub.headers.get('cache-control')).toContain('max-age=300');
      expect(pub.headers.get('content-disposition')).toContain("filename*=UTF-8''report.pdf");

      await adminApi('PATCH', `/admin/doc-categories/${category.body.id}`, { body: { isPublished: false } });
      expect((await fetch(`${ORIGIN}/files/${asset.publicId}`)).status).toBe(404);
    } finally {
      await adminApi('DELETE', `/admin/documents/${doc.body.id}`);
      await adminApi('DELETE', `/admin/doc-categories/${category.body.id}`);
    }
  });
});
