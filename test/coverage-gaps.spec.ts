// test/coverage-gaps.spec.ts — Phase 7: items PR #2 fixed before this plan
// that had no Jest coverage yet.
//   Settings/social  youtube/linkedin/whatsapp/tiktok URLs reach GET /site;
//                    an unsafe scheme is refused (C10)
//   B13              the news search treats % and _ literally
//   B14              two simultaneous submits: exactly one wins

import { adminApi, api, createApplication, deleteApplication, uploadApplicationDocument, withDb } from './helpers';

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
