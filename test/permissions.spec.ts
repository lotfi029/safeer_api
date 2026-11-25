// test/permissions.spec.ts — the permission model (PERM-3/PERM-5; was the
// Phase 7 role matrix, area 1).
//
// For every role × every admin route group, the expected answer comes from
// the role's live permission set (the seeded system roles, plus a custom
// "news only" role), never from a copy of it here. Each group names its
// permission module once; a read probe answers 200 (or the route's own
// status for a bad request) or 403, and a delete probe on an id that doesn't
// exist answers 404 (allowed, nothing there) or 403 (refused before the
// lookup). A coverage check fails if openapi.json gains an admin route group
// this file doesn't probe. Also: the unauthenticated 401.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { api, createTempRole, createTempUser, deleteTempRole, deleteTempUser, rolePermissions, type Session } from './helpers';

const MISSING_ID = '999999999';

interface Probe {
  module: string;
  read: string;
  /** What an allowed read answers, when not 200 (the preview-token probe sends no query, so it's a 400). */
  readOk?: number;
  /** The group's DELETE (gated by `<module>.delete`). */
  delete?: string;
}

const PROBES: Record<string, Probe> = {
  'admin/pages': { module: 'pages', read: '/admin/pages', delete: `/admin/pages/${MISSING_ID}` },
  'admin/page-sections': { module: 'pages', read: '/admin/page-sections', delete: `/admin/page-sections/${MISSING_ID}` },
  'admin/news': { module: 'news', read: '/admin/news', delete: `/admin/news/${MISSING_ID}` },
  'admin/news-categories': { module: 'news', read: '/admin/news-categories', delete: `/admin/news-categories/${MISSING_ID}` },
  'admin/preview-token': { module: 'news', read: '/admin/preview-token', readOk: 400 },
  'admin/work-areas': { module: 'workAreas', read: '/admin/work-areas', delete: `/admin/work-areas/${MISSING_ID}` },
  'admin/work-area-items': { module: 'workAreas', read: '/admin/work-area-items', delete: `/admin/work-area-items/${MISSING_ID}` },
  'admin/board': { module: 'board', read: '/admin/board', delete: `/admin/board/${MISSING_ID}` },
  'admin/stats': { module: 'stats', read: '/admin/stats', delete: `/admin/stats/${MISSING_ID}` },
  'admin/about-items': { module: 'aboutItems', read: '/admin/about-items', delete: `/admin/about-items/${MISSING_ID}` },
  'admin/partners': { module: 'partners', read: '/admin/partners', delete: `/admin/partners/${MISSING_ID}` },
  'admin/doc-categories': { module: 'documents', read: '/admin/doc-categories', delete: `/admin/doc-categories/${MISSING_ID}` },
  'admin/documents': { module: 'documents', read: '/admin/documents', delete: `/admin/documents/${MISSING_ID}` },
  'admin/licences': { module: 'licences', read: '/admin/licences', delete: `/admin/licences/${MISSING_ID}` },
  'admin/org-positions': { module: 'orgChart', read: '/admin/org-positions', delete: `/admin/org-positions/${MISSING_ID}` },
  'admin/media': { module: 'media', read: '/admin/media', delete: `/admin/media/${MISSING_ID}` },
  'admin/redirects': { module: 'redirects', read: '/admin/redirects', delete: `/admin/redirects/${MISSING_ID}` },

  'admin/messages': { module: 'messages', read: '/admin/messages', delete: `/admin/messages/${MISSING_ID}` },
  'admin/testimonials': { module: 'testimonials', read: '/admin/testimonials', delete: `/admin/testimonials/${MISSING_ID}` },
  'admin/testimonial-themes': { module: 'testimonials', read: '/admin/testimonial-themes', delete: `/admin/testimonial-themes/${MISSING_ID}` },
  'admin/newsletter': { module: 'newsletter', read: '/admin/newsletter', delete: `/admin/newsletter/${MISSING_ID}` },

  'admin/users': { module: 'users', read: '/admin/users', delete: `/admin/users/${MISSING_ID}` },
  'admin/settings': { module: 'settings', read: '/admin/settings' },
  'admin/cache': { module: 'settings', read: '/admin/cache/stats' },
  'admin/mail': { module: 'mail', read: '/admin/mail/settings' },
  'admin/audit': { module: 'audit', read: '/admin/audit' },
};

/** Open to any signed-in staff member, with no permission (scripts/lib/check-permissions.mjs's allow-list). */
const ANY_STAFF = ['admin/me', 'admin/auth', 'admin/overview'];

const NEWS_ONLY = 'jest-news-only';
const NEWS_ONLY_PERMISSIONS = ['news.view', 'news.manage', 'news.delete'];
const ROLES = ['admin', 'editor', 'support', NEWS_ONLY];

const can = (perms: string[], key: string) => perms.includes('*') || perms.includes(key);

describe('permission model (generated from each role’s live permissions)', () => {
  const sessions: Record<string, Session> = {};
  const perms: Record<string, string[]> = {};
  const tempIds: string[] = [];
  let newsOnlyRoleId: string;

  beforeAll(async () => {
    newsOnlyRoleId = await createTempRole(NEWS_ONLY, NEWS_ONLY_PERMISSIONS);
    for (const role of ROLES) {
      perms[role] = await rolePermissions(role);
      const user = await createTempUser(role);
      tempIds.push(user.id);
      sessions[role] = user;
    }
  });

  afterAll(async () => {
    for (const id of tempIds) await deleteTempUser(id);
    await deleteTempRole(newsOnlyRoleId);
  });

  it('probes every admin route group in openapi.json', () => {
    const doc = JSON.parse(readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf8'));
    const groups = new Set<string>();
    for (const p of Object.keys(doc.paths)) {
      const rel = p.replace(/^\/(api\/v1\/)?/, '');
      if (rel.startsWith('admin/')) groups.add(rel.split('/').slice(0, 2).join('/'));
    }
    const unprobed = [...groups].filter((g) => !PROBES[g] && !ANY_STAFF.includes(g));
    expect(unprobed).toEqual([]);
  });

  it('the seeded system roles keep what they could do before (editor: content; support: inbox; admin: *)', () => {
    expect(perms.admin).toEqual(['*']);
    expect(perms.editor).toContain('news.delete');
    expect(perms.editor).not.toContain('redirects.delete');
    expect(perms.editor.some((p) => /^(messages|testimonials|newsletter|users|roles|settings|mail|audit)\./.test(p))).toBe(false);
    expect(perms.support.sort()).toEqual(
      ['messages.view', 'messages.manage', 'testimonials.view', 'testimonials.manage', 'testimonials.delete', 'newsletter.view', 'newsletter.delete'].sort(),
    );
  });

  describe.each(ROLES)('%s', (role) => {
    it.each(Object.keys(PROBES))('%s — read', async (group) => {
      const probe = PROBES[group];
      const allowed = can(perms[role], `${probe.module}.view`);
      const res = await api('GET', probe.read, { session: sessions[role] });
      expect({ group, role, status: res.status }).toEqual({ group, role, status: allowed ? (probe.readOk ?? 200) : 403 });
      if (!allowed) expect(res.body?.code).toBe('FORBIDDEN');
    });

    it.each(Object.keys(PROBES).filter((g) => PROBES[g].delete))('%s — delete', async (group) => {
      const probe = PROBES[group];
      const allowed = can(perms[role], `${probe.module}.delete`);
      const res = await api('DELETE', probe.delete!, { session: sessions[role] });
      expect({ group, role, status: res.status }).toEqual({ group, role, status: allowed ? 404 : 403 });
    });

    it('reaches every any-staff route', async () => {
      for (const route of ['/admin/me', '/admin/overview', '/admin/auth/sessions']) {
        expect({ route, status: (await api('GET', route, { session: sessions[role] })).status }).toEqual({ route, status: 200 });
      }
    });
  });

  it('a custom "news only" role reaches news and nothing else', async () => {
    const allowed = Object.keys(PROBES).filter((g) => PROBES[g].module === 'news');
    expect(allowed.sort()).toEqual(['admin/news', 'admin/news-categories', 'admin/preview-token']);
    const session = sessions[NEWS_ONLY];
    expect((await api('GET', '/admin/news', { session })).status).toBe(200);
    expect((await api('GET', '/admin/news-categories', { session })).status).toBe(200);
    for (const group of Object.keys(PROBES).filter((g) => !allowed.includes(g))) {
      const res = await api('GET', PROBES[group].read, { session });
      expect({ group, status: res.status }).toEqual({ group, status: 403 });
    }
  });

  it('an unauthenticated request to any admin group is 401', async () => {
    for (const probe of Object.values(PROBES)) {
      const res = await api('GET', probe.read);
      expect({ path: probe.read, status: res.status }).toEqual({ path: probe.read, status: 401 });
      expect(res.body?.code).toBe('UNAUTHENTICATED');
    }
  });
});
