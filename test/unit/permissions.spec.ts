// PERM-2: the permission catalog and its helpers (src/auth/permissions.ts).
import 'reflect-metadata';
import { ALL_PERMISSIONS, can, isPermissionKey, isSubset, normalisePermissions, permissionCatalog, splitPermission } from '../../src/auth/permissions';
import { ProblemException } from '../../src/common/problem-details/problem.exception';

describe('permission catalog (PERM-2)', () => {
  it('has the modules of plan A1, in their three groups, with only the actions their routes have', () => {
    const catalog = permissionCatalog();
    expect(catalog.groups.map((g) => [g.key, g.modules.map((m) => m.key)])).toEqual([
      ['content', ['pages', 'news', 'workAreas', 'board', 'orgChart', 'partners', 'documents', 'licences', 'stats', 'aboutItems', 'media', 'redirects']],
      ['inbox', ['messages', 'testimonials', 'newsletter']],
      ['system', ['users', 'roles', 'settings', 'mail', 'audit']],
    ]);
    const actions = Object.fromEntries(catalog.groups.flatMap((g) => g.modules.map((m) => [m.key, m.actions])));
    expect(actions.audit).toEqual(['view']);
    expect(actions.mail).toEqual(['view', 'manage']);
    expect(actions.newsletter).toEqual(['view', 'delete']);
    expect(actions.news).toEqual(['view', 'manage', 'delete']);
    for (const g of catalog.groups) {
      expect(g.labelAr).toBeTruthy();
      for (const m of g.modules) expect([m.labelAr, m.labelEn].every(Boolean)).toBe(true);
    }
  });

  it('knows its own keys and nothing else', () => {
    expect(ALL_PERMISSIONS).toContain('news.manage');
    expect(isPermissionKey('news.manage')).toBe(true);
    expect(isPermissionKey('audit.delete')).toBe(false);
    expect(isPermissionKey('*')).toBe(false);
    expect(splitPermission('workAreas.delete')).toEqual({ module: 'workAreas', action: 'delete' });
    expect(splitPermission('nope.view')).toBeUndefined();
  });

  describe('normalisePermissions', () => {
    it('closes delete ⇒ manage ⇒ view, dedupes and keeps catalog order', () => {
      expect(normalisePermissions(['news.delete', 'pages.manage', 'news.view'])).toEqual(['pages.view', 'pages.manage', 'news.view', 'news.manage', 'news.delete']);
    });

    it('only implies actions the module has', () => {
      expect(normalisePermissions(['newsletter.delete'])).toEqual(['newsletter.view', 'newsletter.delete']);
      expect(normalisePermissions(['mail.manage'])).toEqual(['mail.view', 'mail.manage']);
    });

    it('accepts an empty set', () => {
      expect(normalisePermissions([])).toEqual([]);
    });

    it('refuses unknown keys, the wildcard and actions a module lacks — all in one 400', () => {
      let err: unknown;
      try {
        normalisePermissions(['news.view', 'audit.delete', '*', 'bogus']);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ProblemException);
      expect((err as ProblemException).getStatus()).toBe(400);
      expect((err as ProblemException).message + JSON.stringify((err as ProblemException).getResponse())).toMatch(/audit\.delete.*\*.*bogus/);
    });
  });

  it('can(): the wildcard holds everything, otherwise an exact match', () => {
    expect(can(new Set(['*']), 'users.delete')).toBe(true);
    expect(can(['news.view'], 'news.view')).toBe(true);
    expect(can(['news.view'], 'news.manage')).toBe(false);
  });

  it('isSubset(): no escalation — a wildcard target needs a wildcard caller', () => {
    expect(isSubset(['*'], ['*'])).toBe(true);
    expect(isSubset(['*'], ['news.view'])).toBe(true);
    expect(isSubset(['news.view', 'news.manage'], ['news.view'])).toBe(true);
    expect(isSubset(['news.view'], ['news.view', 'news.manage'])).toBe(false);
    expect(isSubset(ALL_PERMISSIONS, ['*'])).toBe(false);
    expect(isSubset([], [])).toBe(true);
  });
});
