// test/storage.spec.ts — Phase 6 (storage abstraction, decision 3): a row
// whose stored file has gone missing answers 404 on every download route
// (never a 500), and readiness reports the store.

import { rmSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE, adminApi, createApplication, deleteApplication, loginAs, uploadApplicationDocument, withDb } from './helpers';

const STORAGE_ROOT = path.resolve(process.env.TEST_STORAGE_ROOT ?? './var/assets-test');
const ORIGIN = BASE.replace(/\/api\/v1$/, '');

describe('storage: missing files', () => {
  it('/files answers 404 when the asset row exists but its file does not', async () => {
    const admin = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    const png = await sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), `missing-${Date.now()}.png`);
    const upload = await fetch(`${BASE}/admin/media`, { method: 'POST', headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrfToken }, body: form });
    const asset = await upload.json();
    expect(upload.status).toBe(201);
    try {
      expect((await fetch(`${ORIGIN}/files/${asset.publicId}`, { headers: { Cookie: admin.cookie } })).status).toBe(200);
      const key: string = await withDb((conn) => conn.execute('SELECT storage_key FROM media_assets WHERE id = ?', [asset.id]).then(([r]: any) => r[0].storage_key));
      rmSync(path.join(STORAGE_ROOT, key));
      expect((await fetch(`${ORIGIN}/files/${asset.publicId}`, { headers: { Cookie: admin.cookie } })).status).toBe(404);
    } finally {
      await adminApi('DELETE', `/admin/media/${asset.id}`);
    }
  });

  it('a private document download answers 404 when its file is gone', async () => {
    const applicant = await createApplication();
    try {
      const uploaded = await uploadApplicationDocument(applicant, 'id_copy', 'gone');
      expect(uploaded.status).toBe(201);
      const url = `${BASE}/portal/documents/${uploaded.body.id}/file`;
      expect((await fetch(url, { headers: { Cookie: applicant.cookie } })).status).toBe(200);
      const key: string = await withDb((conn) =>
        conn.execute('SELECT storage_key FROM application_documents WHERE id = ?', [uploaded.body.id]).then(([r]: any) => r[0].storage_key),
      );
      rmSync(path.join(STORAGE_ROOT, key));
      const res = await fetch(url, { headers: { Cookie: applicant.cookie } });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('readiness reports the storage check', async () => {
    const res = await fetch(`${ORIGIN}/health/ready`);
    expect(res.status).toBe(200);
    expect((await res.json()).checks.storage).toBe('up');
  });
});
