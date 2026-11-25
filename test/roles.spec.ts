// test/roles.spec.ts — PERM-4: GET admin/permissions, admin/roles CRUD and
// the safety rules of plan A3, one block per rule:
//   1. no escalation — a caller grants only permissions they hold
//   2. nobody edits or deletes their own role (or changes their own)
//   3. assigning a role (invite, user edit) needs every permission it holds;
//      so does managing a user whose role holds more than the caller
//   4. the last usable admin can't be removed
//   5. a role in use can't be deleted (409 ROLE_IN_USE + userCount)
//   6. role writes and user role changes are audited with before/after
//      permission lists
// plus R9 (key rules), R10 (ROLE_IMMUTABLE is 409) and "a role edit applies
// on the next request".

import { adminApi, api, createTempUser, deleteTempUser, loginAs, roleIdOf, withDb, type Session } from './helpers';

type TempUser = Session & { id: string; email: string };

const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

async function makeRole(permissions: string[], key = `jest-${stamp()}`): Promise<{ id: string; key: string; permissions: string[] }> {
  const res = await adminApi('POST', '/admin/roles', { body: { key, nameAr: `دور ${key}`, nameEn: `Role ${key}`, permissions } });
  expect(res.status).toBe(201);
  return res.body;
}

async function dropRole(id: string): Promise<void> {
  await withDb((conn) => conn.execute('DELETE FROM roles WHERE id = ?', [id]));
}

/** AuditInterceptor writes after the response — wait for the row. */
async function auditRow(entityType: string, entityId: string, action: string): Promise<{ diff: any; actor_id: string }> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const [rows]: any = await withDb((conn) =>
      conn.execute('SELECT diff, actor_id FROM audit_log WHERE entity_type = ? AND entity_id = ? AND action = ? ORDER BY id DESC LIMIT 1', [
        entityType,
        entityId,
        action,
      ]),
    );
    if (rows[0]) return { ...rows[0], diff: typeof rows[0].diff === 'string' ? JSON.parse(rows[0].diff) : rows[0].diff };
    if (Date.now() > deadline) throw new Error(`no ${action} audit row for ${entityType} ${entityId}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const MANAGER_PERMISSIONS = ['roles.view', 'roles.manage', 'roles.delete', 'users.view', 'users.manage', 'news.view', 'news.manage'];

describe('roles and permissions API (PERM-4)', () => {
  const userIds: string[] = [];
  const roleIds: string[] = [];
  let managerRole: { id: string; key: string; permissions: string[] };
  let writerRole: { id: string; key: string; permissions: string[] };
  let manager: TempUser;

  const tempUser = async (roleKey: string) => {
    const u = await createTempUser(roleKey);
    userIds.push(u.id);
    return u;
  };

  beforeAll(async () => {
    managerRole = await makeRole(MANAGER_PERMISSIONS);
    writerRole = await makeRole(['news.manage']);
    roleIds.push(managerRole.id, writerRole.id);
    manager = await tempUser(managerRole.key);
  });

  afterAll(async () => {
    for (const id of userIds) await deleteTempUser(id);
    for (const id of roleIds) await dropRole(id);
  });

  describe('GET admin/permissions', () => {
    it('serves the catalog to any signed-in staff member, and to nobody signed out', async () => {
      expect((await api('GET', '/admin/permissions')).status).toBe(401);
      const support = await tempUser('support');
      const res = await api('GET', '/admin/permissions', { session: support });
      expect(res.status).toBe(200);
      expect(res.body.actions).toEqual(['view', 'manage', 'delete']);
      expect(res.body.groups.map((g: { key: string }) => g.key)).toEqual(['content', 'inbox', 'system']);
      const audit = res.body.groups[2].modules.find((m: { key: string }) => m.key === 'audit');
      expect(audit).toEqual({ key: 'audit', labelAr: expect.any(String), labelEn: 'Audit log', actions: ['view'] });
    });
  });

  describe('CRUD', () => {
    it('lists roles with their permissions and user counts; the system roles first', async () => {
      const res = await adminApi('GET', '/admin/roles');
      expect(res.status).toBe(200);
      expect(res.body.slice(0, 3).map((r: { key: string; isSystem: boolean }) => [r.key, r.isSystem])).toEqual([
        ['admin', true],
        ['editor', true],
        ['support', true],
      ]);
      const admin = res.body.find((r: { key: string }) => r.key === 'admin');
      expect(admin.permissions).toEqual(['*']);
      expect(admin.userCount).toBeGreaterThanOrEqual(1);
      const mgr = res.body.find((r: { key: string }) => r.key === managerRole.key);
      expect(mgr.userCount).toBe(1);
      expect((await adminApi('GET', `/admin/roles/${managerRole.id}`)).body.key).toBe(managerRole.key);
      expect((await adminApi('GET', '/admin/roles/999999999')).status).toBe(404);
    });

    it('creates with the permissions closed under delete ⇒ manage ⇒ view, edits, and deletes', async () => {
      const created = await adminApi('POST', '/admin/roles', {
        body: { nameAr: 'مسؤول وثائق', nameEn: 'Documents officer', descriptionAr: 'الوثائق', permissions: ['documents.delete', 'newsletter.delete'] },
      });
      expect(created.status).toBe(201);
      roleIds.push(created.body.id);
      expect(created.body.key).toMatch(/^custom-[0-9a-f]{6}$/);
      expect(created.body).toMatchObject({ isSystem: false, userCount: 0, descriptionAr: 'الوثائق', descriptionEn: null });
      expect(created.body.permissions).toEqual(['documents.view', 'documents.manage', 'documents.delete', 'newsletter.view', 'newsletter.delete']);

      const edited = await adminApi('PATCH', `/admin/roles/${created.body.id}`, { body: { nameEn: 'Docs officer', permissions: ['documents.view'] } });
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({ key: created.body.key, nameAr: 'مسؤول وثائق', nameEn: 'Docs officer', permissions: ['documents.view'] });
      expect((await adminApi('PATCH', `/admin/roles/${created.body.id}`, { body: { key: 'renamed' } })).status).toBe(400);

      expect((await adminApi('DELETE', `/admin/roles/${created.body.id}`)).status).toBe(200);
      expect((await adminApi('GET', `/admin/roles/${created.body.id}`)).status).toBe(404);
    });

    it('R9: refuses a malformed or reserved key, a duplicate key, unknown permissions and the wildcard', async () => {
      const post = (body: object) => adminApi('POST', '/admin/roles', { body: { nameAr: 'دور', permissions: [], ...body } });
      for (const key of ['A-role', 'ab', '1role', 'has space', 'x'.repeat(65)]) {
        expect({ key, status: (await post({ key })).status }).toEqual({ key, status: 400 });
      }
      for (const key of ['admin', 'editor', 'support', 'owner', 'root', 'system']) {
        expect({ key, status: (await post({ key })).status }).toEqual({ key, status: 400 });
      }
      const dup = await post({ key: managerRole.key });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('ROLE_KEY_TAKEN');
      expect((await post({ permissions: ['news.publish'] })).status).toBe(400);
      expect((await post({ permissions: ['audit.delete'] })).status).toBe(400);
      expect((await post({ permissions: ['*'] })).status).toBe(400);
    });

    it('R10: the admin role is never changed or deleted, a system role never deleted — always 409 ROLE_IMMUTABLE', async () => {
      const adminId = await roleIdOf('admin');
      const editorId = await roleIdOf('editor');
      for (const res of [
        await adminApi('PATCH', `/admin/roles/${adminId}`, { body: { nameEn: 'Boss' } }),
        await adminApi('DELETE', `/admin/roles/${adminId}`),
        await adminApi('DELETE', `/admin/roles/${editorId}`),
      ]) {
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'ROLE_IMMUTABLE' });
      }
      // editor/support stay editable (names here; restored).
      const before = (await adminApi('GET', `/admin/roles/${editorId}`)).body;
      expect((await adminApi('PATCH', `/admin/roles/${editorId}`, { body: { nameEn: 'Content editor' } })).body.nameEn).toBe('Content editor');
      await adminApi('PATCH', `/admin/roles/${editorId}`, { body: { nameEn: before.nameEn } });
    });

    it('needs roles.view / roles.manage / roles.delete', async () => {
      const editor = await tempUser('editor');
      expect((await api('GET', '/admin/roles', { session: editor })).status).toBe(403);
      expect((await api('POST', '/admin/roles', { session: editor, body: { nameAr: 'x', permissions: [] } })).status).toBe(403);
    });
  });

  describe('rule 1: no escalation', () => {
    it('grants only permissions the caller holds', async () => {
      const tooMuch = await api('POST', '/admin/roles', { session: manager, body: { nameAr: 'تصعيد', permissions: ['news.view', 'settings.view'] } });
      expect(tooMuch.status).toBe(403);
      // news.delete implies nothing the manager lacks except itself — still refused.
      expect((await api('POST', '/admin/roles', { session: manager, body: { nameAr: 'تصعيد', permissions: ['news.delete'] } })).status).toBe(403);

      const ok = await api('POST', '/admin/roles', { session: manager, body: { nameAr: 'كاتب', permissions: ['news.manage'] } });
      expect(ok.status).toBe(201);
      roleIds.push(ok.body.id);
      expect((await api('PATCH', `/admin/roles/${ok.body.id}`, { session: manager, body: { permissions: ['news.manage', 'users.delete'] } })).status).toBe(403);
    });

    it("can't edit or delete a role holding permissions the caller lacks", async () => {
      const editorId = await roleIdOf('editor');
      expect((await api('PATCH', `/admin/roles/${editorId}`, { session: manager, body: { nameEn: 'x' } })).status).toBe(403);
      const wide = await makeRole(['settings.view']);
      roleIds.push(wide.id);
      expect((await api('DELETE', `/admin/roles/${wide.id}`, { session: manager })).status).toBe(403);
    });
  });

  describe('rule 2: not your own role', () => {
    it('refuses editing or deleting the caller’s own role, and changing their own role', async () => {
      expect((await api('PATCH', `/admin/roles/${managerRole.id}`, { session: manager, body: { nameEn: 'x' } })).status).toBe(403);
      expect((await api('DELETE', `/admin/roles/${managerRole.id}`, { session: manager })).status).toBe(403);
      expect((await api('PATCH', `/admin/users/${manager.id}`, { session: manager, body: { roleId: writerRole.id } })).status).toBe(403);
      const me = (await adminApi('GET', '/admin/me')).body;
      const self = await adminApi('PATCH', `/admin/users/${me.id}`, { body: { roleId: await roleIdOf('editor') } });
      expect(self.status).toBe(403);
    });
  });

  describe('rule 3: assigning roles and managing users', () => {
    it('assignable-roles lists only roles the caller covers', async () => {
      const res = await api('GET', '/admin/users/assignable-roles', { session: manager });
      expect(res.status).toBe(200);
      const keys = res.body.map((r: { key: string }) => r.key);
      expect(keys).toEqual(expect.arrayContaining([managerRole.key, writerRole.key]));
      for (const k of ['admin', 'editor', 'support']) expect(keys).not.toContain(k);
      expect(Object.keys(res.body[0]).sort()).toEqual(['id', 'key', 'nameAr', 'nameEn']);
      const all = (await adminApi('GET', '/admin/users/assignable-roles')).body.map((r: { key: string }) => r.key);
      expect(all).toEqual(expect.arrayContaining(['admin', 'editor', 'support', managerRole.key]));
    });

    it('invites only with a covered role', async () => {
      const email = () => `jest-inv-${stamp()}@example.com`;
      const refused = await api('POST', '/admin/auth/invite', { session: manager, body: { email: email(), name: 'Invitee', roleId: await roleIdOf('editor') } });
      expect(refused.status).toBe(403);
      const ok = await api('POST', '/admin/auth/invite', { session: manager, body: { email: email(), name: 'Invitee', roleId: writerRole.id } });
      expect(ok.status).toBe(201);
      userIds.push(ok.body.id);
      expect(ok.body.role).toEqual({ id: writerRole.id, key: writerRole.key, nameAr: expect.any(String), nameEn: expect.any(String) });
    });

    it('creates an active user with an admin-set password, no mail, only with a covered role', async () => {
      const email = `jest-new-${stamp()}@example.com`;
      const password = `Pw-${stamp()}-long`;
      const body = { email, name: 'Created Person', roleId: writerRole.id, password };
      expect((await api('POST', '/admin/users', { session: manager, body: { ...body, roleId: await roleIdOf('editor') } })).status).toBe(403);
      expect((await api('POST', '/admin/users', { session: manager, body: { ...body, password: 'short' } })).status).toBe(400);

      const ok = await api('POST', '/admin/users', { session: manager, body });
      expect(ok.status).toBe(201);
      userIds.push(ok.body.id);
      expect(ok.body).toMatchObject({ email, name: 'Created Person', status: 'active', role: { id: writerRole.id, key: writerRole.key } });
      expect(JSON.stringify(ok.body)).not.toContain(password);
      expect((await api('POST', '/admin/users', { session: manager, body })).status).toBe(409);

      // No invitation token was issued, and the new user signs in with that password.
      const [tokens]: any = await withDb((conn) => conn.execute('SELECT id FROM auth_tokens WHERE user_id = ?', [ok.body.id]));
      expect(tokens).toHaveLength(0);
      const session = await loginAs(email, password);
      expect((await api('GET', '/admin/me', { session })).body.email).toBe(email);

      const row = await auditRow('users', ok.body.id, 'create');
      expect(JSON.stringify(row.diff)).not.toContain(password);
    });

    it("can't assign an uncovered role, nor manage a user whose role holds more than the caller", async () => {
      const writer = await tempUser(writerRole.key);
      expect((await api('PATCH', `/admin/users/${writer.id}`, { session: manager, body: { roleId: await roleIdOf('editor') } })).status).toBe(403);
      const moved = await api('PATCH', `/admin/users/${writer.id}`, { session: manager, body: { roleId: managerRole.id } });
      expect(moved.status).toBe(200);
      expect(moved.body.role.key).toBe(managerRole.key);

      const admin = await tempUser('admin');
      expect((await api('PATCH', `/admin/users/${admin.id}`, { session: manager, body: { status: 'disabled' } })).status).toBe(403);
      expect((await api('DELETE', `/admin/users/${admin.id}`, { session: manager })).status).toBe(403);
      const editor = await tempUser('editor');
      expect((await api('PATCH', `/admin/users/${editor.id}`, { session: manager, body: { name: 'Renamed' } })).status).toBe(403);
    });

    it('ends another user’s session only when the caller covers that user’s role (R7)', async () => {
      const admin = await tempUser('admin');
      const writer = await tempUser(writerRole.key);
      const sessionOf = async (userId: string) => {
        const [rows]: any = await withDb((conn) => conn.execute('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1', [userId]));
        return String(rows[0].id);
      };
      expect((await api('DELETE', `/admin/auth/sessions/${await sessionOf(admin.id)}`, { session: manager })).status).toBe(403);
      expect((await api('DELETE', `/admin/auth/sessions/${await sessionOf(writer.id)}`, { session: manager })).status).toBe(200);
      expect((await api('GET', '/admin/me', { session: writer })).status).toBe(401);
    });
  });

  describe('rule 4: the last usable admin', () => {
    it('the only active admin cannot disable themselves (409 LAST_ADMIN)', async () => {
      const last = await tempUser('admin');
      const [others]: any = await withDb((conn) =>
        conn.execute(
          "SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.role_key = 'admin' AND u.status = 'active' AND u.id <> ?",
          [last.id],
        ),
      );
      const ids: string[] = others.map((r: { id: number }) => String(r.id));
      try {
        if (ids.length) await withDb((conn) => conn.query("UPDATE users SET status = 'disabled' WHERE id IN (?)", [ids]));
        const res = await api('PATCH', `/admin/users/${last.id}`, { session: last, body: { status: 'disabled' } });
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'LAST_ADMIN' });
      } finally {
        if (ids.length) await withDb((conn) => conn.query("UPDATE users SET status = 'active' WHERE id IN (?)", [ids]));
      }
    });
  });

  describe('rule 5: a role in use', () => {
    it('cannot be deleted while assigned — 409 ROLE_IN_USE with the count', async () => {
      const role = await makeRole(['partners.view']);
      roleIds.push(role.id);
      const holder = await tempUser(role.key);
      const res = await adminApi('DELETE', `/admin/roles/${role.id}`);
      expect({ status: res.status, code: res.body.code, userCount: res.body.userCount }).toEqual({ status: 409, code: 'ROLE_IN_USE', userCount: 1 });
      await deleteTempUser(holder.id);
      expect((await adminApi('DELETE', `/admin/roles/${role.id}`)).status).toBe(200);
    });
  });

  describe('rule 6: audit', () => {
    it('writes role create/update/delete with before/after permission lists', async () => {
      const role = await makeRole(['stats.view']);
      const created = await auditRow('roles', role.id, 'create');
      expect(created.diff.after.permissions).toEqual(['stats.view']);

      await adminApi('PATCH', `/admin/roles/${role.id}`, { body: { permissions: ['stats.manage'] } });
      const updated = await auditRow('roles', role.id, 'update');
      expect(updated.diff.before.permissions).toEqual(['stats.view']);
      expect(updated.diff.after.permissions).toEqual(['stats.view', 'stats.manage']);

      await adminApi('DELETE', `/admin/roles/${role.id}`);
      const deleted = await auditRow('roles', role.id, 'delete');
      expect(deleted.diff.before.permissions).toEqual(['stats.view', 'stats.manage']);
    });

    it('writes a user role change with the permission lists before and after', async () => {
      const writer = await tempUser(writerRole.key);
      expect((await adminApi('PATCH', `/admin/users/${writer.id}`, { body: { roleId: await roleIdOf('support') } })).status).toBe(200);
      const row = await auditRow('users', writer.id, 'update');
      expect(row.diff.before.role.key).toBe(writerRole.key);
      expect(row.diff.before.permissions).toEqual(['news.view', 'news.manage']);
      expect(row.diff.after.role.key).toBe('support');
      expect(row.diff.after.permissions).toContain('messages.view');
      const [legacy]: any = await withDb((conn) => conn.execute('SELECT role FROM users WHERE id = ?', [writer.id]));
      expect(legacy[0].role).toBe('support'); // kept in step for the rollback window (024)
    });
  });

  it('a role edit applies on the holder’s next request — no re-login', async () => {
    const role = await makeRole(['news.view']);
    roleIds.push(role.id);
    const holder = await tempUser(role.key);
    expect((await api('GET', '/admin/partners', { session: holder })).status).toBe(403);
    await adminApi('PATCH', `/admin/roles/${role.id}`, { body: { permissions: ['news.view', 'partners.view'] } });
    expect((await api('GET', '/admin/partners', { session: holder })).status).toBe(200);
    expect((await api('GET', '/admin/me', { session: holder })).body.permissions).toEqual(['news.view', 'partners.view']);
  });
});
