// test/content-publishing.spec.ts — Phase 4 of the fix plan, content:
//   C13 publish rules on create, publishedOn defaults to today, a missing cover is a warning,
//       publish/unpublish audited even through a plain update
//   C14 slug format/reserved words, no self/stale redirects after renames, page slug read-only
//   C26 page-section and about-item bodies are sanitized HTML

import { adminApi, api, withDb } from './helpers';

async function categoryId(): Promise<string> {
  return withDb((conn) => conn.execute('SELECT id FROM news_categories ORDER BY id LIMIT 1').then(([rows]: any) => String(rows[0].id)));
}

/** The audit row is inserted just after the response, so poll until the expected action shows up (or give up and return the last one). */
async function lastAudit(entityId: string, expected?: string): Promise<string> {
  let action: string | undefined;
  for (let i = 0; i < 50; i++) {
    action = await withDb((conn) =>
      conn
        .execute("SELECT action FROM audit_log WHERE entity_type = 'posts' AND entity_id = ? ORDER BY id DESC LIMIT 1", [entityId])
        .then(([rows]: any) => rows[0]?.action),
    );
    if (expected === undefined || action === expected) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return action as string;
}

async function redirectsFrom(path: string): Promise<any[]> {
  return withDb((conn) => conn.execute('SELECT from_path, to_path FROM redirects WHERE from_path = ? OR to_path = ?', [path, path]).then(([rows]: any) => rows));
}

describe('content publishing', () => {
  const created: string[] = [];
  afterAll(async () => {
    for (const id of created) await adminApi('DELETE', `/admin/news/${id}`);
  });

  async function createPost(body: Record<string, unknown>) {
    const res = await adminApi('POST', '/admin/news', { body: { titleAr: 'خبر', titleEn: `Jest post ${Date.now()}`, bodyAr: 'نص', categoryId: await categoryId(), ...body } });
    if (res.status === 201) created.push(res.body.id);
    return res;
  }

  describe('C13', () => {
    it('creating a published post without a cover succeeds with a COVER_MISSING warning and today as publishedOn', async () => {
      const res = await createPost({ isPublished: true });
      expect(res.status).toBe(201);
      expect(res.body.warnings).toEqual(['COVER_MISSING']);
      expect(res.body.publishedOn).toBe(new Date().toISOString().slice(0, 10));
    });

    it('publish/unpublish are audited as such, also through a plain update', async () => {
      const draft = await createPost({});
      expect(draft.body.warnings).toEqual([]);
      expect(draft.body.publishedOn ?? null).toBeNull();

      const published = await adminApi('PATCH', `/admin/news/${draft.body.id}`, { body: { isPublished: true } });
      expect(published.status).toBe(200);
      expect(published.body.publishedOn).toBe(new Date().toISOString().slice(0, 10));
      expect(await lastAudit(draft.body.id, 'publish')).toBe('publish');

      await adminApi('PATCH', `/admin/news/${draft.body.id}/publish`, { body: { isPublished: false } });
      expect(await lastAudit(draft.body.id, 'unpublish')).toBe('unpublish');
    });
  });

  describe('C14', () => {
    it.each(['Hello World', 'UPPER', 'a/b', 'featured', `x${'y'.repeat(200)}`])('rejects the slug %j', async (slug) => {
      const post = await createPost({});
      const res = await adminApi('PATCH', `/admin/news/${post.body.id}`, { body: { slug } });
      expect(res.status).toBe(400);
    });

    it('renaming A→B→A leaves no self-redirect, and the live path is never redirected away', async () => {
      const suffix = Date.now();
      const post = await createPost({ isPublished: true });
      const a = `jest-a-${suffix}`;
      const b = `jest-b-${suffix}`;
      expect((await adminApi('PATCH', `/admin/news/${post.body.id}`, { body: { slug: a } })).status).toBe(200);
      expect((await adminApi('PATCH', `/admin/news/${post.body.id}`, { body: { slug: b } })).status).toBe(200);
      expect(await redirectsFrom(`/news/${a}`)).toEqual([{ from_path: `/news/${a}`, to_path: `/news/${b}` }]);

      expect((await adminApi('PATCH', `/admin/news/${post.body.id}`, { body: { slug: a } })).status).toBe(200);
      const rows = await redirectsFrom(`/news/${a}`);
      expect(rows.some((r) => r.from_path === `/news/${a}`)).toBe(false);
      // The post's generated slug and b both lead straight to a (the chain is collapsed).
      expect(rows.every((r) => r.to_path === `/news/${a}`)).toBe(true);
      expect(rows).toContainEqual({ from_path: `/news/${b}`, to_path: `/news/${a}` });
      await withDb((conn) => conn.execute('DELETE FROM redirects WHERE to_path = ?', [`/news/${a}`]));
    });

    it("a page's slug can't be changed", async () => {
      const pages = await adminApi('GET', '/admin/pages?limit=1');
      const page = pages.body.data[0];
      const res = await adminApi('PATCH', `/admin/pages/${page.id}`, { body: { slug: `renamed-${Date.now()}` } });
      expect(res.status).toBe(400);
    });
  });

  describe('C26', () => {
    it('page-section bodies are served as sanitized HTML', async () => {
      const sections = await adminApi('GET', '/admin/page-sections?limit=100');
      const section = sections.body.data.find((s: any) => s.isPublished);
      const [page]: any = await withDb((conn) => conn.execute('SELECT slug FROM pages WHERE id = ?', [section.pageId]).then(([r]: any) => r));
      const original = section.bodyAr;
      try {
        await adminApi('PATCH', `/admin/page-sections/${section.id}`, { body: { bodyAr: '**مهم** <script>alert(1)</script>' } });
        const pub = await api('GET', `/pages/${page.slug}?lang=ar`);
        const body = pub.body.sections.find((s: any) => s.id === section.id).body;
        expect(body).toContain('<strong>مهم</strong>');
        expect(body).not.toContain('<script>');
      } finally {
        await adminApi('PATCH', `/admin/page-sections/${section.id}`, { body: { bodyAr: original } });
      }
    });

    it('about-item bodies on /home are sanitized HTML', async () => {
      const home = await api('GET', '/home?lang=ar');
      for (const goal of home.body.aboutItems.goals) {
        if (goal.body) expect(goal.body).not.toMatch(/\*\*|__/);
      }
      const items = await adminApi('GET', '/admin/about-items?kind=goal&limit=1');
      const item = items.body.data[0];
      if (!item) return;
      const original = item.bodyAr;
      try {
        await adminApi('PATCH', `/admin/about-items/${item.id}`, { body: { bodyAr: '_هدف_' } });
        const after = await api('GET', '/home?lang=ar');
        const goal = after.body.aboutItems.goals.find((g: any) => g.id === item.id);
        expect(goal.body).toContain('<em>هدف</em>');
      } finally {
        await adminApi('PATCH', `/admin/about-items/${item.id}`, { body: { bodyAr: original } });
      }
    });
  });
});
