// test/migration-024.spec.ts — feat/custom-roles (PERM-1): 024 on a database
// that was in use before it (migrated through 023 with the dev fixtures,
// then given staff accounts of each role):
//   - every user gets the role_id of the system role their enum named;
//   - the system roles hold exactly the permissions today's matrix gave;
//   - users.role is kept (expand-only, NULL-able now) so the previous image
//     still runs if it has to be rolled back.

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, dbEnv, dropDatabase, recreateDatabase, runScript, withServer } from './scripts.helpers';

const APP_ENV: Record<string, string> = JSON.parse(process.env.TEST_APP_ENV ?? '{}');
const DB = `${process.env.TEST_DB_NAME}_m024`;

async function rows<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withServer(async (conn) => {
    const [r]: any = await conn.query(sql, params);
    return r as T[];
  }, DB);
}

const CONTENT = ['pages', 'news', 'workAreas', 'board', 'orgChart', 'partners', 'documents', 'licences', 'stats', 'aboutItems', 'media', 'redirects'];
const EDITOR = CONTENT.flatMap((m) => (m === 'redirects' ? [`${m}.view`, `${m}.manage`] : [`${m}.view`, `${m}.manage`, `${m}.delete`])).sort();
const SUPPORT = ['messages.view', 'messages.manage', 'testimonials.view', 'testimonials.manage', 'testimonials.delete', 'newsletter.view', 'newsletter.delete'].sort();

describe('024_roles_permissions on a database in use', () => {
  let dir: string;

  afterAll(async () => {
    await dropDatabase(DB);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('backfills role_id from the enum, seeds the system roles 1:1 and keeps users.role', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'safeer-m024-'));
    mkdirSync(path.join(dir, 'dev'));
    const all = readdirSync(path.join(ROOT, 'migrations')).filter((f) => /^\d{3}_.*\.(sql|mjs)$/.test(f));
    for (const f of all.filter((f) => f < '024')) copyFileSync(path.join(ROOT, 'migrations', f), path.join(dir, f));
    for (const f of readdirSync(path.join(ROOT, 'migrations/dev'))) copyFileSync(path.join(ROOT, 'migrations/dev', f), path.join(dir, 'dev', f));
    await recreateDatabase(DB);
    const env = dbEnv(DB, { MIGRATIONS_DIR: dir, APP_ENCRYPTION_KEY: APP_ENV.APP_ENCRYPTION_KEY, STORAGE_ROOT: path.join(dir, 'assets') });
    expect(runScript('scripts/migrate.mjs', env).status).toBe(0);

    await withServer(
      (conn) =>
        conn.query(
          `INSERT INTO users (name, email, password_hash, role, status) VALUES
             ('M024 admin', 'm024-admin@example.com', 'x', 'admin', 'active'),
             ('M024 editor', 'm024-editor@example.com', 'x', 'editor', 'disabled'),
             ('M024 support', 'm024-support@example.com', 'x', 'support', 'invited')`,
        ),
      DB,
    );

    copyFileSync(path.join(ROOT, 'migrations/024_roles_permissions.sql'), path.join(dir, '024_roles_permissions.sql'));
    const applied = runScript('scripts/migrate.mjs', env);
    expect(applied.output).not.toContain('failed');
    expect(applied.status).toBe(0);

    // Every user — the three above and any the fixtures had — carries the role its enum named.
    const mismatched = await rows('SELECT u.email FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE r.role_key IS NULL OR r.role_key <> u.role');
    expect(mismatched).toEqual([]);
    const mine = await rows<{ email: string; role_key: string }>(
      "SELECT u.email, r.role_key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email LIKE 'm024-%' ORDER BY u.email",
    );
    expect(mine).toEqual([
      { email: 'm024-admin@example.com', role_key: 'admin' },
      { email: 'm024-editor@example.com', role_key: 'editor' },
      { email: 'm024-support@example.com', role_key: 'support' },
    ]);

    const perms = async (key: string) =>
      (await rows<{ permission: string }>('SELECT p.permission FROM role_permissions p JOIN roles r ON r.id = p.role_id WHERE r.role_key = ?', [key]))
        .map((r) => r.permission)
        .sort();
    expect(await perms('admin')).toEqual(['*']);
    expect(await perms('editor')).toEqual(EDITOR);
    expect(await perms('support')).toEqual(SUPPORT);
    expect(await rows('SELECT role_key, is_system FROM roles ORDER BY id')).toEqual([
      { role_key: 'admin', is_system: 1 },
      { role_key: 'editor', is_system: 1 },
      { role_key: 'support', is_system: 1 },
    ]);

    const columns = await rows<{ c: string; n: string; t: string }>(
      "SELECT column_name AS c, is_nullable AS n, column_type AS t FROM information_schema.columns WHERE table_schema = ? AND table_name = 'users' AND column_name IN ('role', 'role_id') ORDER BY column_name",
      [DB],
    );
    expect(columns).toEqual([
      { c: 'role', n: 'YES', t: "enum('admin','editor','support')" },
      { c: 'role_id', n: 'NO', t: 'bigint unsigned' },
    ]);

    // A role still held by a user can't be deleted underneath it.
    await expect(withServer((conn) => conn.query("DELETE FROM roles WHERE role_key = 'editor'"), DB)).rejects.toThrow(/foreign key/i);

    expect(runScript('scripts/migrate.mjs', env).stdout).toContain('Nothing to migrate');
  }, 120_000);
});
