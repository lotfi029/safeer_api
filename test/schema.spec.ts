// test/schema.spec.ts — C44: the real migrations, run the way production
// runs them, against a scratch database; `npm run schema:check` against the
// result; and proof that schema:check actually catches drift.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, dbEnv, dropDatabase, recreateDatabase, runScript, withServer } from './scripts.helpers';

const DB = `${process.env.TEST_DB_NAME}_schema`;

const APP_ENV = {
  APP_ENCRYPTION_KEY: process.env.TEST_APP_ENCRYPTION_KEY,
  BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
  BOOTSTRAP_ADMIN_PASSWORD: 'schema-check-password',
  IP_HASH_SALT: 'schema-check-salt',
  CORS_ORIGINS: 'http://localhost:4200',
};

function productionMigrate() {
  return runScript(
    'scripts/migrate.mjs',
    dbEnv(DB, {
      NODE_ENV: 'production',
      MIGRATION_DB_USER: process.env.TEST_DB_USER,
      MIGRATION_DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? '',
      ...APP_ENV,
    }),
  );
}

function schemaCheck() {
  return runScript('scripts/check-schema.mjs', dbEnv(DB, { ...APP_ENV, FRONTEND_BASE_URL: 'http://localhost:4200' }));
}

async function count(sql: string): Promise<number> {
  return withServer(async (conn) => Number(((await conn.query(sql))[0] as any[])[0].n), DB);
}

beforeAll(async () => {
  await recreateDatabase(DB);
});

afterAll(async () => {
  await dropDatabase(DB);
});

describe('production migrate + schema:check', () => {
  it('NODE_ENV=production applies 001, 002 and the numbered files, never migrations/dev/', async () => {
    const first = productionMigrate();
    expect(first.output).not.toContain('failed');
    expect(first.status).toBe(0);
    const versions: string[] = await withServer(
      async (conn) => ((await conn.query('SELECT version FROM schema_migrations ORDER BY version'))[0] as any[]).map((r) => r.version),
      DB,
    );
    expect(versions[0]).toBe('001_schema.sql');
    expect(versions).toContain('002_seed.sql');
    expect(versions).not.toContain('003_dev_sample.sql');
    expect(await count('SELECT COUNT(*) AS n FROM applications')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM media_assets')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM pages')).toBeGreaterThan(0);

    const second = productionMigrate();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('Nothing to migrate');
  });

  it('schema:check passes on the migrated database', () => {
    const result = schemaCheck();
    expect(result.output).toContain('Schema matches the entities');
    expect(result.status).toBe(0);
  });

  it('schema:check fails on drift: nullability, length, enum, a missing index, an unmapped required column', async () => {
    await withServer(async (conn) => {
      await conn.query('ALTER TABLE users MODIFY name VARCHAR(100) NULL');
      await conn.query("ALTER TABLE partners MODIFY category ENUM('government','university') NOT NULL");
      await conn.query('DROP INDEX ix_applications_created ON applications');
      await conn.query('ALTER TABLE stats ADD COLUMN surprise INT NOT NULL');
    }, DB);
    const result = schemaCheck();
    expect(result.status).toBe(1);
    expect(result.output).toContain('users.name: entity says NOT NULL, database says NULL');
    expect(result.output).toContain('users.name: entity length 120, database length 100');
    expect(result.output).toContain('partners.category: entity enum');
    expect(result.output).toContain('applications: index ix_applications_created (created_at) missing');
    expect(result.output).toContain('stats.surprise: NOT NULL without a default');
  });
});

describe('upgrading a database left at 003 by the old runner', () => {
  const OLD = `${process.env.TEST_DB_NAME}_at003`;
  afterAll(async () => {
    await dropDatabase(OLD);
  });

  it('applies 004+ in order, backfills checksums, and ends up matching the entities', async () => {
    await recreateDatabase(OLD);
    await withServer(async (conn) => {
      await conn.query("SET time_zone = '+00:00'");
      // The old runner's tracking table: no checksum column.
      await conn.query(
        'CREATE TABLE schema_migrations (version VARCHAR(255) NOT NULL, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (version))',
      );
      for (const file of ['001_schema.sql', '002_seed.sql', 'dev/003_dev_sample.sql']) {
        await conn.query(readFileSync(path.join(ROOT, 'migrations', file), 'utf8'));
        await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [path.basename(file)]);
      }
    }, OLD);
    const withPlainIds: number = await withServer(
      async (conn) => Number(((await conn.query('SELECT COUNT(*) AS n FROM applications WHERE id_number IS NOT NULL'))[0] as any[])[0].n),
      OLD,
    );
    expect(withPlainIds).toBeGreaterThan(0);

    const env = dbEnv(OLD, { NODE_ENV: 'development', STORAGE_ROOT: path.join(ROOT, 'var', 'assets-test'), ...APP_ENV });
    const upgrade = runScript('scripts/migrate.mjs', env);
    expect(upgrade.output).not.toContain('failed');
    expect(upgrade.status).toBe(0);
    expect(upgrade.stdout).toContain('Recorded checksum for already-applied 001_schema.sql');
    expect(upgrade.stdout).toContain(`encrypted ${withPlainIds} ID number(s)`);

    const again = runScript('scripts/migrate.mjs', env);
    expect(again.stdout).toContain('Nothing to migrate');

    const check = runScript('scripts/check-schema.mjs', dbEnv(OLD, { ...APP_ENV }));
    expect(check.output).toContain('Schema matches the entities');
    expect(check.status).toBe(0);
  });
});

