// test/governance-sections.spec.ts — feat/governance-contact (A6, 022):
//   GET documents/sections lists the published governance categories in
//   order, each with its count of published documents; GET
//   documents/sections/:slug serves one published category (any group) and
//   404s for an unknown or unpublished one; admin writes accept sectionGroup
//   and metaAr/metaEn; GET documents keeps working.

import { adminApi, api } from './helpers';

const GOVERNANCE_SLUGS = [
  'bylaws-policies',
  'financial-reports',
  'general-assembly',
  'strategic-plan',
  'operational-plan',
  'annual-reports',
  'project-reports',
  'committees',
  'committee-decisions',
];

async function categoryId(slug: string): Promise<string> {
  const res = await adminApi('GET', `/admin/doc-categories?slug=${slug}`);
  expect(res.body.data).toHaveLength(1);
  return res.body.data[0].id;
}

describe('governance sections (022)', () => {
  const created: { docs: string[]; categories: string[] } = { docs: [], categories: [] };

  afterAll(async () => {
    for (const id of created.docs) await adminApi('DELETE', `/admin/documents/${id}`);
    for (const id of created.categories) await adminApi('DELETE', `/admin/doc-categories/${id}`);
  });

  it('lists the published governance categories in order, with published-document counts', async () => {
    const financial = await categoryId('financial-reports');
    const before = await api('GET', '/documents/sections?lang=en');
    expect(before.status).toBe(200);
    expect(before.body.map((s: any) => s.slug)).toEqual(GOVERNANCE_SLUGS);
    for (const section of before.body) {
      expect(Object.keys(section).sort()).toEqual(['count', 'id', 'name', 'sectionGroup', 'slug']);
      expect(section.sectionGroup).toBe('governance');
    }
    const countBefore = before.body.find((s: any) => s.slug === 'financial-reports').count;
    expect(before.body.find((s: any) => s.slug === 'committees').name).toBe('Committees');
    expect((await api('GET', '/documents/sections')).body.find((s: any) => s.slug === 'committees').name).toBe('اللجان');

    const published = await adminApi('POST', '/admin/documents', {
      body: { categoryId: financial, titleAr: 'تقرير مالي', metaAr: 'السنة المالية 2025', metaEn: 'Financial year 2025', isPublished: true },
    });
    expect(published.status).toBe(201);
    created.docs.push(published.body.id);
    const draft = await adminApi('POST', '/admin/documents', { body: { categoryId: financial, titleAr: 'مسودة', isPublished: false } });
    expect(draft.status).toBe(201);
    created.docs.push(draft.body.id);

    const after = await api('GET', '/documents/sections');
    expect(after.body.find((s: any) => s.slug === 'financial-reports').count).toBe(countBefore + 1);

    // The section itself: only the published document, with its meta line.
    const section = await api('GET', '/documents/sections/financial-reports?lang=en');
    expect(section.status).toBe(200);
    expect(section.body.category).toMatchObject({ slug: 'financial-reports', name: 'Financial reports', sectionGroup: 'governance' });
    const ids = section.body.documents.map((d: any) => d.id);
    expect(ids).toContain(published.body.id);
    expect(ids).not.toContain(draft.body.id);
    expect(section.body.documents.find((d: any) => d.id === published.body.id).meta).toBe('Financial year 2025');

    // GET documents still works and carries the new fields.
    const register = await api('GET', '/documents?lang=ar');
    expect(register.status).toBe(200);
    const group = register.body.find((g: any) => g.category.slug === 'financial-reports');
    expect(group.category.sectionGroup).toBe('governance');
    expect(group.documents.find((d: any) => d.id === published.body.id).meta).toBe('السنة المالية 2025');
  });

  it('an unpublished category leaves the list and its slug answers 404; so does an unknown slug', async () => {
    const committees = await categoryId('committees');
    expect((await api('GET', '/documents/sections/committees')).status).toBe(200);
    await adminApi('PATCH', `/admin/doc-categories/${committees}`, { body: { isPublished: false } });
    try {
      const list = await api('GET', '/documents/sections');
      expect(list.body.map((s: any) => s.slug)).not.toContain('committees');
      const hidden = await api('GET', '/documents/sections/committees');
      expect(hidden.status).toBe(404);
      expect(hidden.body.code).toBe('NOT_FOUND');
    } finally {
      await adminApi('PATCH', `/admin/doc-categories/${committees}`, { body: { isPublished: true } });
    }
    expect((await api('GET', '/documents/sections/no-such-section')).status).toBe(404);
    // The retired licences category is unpublished and outside the governance group.
    expect((await api('GET', '/documents/sections/licences')).status).toBe(404);
  });

  it("a published category in the 'other' group is served by slug but not listed", async () => {
    const res = await adminApi('POST', '/admin/doc-categories', {
      body: { slug: `jest-other-${Date.now()}`, nameAr: 'أخرى', sectionGroup: 'other', isPublished: true },
    });
    expect(res.status).toBe(201);
    created.categories.push(res.body.id);
    expect(res.body.sectionGroup).toBe('other');
    expect((await api('GET', '/documents/sections')).body.map((s: any) => s.slug)).not.toContain(res.body.slug);
    const one = await api('GET', `/documents/sections/${res.body.slug}`);
    expect(one.status).toBe(200);
    expect(one.body.category.sectionGroup).toBe('other');
    expect(one.body.documents).toEqual([]);
  });

  it('admin writes validate sectionGroup and the 190-character meta lines', async () => {
    const financial = await categoryId('financial-reports');
    expect((await adminApi('POST', '/admin/doc-categories', { body: { slug: `jest-bad-${Date.now()}`, nameAr: 'س', sectionGroup: 'nope' } })).status).toBe(400);
    expect((await adminApi('POST', '/admin/documents', { body: { categoryId: financial, titleAr: 'س', metaAr: 'م'.repeat(191) } })).status).toBe(400);
    const ok = await adminApi('POST', '/admin/documents', { body: { categoryId: financial, titleAr: 'س', metaAr: 'م'.repeat(190), metaEn: null } });
    expect(ok.status).toBe(201);
    created.docs.push(ok.body.id);
    expect(ok.body.metaAr).toHaveLength(190);
  });

  it('the site nav lists the governance page in place of documents', async () => {
    const site = await api('GET', '/site?lang=en');
    const slugs = site.body.nav.map((n: any) => n.slug);
    expect(slugs).toContain('governance');
    expect(slugs).not.toContain('documents');
    expect(site.body.nav.find((n: any) => n.slug === 'governance').label).toBe('Governance');
    expect((await api('GET', '/pages/governance')).status).toBe(200);
    expect((await api('GET', '/pages/documents')).status).toBe(200); // the page stays, out of the nav
  });
});
