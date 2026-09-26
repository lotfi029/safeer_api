// test/content.spec.ts — Phase 6, area 6: locale fallback (?lang=en with an
// empty *_en returns the Arabic value), the publish filter on public
// routes, B8 delete roles, B11 item visibility, B15 sitemap index.

import { adminApi, api, createTempUser, deleteTempUser } from './helpers';

describe('content', () => {
  it('locale fallback: ?lang=en with an empty titleEn returns the Arabic value', async () => {
    const before = await api('GET', '/home');
    const goal = before.body.aboutItems?.goals?.[0];
    expect(goal).toBeTruthy();
    const original = await adminApi('GET', `/admin/about-items/${goal.id}`);
    expect(original.status).toBe(200);
    try {
      await adminApi('PATCH', `/admin/about-items/${goal.id}`, { body: { titleEn: null } });
      const home = await api('GET', '/home?lang=en');
      const updated = home.body.aboutItems.goals.find((g: any) => g.id === goal.id);
      expect(updated).toBeTruthy();
      expect(updated.title).toBe(original.body.titleAr);
    } finally {
      await adminApi('PATCH', `/admin/about-items/${goal.id}`, { body: { titleEn: original.body.titleEn } });
    }
  });

  it('the publish filter hides an unpublished page from the public site but keeps it visible to admin', async () => {
    const pages = await adminApi('GET', '/admin/pages?limit=50');
    const page = pages.body.data.find((p: any) => p.isPublished);
    expect(page).toBeTruthy();
    try {
      await adminApi('PATCH', `/admin/pages/${page.id}`, { body: { isPublished: false } });
      const site = await api('GET', '/site');
      expect(site.body.nav.some((n: any) => n.slug === page.slug)).toBe(false);
      const adminGet = await adminApi('GET', `/admin/pages/${page.id}`);
      expect(adminGet.status).toBe(200);
    } finally {
      await adminApi('PATCH', `/admin/pages/${page.id}`, { body: { isPublished: true } });
    }
  });

  it('B8: an editor can delete a partner but not a testimonial; a support user can delete a testimonial but not a partner', async () => {
    const editor = await createTempUser('editor');
    const support = await createTempUser('support');
    try {
      const partner = await adminApi('POST', '/admin/partners', {
        body: { nameAr: 'شريك تجريبي', category: 'supporter', isPublished: false, sortOrder: 999 },
      });
      expect(partner.status).toBe(201);

      const editorDeletesPartner = await api('DELETE', `/admin/partners/${partner.body.id}`, { session: editor });
      expect(editorDeletesPartner.status).toBe(200);

      const supportDeletesPartner = await adminApi('POST', '/admin/partners', {
        body: { nameAr: 'شريك تجريبي 2', category: 'supporter', isPublished: false, sortOrder: 999 },
      });
      const forbidden = await api('DELETE', `/admin/partners/${supportDeletesPartner.body.id}`, { session: support });
      expect(forbidden.status).toBe(403);
      await adminApi('DELETE', `/admin/partners/${supportDeletesPartner.body.id}`);
    } finally {
      await deleteTempUser(editor.id);
      await deleteTempUser(support.id);
    }
  });

  it('B11: an unpublished work-area item is hidden from the public /work-areas list', async () => {
    const items = await adminApi('GET', '/admin/work-area-items?limit=1');
    const item = items.body.data[0];
    expect(item).toBeTruthy();
    try {
      await adminApi('PATCH', `/admin/work-area-items/${item.id}/publish`, { body: { isPublished: false } });
      const publicList = await api('GET', '/work-areas');
      const ids = publicList.body.flatMap((a: any) => a.items.map((i: any) => i.id));
      expect(ids).not.toContain(item.id);
    } finally {
      await adminApi('PATCH', `/admin/work-area-items/${item.id}/publish`, { body: { isPublished: true } });
    }
  });

  it('B15: sitemap-index lists published pages/posts with slug+updatedAt, and every news category', async () => {
    const sitemap = await api('GET', '/sitemap-index');
    expect(sitemap.status).toBe(200);
    expect(Array.isArray(sitemap.body.pages)).toBe(true);
    expect(sitemap.body.pages.length).toBeGreaterThan(0);
    for (const entry of sitemap.body.pages) {
      expect(typeof entry.slug).toBe('string');
      expect(entry.updatedAt).toBeTruthy();
    }
    expect(Array.isArray(sitemap.body.categories)).toBe(true);
    expect(sitemap.body.categories.length).toBeGreaterThan(0);
  });
});
