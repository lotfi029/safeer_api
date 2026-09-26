// test/coverage-gaps.spec.ts — Phase 7: items PR #2 fixed before this plan
// that had no Jest coverage yet.
//   Settings/social  youtube/linkedin/whatsapp/tiktok URLs reach GET /site;
//                    an unsafe scheme is refused (C10)
//   B13              the news search treats % and _ literally
//   B14              two simultaneous submits: exactly one wins
//   C37              an alt-text edit shows at once on cached public pages
//   C38              an undecodable image is a 422; a duplicate upload returns the existing asset
//   C46              a reply keeps its delivery status after the mail_log purge

import sharp from 'sharp';
import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE, adminApi, api, createApplication, deleteApplication, loginAs, uploadApplicationDocument, withDb } from './helpers';

async function uploadMedia(buffer: Buffer, filename: string, type: string) {
  const admin = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type }), filename);
  const res = await fetch(`${BASE}/admin/media`, { method: 'POST', headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrfToken }, body: form });
  return { status: res.status, body: await res.json() };
}

describe('site settings: social links', () => {
  it('the four newer social URLs are stored and served on GET /site; javascript: is refused', async () => {
    const before = await adminApi('GET', '/admin/settings');
    const links = {
      youtubeUrl: 'https://www.youtube.com/@example',
      linkedinUrl: 'https://www.linkedin.com/company/example',
      whatsappUrl: 'https://wa.me/966500000000',
      tiktokUrl: 'https://www.tiktok.com/@example',
    };
    try {
      expect((await adminApi('PUT', '/admin/settings', { body: links })).status).toBe(200);
      const site = await api('GET', '/site');
      expect(site.body.settings).toMatchObject(links);

      const unsafe = await adminApi('PUT', '/admin/settings', { body: { youtubeUrl: 'javascript:alert(1)' } });
      expect(unsafe.status).toBe(400);
    } finally {
      const restore = Object.fromEntries(Object.keys(links).map((k) => [k, before.body[k] ?? null]));
      await adminApi('PUT', '/admin/settings', { body: restore });
    }
  });
});

describe('B13: news search', () => {
  it('matches % and _ literally, not as LIKE wildcards', async () => {
    const category = await withDb((conn) => conn.execute('SELECT id FROM news_categories ORDER BY id LIMIT 1').then(([r]: any) => String(r[0].id)));
    const tag = `b13${Date.now()}`;
    const literal = await adminApi('POST', '/admin/news', { body: { titleAr: `خصم 50% ${tag}`, bodyAr: 'نص', categoryId: category, isPublished: true } });
    const other = await adminApi('POST', '/admin/news', { body: { titleAr: `خصم 50 ${tag} x`, bodyAr: 'نص', categoryId: category, isPublished: true } });
    try {
      const percent = await api('GET', `/news?q=${encodeURIComponent(`50% ${tag}`)}`);
      expect(percent.body.data.map((p: any) => p.id)).toEqual([literal.body.id]);
      const underscore = await api('GET', `/news?q=${encodeURIComponent(`5_ ${tag}`)}`);
      expect(underscore.body.data).toEqual([]);
    } finally {
      await adminApi('DELETE', `/admin/news/${literal.body.id}`);
      await adminApi('DELETE', `/admin/news/${other.body.id}`);
    }
  });
});

describe('B14: submit is serialised', () => {
  it('two simultaneous submits of a complete draft: one succeeds, the other is refused, one STATUS event', async () => {
    const applicant = await createApplication();
    try {
      for (const docType of ['id_copy', 'certificate', 'admission_letter']) {
        expect((await uploadApplicationDocument(applicant, docType, `b14-${docType}`)).status).toBe(201);
      }
      const body = {
        firstName: 'Test',
        middleName: null,
        lastName: 'Applicant',
        birthDate: '2000-01-01',
        phone: applicant.phone,
        nationality: 'SA',
        email: applicant.email,
        gender: 'male',
        university: 'Test University',
        major: 'Testing',
        degreeLevel: 'bachelor',
        consent: true,
      };
      const results = await Promise.all([
        api('POST', '/portal/application/submit', { body, session: applicant }),
        api('POST', '/portal/application/submit', { body, session: applicant }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 200 || s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(1);

      const submittedEvents: number = await withDb((conn) =>
        conn
          .execute("SELECT COUNT(*) AS n FROM application_events WHERE application_id = ? AND type = 'SUBMITTED'", [applicant.id])
          .then(([r]: any) => Number(r[0].n)),
      );
      expect(submittedEvents).toBe(1);
      expect(await withDb((conn) => conn.execute('SELECT status FROM applications WHERE id = ?', [applicant.id]).then(([r]: any) => r[0].status))).toBe('new');
    } finally {
      await deleteApplication(applicant.id);
    }
  });
});

describe('C37 / C38: media', () => {
  it('C38: an undecodable image is a 422, and uploading the same bytes twice returns the existing asset', async () => {
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not really a jpeg '.repeat(20))]);
    const bad = await uploadMedia(corrupt, 'corrupt.jpg', 'image/jpeg');
    expect(bad.status).toBe(422);

    const png = await sharp({ create: { width: 16, height: 9, channels: 3, background: { r: 5, g: 99, b: Date.now() % 255 } } }).png().toBuffer();
    const first = await uploadMedia(png, 'dup.png', 'image/png');
    const second = await uploadMedia(png, 'dup-again.png', 'image/png');
    try {
      expect(first.status).toBe(201);
      expect([200, 201]).toContain(second.status);
      expect(second.body.id).toBe(first.body.id);
    } finally {
      await adminApi('DELETE', `/admin/media/${first.body.id}`);
    }
  });

  it("C37: changing an asset's alt text purges every cached page that shows it", async () => {
    const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: { r: 200, g: 10, b: Date.now() % 255 } } }).png().toBuffer();
    const asset = (await uploadMedia(png, 'c37.png', 'image/png')).body;
    expect((await adminApi('PATCH', `/admin/media/${asset.id}`, { body: { altAr: 'نص بديل قديم' } })).status).toBe(200);
    const category = await withDb((conn) => conn.execute('SELECT id FROM news_categories ORDER BY id LIMIT 1').then(([r]: any) => String(r[0].id)));
    const post = await adminApi('POST', '/admin/news', { body: { titleAr: 'غلاف', bodyAr: 'نص', categoryId: category, coverAssetId: asset.id, isPublished: true } });
    try {
      const warm = await api('GET', `/news/${post.body.slug}?lang=ar`);
      expect(warm.body.coverAsset.alt).toBe('نص بديل قديم');
      expect((await adminApi('PATCH', `/admin/media/${asset.id}`, { body: { altAr: 'نص بديل جديد' } })).status).toBe(200);
      const after = await api('GET', `/news/${post.body.slug}?lang=ar`);
      expect(after.body.coverAsset.alt).toBe('نص بديل جديد');
    } finally {
      await adminApi('DELETE', `/admin/news/${post.body.id}`);
      await adminApi('DELETE', `/admin/media/${asset.id}`);
    }
  });
});

describe('C46: reply delivery status', () => {
  it('survives the 90-day mail_log purge', async () => {
    const email = `c46-${Date.now()}@example.com`;
    await api('POST', '/contact', { body: { name: 'Sara Ali', email, phone: null, subject: 'other', body: 'Hello there', formRenderedAt: Date.now() - 10_000 } });
    const messageId: string = await withDb((conn) => conn.execute('SELECT id FROM contact_messages WHERE email = ?', [email]).then(([r]: any) => String(r[0].id)));
    try {
      expect((await adminApi('POST', `/admin/messages/${messageId}/reply`, { body: { body: 'Thank you' } })).status).toBe(201);
      const [reply]: any = await withDb((conn) => conn.execute('SELECT id, mail_log_id FROM message_replies WHERE message_id = ?', [messageId]).then(([r]: any) => r));
      expect(reply.mail_log_id).not.toBeNull();
      await withDb((conn) =>
        conn.execute("UPDATE mail_log SET status = 'sent', created_at = UTC_TIMESTAMP(3) - INTERVAL 100 DAY WHERE id = ?", [reply.mail_log_id]),
      );

      expect((await api('POST', '/__dev/maintenance/run')).status).toBe(200);

      const [after]: any = await withDb((conn) => conn.execute('SELECT mail_log_id, delivery_status FROM message_replies WHERE id = ?', [reply.id]).then(([r]: any) => r));
      expect(after.mail_log_id).toBeNull();
      expect(after.delivery_status).toBe('sent');
    } finally {
      await withDb((conn) => conn.execute('DELETE FROM contact_messages WHERE id = ?', [messageId]));
    }
  });
});

