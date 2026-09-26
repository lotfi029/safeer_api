// test/migrate.spec.ts — the migration runner (C29, C11, C9) against scratch
// databases and a scratch migrations directory (MIGRATIONS_DIR), so these
// cases never touch the suite's own database or the real migrations/.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dbEnv, dropDatabase, recreateDatabase, runScript, withServer } from './scripts.helpers';

const DB = `${process.env.TEST_DB_NAME}_migrate`;

let dir: string;

function writeMigrations(files: Record<string, string>) {
  for (const [name, sql] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), sql);
  }
}

function migrate(overrides: Record<string, string | undefined> = {}, args: string[] = []) {
  return runScript('scripts/migrate.mjs', dbEnv(DB, { MIGRATIONS_DIR: dir, ...overrides }), args);
}

async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withServer(async (conn) => (await conn.query(sql, params))[0] as T[], DB);
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'safeer-migrate-'));
  writeMigrations({
    '001_schema.sql': 'CREATE TABLE t1 (id INT PRIMARY KEY, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3));',
    '002_seed.sql': 'INSERT INTO t1 (id) VALUES (1);',
    'dev/003_dev_sample.sql': 'INSERT INTO t1 (id) VALUES (3);',
  });
  await recreateDatabase(DB);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await dropDatabase(DB);
});

describe('scripts/migrate.mjs', () => {
  it('applies every file once, records a sha256 checksum per file, and a second run is a no-op', async () => {
    const first = migrate();
    expect(first.status).toBe(0);
    const rows = await query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version');
    expect(rows.map((r) => r.version)).toEqual(['001_schema.sql', '002_seed.sql', '003_dev_sample.sql']);
    for (const row of rows) expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);

    const second = migrate();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('Nothing to migrate');
    expect(await query('SELECT id FROM t1 ORDER BY id')).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('hashes CRLF and LF checkouts of the same file identically', async () => {
    writeMigrations({ '001_schema.sql': 'CREATE TABLE t1 (id INT PRIMARY KEY,\n  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3));\n' });
    expect(migrate().status).toBe(0);
    writeMigrations({ '001_schema.sql': 'CREATE TABLE t1 (id INT PRIMARY KEY,\r\n  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3));\r\n' });
    const again = migrate();
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('Nothing to migrate');
  });

  it('fails before applying anything when an applied file was edited, naming the file', async () => {
    expect(migrate().status).toBe(0);
    writeMigrations({ '002_seed.sql': 'INSERT INTO t1 (id) VALUES (2);', '004_new.sql': 'INSERT INTO t1 (id) VALUES (4);' });
    const result = migrate();
    expect(result.status).toBe(1);
    expect(result.output).toContain('Checksum mismatch');
    expect(result.output).toContain('002_seed.sql');
    expect(await query("SELECT version FROM schema_migrations WHERE version = '004_new.sql'")).toHaveLength(0);
  });

  it('backfills checksums on a database migrated by the old runner (no checksum column) without re-applying', async () => {
    await withServer(async (conn) => {
      await conn.query(`
        CREATE TABLE schema_migrations (version VARCHAR(255) NOT NULL, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (version));
        CREATE TABLE t1 (id INT PRIMARY KEY, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3));
        INSERT INTO t1 (id) VALUES (1), (3);
        INSERT INTO schema_migrations (version) VALUES ('001_schema.sql'), ('002_seed.sql'), ('003_dev_sample.sql');`);
    }, DB);

    const status = migrate({}, ['--status']);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('no checksum yet');

    const result = migrate();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Recorded checksum for already-applied 001_schema.sql');
    const rows = await query<{ checksum: string | null }>('SELECT checksum FROM schema_migrations');
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum ?? ''))).toBe(true);
    expect(await query('SELECT id FROM t1 ORDER BY id')).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it("waits for GET_LOCK('safeer_migrate') and gives up when another run holds it", async () => {
    await withServer(async (conn) => {
      const [[held]]: any = await conn.query("SELECT GET_LOCK('safeer_migrate', 0) AS got");
      expect(Number(held.got)).toBe(1);
      const blocked = migrate({ MIGRATE_LOCK_TIMEOUT_SECONDS: '1' });
      expect(blocked.status).toBe(1);
      expect(blocked.output).toContain('another migrate run is in progress');
      await conn.query("SELECT RELEASE_LOCK('safeer_migrate')");
    });
    expect(migrate().status).toBe(0);
  });

  it('reports a failed file as not recorded and points at the recovery steps', async () => {
    writeMigrations({ '004_broken.sql': 'INSERT INTO no_such_table VALUES (1);' });
    const result = migrate();
    expect(result.status).toBe(1);
    expect(result.output).toContain('004_broken.sql failed');
    expect(result.output).toContain('Recovering from a half-applied migration');
    expect(await query("SELECT version FROM schema_migrations WHERE version = '004_broken.sql'")).toHaveLength(0);
  });

  it('runs in UTC (C9): CURRENT_TIMESTAMP defaults match UTC_TIMESTAMP()', async () => {
    expect(migrate().status).toBe(0);
    const [row] = await query<{ drift: number }>(
      'SELECT ABS(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), created_at)) AS drift FROM t1 WHERE id = 1',
    );
    expect(Number(row.drift)).toBeLessThan(60);
  });

  describe('NODE_ENV (C11) and credentials (C29)', () => {
    it('rejects a NODE_ENV that src/config/env.ts would not accept', () => {
      const result = migrate({ NODE_ENV: 'prod' });
      expect(result.status).toBe(1);
      expect(result.output).toContain('NODE_ENV must be one of');
    });

    it('rejects a missing NODE_ENV', () => {
      const result = migrate({ NODE_ENV: undefined });
      expect(result.status).toBe(1);
      expect(result.output).toContain('NODE_ENV must be one of');
    });

    it('staging and production require MIGRATION_DB_USER instead of falling back to DB_USER', () => {
      for (const nodeEnv of ['staging', 'production']) {
        const result = migrate({ NODE_ENV: nodeEnv });
        expect(result.status).toBe(1);
        expect(result.output).toContain('MIGRATION_DB_USER / MIGRATION_DB_PASSWORD are required');
      }
    });

    it.each(['staging', 'production'])('%s skips migrations/dev/ fixtures', async (nodeEnv) => {
      const result = migrate({
        NODE_ENV: nodeEnv,
        MIGRATION_DB_USER: process.env.TEST_DB_USER,
        MIGRATION_DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? '',
        DB_USER: 'app_user_without_ddl',
      });
      expect(result.status).toBe(0);
      const versions = (await query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version);
      expect(versions).toEqual(['001_schema.sql', '002_seed.sql']);
    });

    it('development and test include migrations/dev/ fixtures', async () => {
      expect(migrate({ NODE_ENV: 'development' }).status).toBe(0);
      expect(await query("SELECT version FROM schema_migrations WHERE version = '003_dev_sample.sql'")).toHaveLength(1);
    });
  });
});
