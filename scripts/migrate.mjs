#!/usr/bin/env node
// Tiny migration runner (13-backend-build-plan.md P2, decision D-02).
//
// Migrations are plain numbered SQL files in migrations/, applied in order,
// each inside its own transaction, recorded in schema_migrations. Not
// TypeORM's generator — the schema is hand-reviewed SQL, transcribed
// verbatim from 12-database.md.
//
// C11: migrations/dev/ holds dev/test-only fixtures (003_dev_sample.sql —
// fake content, sample applications) and is included only when NODE_ENV is
// development or test. staging and production never get them. NODE_ENV
// must be one of the values src/config/env.ts accepts (scripts/lib/node-env.mjs).
// C45: in development/test with STORAGE_DRIVER=local, it then writes a
// placeholder file for every stored key those fixtures reference that is
// missing under STORAGE_ROOT (scripts/lib/dev-assets.mjs).
//
// C29:
// - Every applied file's sha256 is stored in schema_migrations.checksum
//   (CRLF normalised to LF first, so a Windows checkout hashes the same).
//   Rows applied by the older runner have no checksum; the first run of this
//   runner backfills it from the file on disk. From then on, an applied file
//   whose content changed fails the run before anything is applied —
//   applied migrations are immutable; changes go in a new numbered file.
// - GET_LOCK('safeer_migrate') makes two concurrent runs (two deploy hooks,
//   a deploy plus someone in SSH) wait for each other instead of both
//   applying the same file.
// - Connects as MIGRATION_DB_USER (scripts/lib/db-connection.mjs), falling
//   back to DB_USER only in development/test.
//
// C9: the connection is UTC (timezone 'Z' + SET time_zone), like the app.
//
// Usage:
//   node scripts/migrate.mjs            apply every pending migration
//   node scripts/migrate.mjs --status   list applied / pending / changed, write nothing
//
// MIGRATIONS_DIR overrides the migrations directory (test/migrate.spec.ts
// only; its dev fixtures are read from <MIGRATIONS_DIR>/dev).
// MIGRATE_LOCK_TIMEOUT_SECONDS (default 30) bounds the wait for the lock.

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'dotenv/config';
import { DEV_ENVS, requireNodeEnv } from './lib/node-env.mjs';
import { openMigrationConnection } from './lib/db-connection.mjs';
import { ensureDevAssetFiles } from './lib/dev-assets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = process.env.MIGRATIONS_DIR
  ? path.resolve(process.env.MIGRATIONS_DIR)
  : path.join(__dirname, '..', 'migrations');
const devMigrationsDir = path.join(migrationsDir, 'dev');

const LOCK_NAME = 'safeer_migrate';
const statusOnly = process.argv.includes('--status');

class MigrateError extends Error {}

function checksumOf(sql) {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * Resolves the migration file list. `version` is always the bare filename,
 * never a path — every already-migrated database already holds
 * `schema_migrations.version = '003_dev_sample.sql'` (no directory prefix)
 * from before this file moved under migrations/dev/. Keying on the path
 * instead would orphan that row and re-apply the whole dev fixture set over
 * a populated schema. The duplicate-name guard below is what buys back the
 * safety a path prefix would otherwise have given.
 */
async function resolveMigrationFiles(nodeEnv) {
  const includeDev = DEV_ENVS.includes(nodeEnv);

  const rootEntries = await readdir(migrationsDir, { withFileTypes: true });
  // C28: a numbered `.mjs` migration exports `up(connection, { env })` for a
  // data change SQL alone can't make (e.g. encrypting a column with
  // APP_ENCRYPTION_KEY). It is checksummed and run in a transaction exactly
  // like a `.sql` file. migrations/dev/ stays SQL-only.
  const rootNames = rootEntries.filter((d) => d.isFile() && /\.(sql|mjs)$/.test(d.name)).map((d) => d.name);

  let devNames = [];
  if (includeDev) {
    try {
      devNames = (await readdir(devMigrationsDir)).filter((f) => f.endsWith('.sql'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  const files = [
    ...rootNames.map((name) => ({ version: name, fullPath: path.join(migrationsDir, name) })),
    ...devNames.map((name) => ({ version: name, fullPath: path.join(devMigrationsDir, name) })),
  ].sort((a, b) => a.version.localeCompare(b.version));

  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.version)) {
      throw new MigrateError(`Duplicate migration name in migrations/ and migrations/dev/: ${file.version}`);
    }
    seen.add(file.version);
  }

  for (const file of files) {
    file.sql = await readFile(file.fullPath, 'utf8');
    file.checksum = checksumOf(file.sql);
  }
  return files;
}

async function ensureTrackingTables(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(255) NOT NULL,
      applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      checksum   CHAR(64)     NULL,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB;
  `);

  // Databases migrated by the older runner have the table without the
  // checksum column. information_schema rather than ADD COLUMN IF NOT
  // EXISTS, which MariaDB has and MySQL 8 does not.
  const [cols] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = 'checksum'`,
  );
  if (cols.length === 0) {
    await connection.query('ALTER TABLE schema_migrations ADD COLUMN checksum CHAR(64) NULL');
  }

  // TypeORM's own bookkeeping table (not one of our domain tables, and not
  // created by us via a numbered migration for that reason). Its schema
  // reader unconditionally queries this table for any column MySQL reports
  // as GENERATED; without it, `npm run schema:check` fails outright.
  // TypeORM would normally create it the first time `synchronize` runs,
  // which never happens here (synchronize is always off), so it's created
  // once, idempotently, alongside our own tooling table.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS typeorm_metadata (
      \`type\`     VARCHAR(255) NOT NULL,
      \`database\` VARCHAR(255) NULL,
      \`schema\`   VARCHAR(255) NULL,
      \`table\`    VARCHAR(255) NULL,
      \`name\`     VARCHAR(255) NULL,
      \`value\`    TEXT NULL
    ) ENGINE=InnoDB;
  `);
}

async function readApplied(connection) {
  const [tables] = await connection.query(
    "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'",
  );
  if (tables.length === 0) return new Map();
  const [cols] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = 'checksum'`,
  );
  const [rows] = await connection.query(
    cols.length ? 'SELECT version, checksum FROM schema_migrations' : 'SELECT version, NULL AS checksum FROM schema_migrations',
  );
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

async function printStatus(connection, files) {
  const applied = await readApplied(connection);
  for (const file of files) {
    if (!applied.has(file.version)) {
      console.log(`[pending] ${file.version}`);
    } else {
      const stored = applied.get(file.version);
      if (stored === null) console.log(`[applied] ${file.version} (no checksum yet — backfilled on the next migrate)`);
      else if (stored !== file.checksum) console.log(`[CHANGED] ${file.version} (file differs from what was applied)`);
      else console.log(`[applied] ${file.version}`);
    }
  }
}

async function acquireLock(connection) {
  const timeout = Number(process.env.MIGRATE_LOCK_TIMEOUT_SECONDS ?? 30);
  const [[row]] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [LOCK_NAME, timeout]);
  if (Number(row.acquired) !== 1) {
    throw new MigrateError(
      `Could not acquire the '${LOCK_NAME}' lock within ${timeout}s — another migrate run is in progress. ` +
        'Wait for it to finish and re-run.',
    );
  }
}

/** Backfills missing checksums; fails if any applied file changed. */
async function verifyChecksums(connection, files, applied) {
  const changed = [];
  for (const file of files) {
    if (!applied.has(file.version)) continue;
    const stored = applied.get(file.version);
    if (stored === null) {
      await connection.query('UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum IS NULL', [
        file.checksum,
        file.version,
      ]);
      console.log(`Recorded checksum for already-applied ${file.version}`);
    } else if (stored !== file.checksum) {
      changed.push(file);
    }
  }
  if (changed.length) {
    const lines = changed.map((f) => `  ${f.version}: applied ${applied.get(f.version)}, on disk ${f.checksum}`);
    throw new MigrateError(
      'Checksum mismatch — these already-applied migrations were edited after they ran:\n' +
        lines.join('\n') +
        '\nApplied migrations are immutable: revert the edit and put the change in a new numbered file.\n' +
        'If the edit really is harmless (a comment, whitespace), accept it explicitly with\n' +
        "  UPDATE schema_migrations SET checksum = '<on-disk checksum>' WHERE version = '<file>';\n" +
        'See docs/backend/DEPLOYMENT-HOSTINGER.md, "Migrations".',
    );
  }
}

async function applyPending(connection, files, applied) {
  let count = 0;
  for (const file of files) {
    if (applied.has(file.version)) continue;
    console.log(`Applying ${file.version} ...`);

    // MySQL/MariaDB DDL commits implicitly, so for a DDL file this
    // transaction cannot roll back a partial failure the way it can for a
    // pure-DML seed file — an InnoDB limitation, not something the runner
    // can work around. The failure message points at the recovery steps.
    await connection.beginTransaction();
    try {
      if (file.version.endsWith('.mjs')) {
        const migration = await import(pathToFileURL(file.fullPath).href);
        if (typeof migration.up !== 'function') throw new Error('a .mjs migration must export async function up(connection, { env })');
        await migration.up(connection, { env: process.env, log: (msg) => console.log(`  ${msg}`) });
      } else {
        await connection.query(file.sql);
      }
      await connection.query('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)', [file.version, file.checksum]);
      await connection.commit();
      console.log('  done');
      count++;
    } catch (err) {
      await connection.rollback();
      throw new MigrateError(
        `${file.version} failed: ${err.message}\n` +
          'It is NOT recorded in schema_migrations. If the file contains DDL (CREATE/ALTER/DROP), the statements\n' +
          'before the failing one were committed anyway. Recover by hand before re-running — see\n' +
          'docs/backend/DEPLOYMENT-HOSTINGER.md, "Recovering from a half-applied migration".',
      );
    }
  }
  return count;
}

async function main() {
  const nodeEnv = requireNodeEnv('migrate');
  // Resolved before touching the database — a bad NODE_ENV or a duplicate
  // migration name fails fast without needing a live connection.
  const files = await resolveMigrationFiles(nodeEnv);

  const connection = await openMigrationConnection('migrate', nodeEnv);
  try {
    if (statusOnly) {
      await printStatus(connection, files);
      return;
    }

    await acquireLock(connection);
    try {
      await ensureTrackingTables(connection);
      const applied = await readApplied(connection);
      await verifyChecksums(connection, files, applied);
      const count = await applyPending(connection, files, applied);
      console.log(count ? `All migrations applied (${count} new).` : 'Nothing to migrate — already up to date.');
      // C45: development/test only, and only for files on local disk.
      if (DEV_ENVS.includes(nodeEnv) && (process.env.STORAGE_DRIVER ?? 'local') === 'local') {
        await ensureDevAssetFiles(connection, { storageRoot: process.env.STORAGE_ROOT || './var/assets', log: (m) => console.log(m) });
      }
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    }
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error(err instanceof MigrateError ? err.message : err);
  process.exit(1);
});
