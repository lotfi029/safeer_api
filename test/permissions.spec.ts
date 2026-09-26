// test/permissions.spec.ts — Phase 7 (safeer-backend-fix-prompt.md), area 1.
//
// Generated from GET admin/roles (B17): for every role × every admin route
// group, the expected answer comes from the live matrix, never from a copy
// of it here. Each group names its area once; a read probe answers 200 or
// 403, and a delete probe on an id that doesn't exist answers 404 (allowed,
// nothing there) or 403 (refused before the lookup). A coverage check fails
// if openapi.json gains an admin route group this file doesn't probe.
// Also: the unauthenticated 401, and staff/applicant cookies never accepted
// on each other's routes.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { adminApi, api, createApplication, createTempUser, deleteApplication, deleteTempUser, type Session, type StaffRole } from './helpers';

const MISSING_ID = '999999999';

interface Probe {
  area: string;
  read: string;
  /** The group's DELETE, with the area that gates it (often a stricter `*.delete` one). */
  delete?: { path: string; area: string };
}

const PROBES: Record<string, Probe> = {
  'admin/applications': { area: 'applications', read: '/admin/applications', delete: { path: `/admin/applications/${MISSING_ID}`, area: 'applications.delete' } },
  'admin/interview-slots': { area: 'applications', read: '/admin/interview-slots', delete: { path: `/admin/interview-slots/${MISSING_ID}`, area: 'applications' } },

  'admin/pages': { area: 'content', read: '/admin/pages', delete: { path: `/admin/pages/${MISSING_ID}`, area: 'content' } },
  'admin/page-sections': { area: 'content', read: '/admin/page-sections', delete: { path: `/admin/page-sections/${MISSING_ID}`, area: 'content' } },
  'admin/news': { area: 'content', read: '/admin/news', delete: { path: `/admin/news/${MISSING_ID}`, area: 'content' } },
  'admin/news-categories': { area: 'content', read: '/admin/news-categories', delete: { path: `/admin/news-categories/${MISSING_ID}`, area: 'content' } },
  'admin/work-areas': { area: 'content', read: '/admin/work-areas', delete: { path: `/admin/work-areas/${MISSING_ID}`, area: 'content' } },
  'admin/work-area-items': { area: 'content', read: '/admin/work-area-items', delete: { path: `/admin/work-area-items/${MISSING_ID}`, area: 'content' } },
  'admin/board': { area: 'content', read: '/admin/board', delete: { path: `/admin/board/${MISSING_ID}`, area: 'content' } },
  'admin/stats': { area: 'content', read: '/admin/stats', delete: { path: `/admin/stats/${MISSING_ID}`, area: 'content' } },
  'admin/about-items': { area: 'content', read: '/admin/about-items', delete: { path: `/admin/about-items/${MISSING_ID}`, area: 'content' } },
  'admin/partners': { area: 'content', read: '/admin/partners', delete: { path: `/admin/partners/${MISSING_ID}`, area: 'content' } },
  'admin/doc-categories': { area: 'content', read: '/admin/doc-categories', delete: { path: `/admin/doc-categories/${MISSING_ID}`, area: 'content' } },
  'admin/documents': { area: 'content', read: '/admin/documents', delete: { path: `/admin/documents/${MISSING_ID}`, area: 'content' } },
  'admin/media': { area: 'content', read: '/admin/media', delete: { path: `/admin/media/${MISSING_ID}`, area: 'content' } },
  'admin/redirects': { area: 'content', read: '/admin/redirects', delete: { path: `/admin/redirects/${MISSING_ID}`, area: 'redirects.delete' } },

  'admin/messages': { area: 'inbox', read: '/admin/messages', delete: { path: `/admin/messages/${MISSING_ID}`, area: 'inbox.delete' } },
  'admin/testimonials': { area: 'inbox', read: '/admin/testimonials', delete: { path: `/admin/testimonials/${MISSING_ID}`, area: 'inbox' } },
  'admin/testimonial-themes': { area: 'inbox', read: '/admin/testimonial-themes', delete: { path: `/admin/testimonial-themes/${MISSING_ID}`, area: 'inbox' } },
  'admin/newsletter': { area: 'inbox', read: '/admin/newsletter', delete: { path: `/admin/newsletter/${MISSING_ID}`, area: 'inbox' } },

  'admin/users': { area: 'users', read: '/admin/users', delete: { path: `/admin/users/${MISSING_ID}`, area: 'users' } },
  'admin/settings': { area: 'settings', read: '/admin/settings' },
  'admin/mail': { area: 'settings', read: '/admin/mail/settings' },
  'admin/sms': { area: 'settings', read: '/admin/sms/settings' },
  'admin/cache': { area: 'settings', read: '/admin/cache/stats' },
  'admin/audit': { area: 'audit', read: '/admin/audit' },
};

/** Open to any signed-in staff member, with no area (scripts/lib/check-admin-roles.mjs's allow-list). */
const ANY_STAFF = ['admin/me', 'admin/auth', 'admin/overview', 'admin/preview-token', 'admin/roles'];

const ROLES: StaffRole[] = ['admin', 'reviewer', 'editor', 'support'];

describe('permissions matrix (generated from GET admin/roles)', () => {
  const sessions = {} as Record<StaffRole, Session>;
  const tempIds: string[] = [];
  let matrix: Record<string, StaffRole[]>;

  beforeAll(async () => {
    const roles = await adminApi('GET', '/admin/roles');
    expect(roles.status).toBe(200);
    matrix = roles.body.matrix;
    for (const role of ROLES) {
      const user = await createTempUser(role);
      tempIds.push(user.id);
      sessions[role] = user;
    }
  });

  afterAll(async () => {
    for (const id of tempIds) await deleteTempUser(id);
  });

  it('probes every admin route group in openapi.json, each under an area the matrix knows', () => {
    const doc = JSON.parse(readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf8'));
    const groups = new Set<string>();
    for (const p of Object.keys(doc.paths)) {
      const rel = p.replace(/^\/(api\/v1\/)?/, '');
      if (rel.startsWith('admin/')) groups.add(rel.split('/').slice(0, 2).join('/'));
    }
    const unprobed = [...groups].filter((g) => !PROBES[g] && !ANY_STAFF.includes(g));
    expect(unprobed).toEqual([]);
    for (const probe of Object.values(PROBES)) {
      expect(Object.keys(matrix)).toContain(probe.area);
      if (probe.delete) expect(Object.keys(matrix)).toContain(probe.delete.area);
    }
    expect(Object.keys(matrix).sort()).toEqual(
      [...new Set(Object.values(PROBES).flatMap((p) => [p.area, ...(p.delete ? [p.delete.area] : [])]))].sort(),
    );
  });

  describe.each(ROLES)('%s', (role) => {
    it.each(Object.keys(PROBES))('%s — read', async (group) => {
      const probe = PROBES[group];
      const allowed = matrix[probe.area].includes(role);
      const res = await api('GET', probe.read, { session: sessions[role] });
      expect({ group, role, status: res.status }).toEqual({ group, role, status: allowed ? 200 : 403 });
      if (!allowed) expect(res.body?.code).toBe('FORBIDDEN');
    });

    it.each(Object.keys(PROBES).filter((g) => PROBES[g].delete))('%s — delete', async (group) => {
      const { path: deletePath, area } = PROBES[group].delete!;
      const allowed = matrix[area].includes(role);
      const res = await api('DELETE', deletePath, { session: sessions[role] });
      expect({ group, role, status: res.status }).toEqual({ group, role, status: allowed ? 404 : 403 });
    });

    it('reaches every any-staff route', async () => {
      for (const route of ['/admin/me', '/admin/overview', '/admin/roles', '/admin/auth/sessions']) {
        expect({ route, status: (await api('GET', route, { session: sessions[role] })).status }).toEqual({ route, status: 200 });
      }
    });
  });

  it('an unauthenticated request to any admin group is 401', async () => {
    for (const probe of Object.values(PROBES)) {
      const res = await api('GET', probe.read);
      expect({ path: probe.read, status: res.status }).toEqual({ path: probe.read, status: 401 });
      expect(res.body?.code).toBe('UNAUTHENTICATED');
    }
  });

  it('a staff cookie is refused on a portal (applicant) route, and vice versa', async () => {
    const applicant = await createApplication();
    try {
      for (const role of ROLES) {
        expect((await api('GET', '/portal/me', { session: sessions[role] })).status).toBe(401);
      }
      expect((await api('GET', '/admin/applications', { session: applicant })).status).toBe(401);
      expect((await api('GET', '/admin/me', { session: applicant })).status).toBe(401);
    } finally {
      await deleteApplication(applicant.id);
    }
  });
});
