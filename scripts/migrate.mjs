#!/usr/bin/env node
// Tiny migration runner (13-backend-build-plan.md P2, decision D-02).
//
// Migrations are plain numbered SQL files in migrations/, applied in order,
// each inside its own transaction, recorded in schema_migrations. Not
// TypeORM's generator — the schema is hand-reviewed SQL, transcribed
// verbatim from 12-database.md.
//
// B0-5: migrations/dev/ holds dev-and-staging-only fixtures
// (003_dev_sample.sql — fake content plus two dev user accounts) and is
// included only when NODE_ENV !== 'production'. Previously this glob had no
// environment check at all, so a production `npm run migrate` silently
// loaded the fake data (20-production-deploy-checklist.md's named blocker).
//
// Usage:
//   node scripts/migrate.mjs            apply every pending migration
//   node scripts/migrate.mjs --status   list applied / pending, apply nothing

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');
const devMigrationsDir = path.join(migrationsDir, 'dev');

const statusOnly = process.argv.includes('--status');

function env(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
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
async function resolveMigrationFiles() {
  const nodeEnv = env('NODE_ENV'); // no fallback: refuse to guess the environment
  const includeDev = nodeEnv !== 'production';

  const rootEntries = await readdir(migrationsDir, { withFileTypes: true });
  const rootNames = rootEntries.filter((d) => d.isFile() && d.name.endsWith('.sql')).map((d) => d.name);

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
      console.error(`Duplicate migration name in migrations/ and migrations/dev/: ${file.version}`);
      process.exit(1);
    }
    seen.add(file.version);
  }

  return files;
}

async function main() {
  // Resolved before touching the database — a missing NODE_ENV, or a
  // duplicate migration name, should fail fast without needing a live
  // connection (and is what lets this be checked with `--status` alone).
  const files = await resolveMigrationFiles();

  const connection = await mysql.createConnection({
    host: env('DB_HOST'),
    port: Number(env('DB_PORT', '3306')),
    user: env('DB_USER'),
    password: env('DB_PASSWORD'),
    database: env('DB_NAME'),
    // Full collation, not just the charset name (see database.module.ts) —
    // mysql2 otherwise negotiates utf8mb4_general_ci, not the
    // utf8mb4_unicode_ci every table in migrations/001_schema.sql uses.
    charset: 'utf8mb4_unicode_ci',
    multipleStatements: true,
  });

  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(255) NOT NULL,
      applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (version)
    ) ENGINE=InnoDB;
  `);

  // TypeORM's own bookkeeping table (not one of our domain tables, and not
  // created by us via a numbered migration for that reason). Its schema
  // reader unconditionally queries this table for any column MySQL reports
  // as GENERATED; without it, `npm run schema:check` fails outright.
  // TypeORM would normally create it the first time `synchronize` runs,
  // which never happens here (synchronize is always off), so it's created
  // once, idempotently, alongside our own tooling table.
  //
  // Safeer has no GENERATED columns today (unlike african_api's
  // meetings.meeting_year), so unlike that reference this runner does not
  // insert any typeorm_metadata rows — this table creation stays generic
  // and reusable if a future migration adds one. See
  // src/database/entities/*.entity.ts for `asExpression` usage if that
  // ever changes.
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

  const [appliedRows] = await connection.query('SELECT version FROM schema_migrations');
  const applied = new Set(appliedRows.map((r) => r.version));

  if (statusOnly) {
    for (const file of files) {
      console.log(`${applied.has(file.version) ? '[applied]' : '[pending]'} ${file.version}`);
    }
    await connection.end();
    return;
  }

  for (const file of files) {
    if (applied.has(file.version)) continue;

    const sql = await readFile(file.fullPath, 'utf8');
    console.log(`Applying ${file.version} ...`);

    // Note: MySQL DDL statements implicitly commit, so for a pure-DDL file
    // (001_schema.sql) this transaction cannot fully roll back a partial
    // failure the way it can for the pure-DML seed files (002/003) — that
    // is an InnoDB limitation, not something this runner can work around.
    await connection.beginTransaction();
    try {
      await connection.query(sql);
      await connection.query('INSERT INTO schema_migrations (version) VALUES (?)', [file.version]);
      await connection.commit();
      console.log(`  done`);
    } catch (err) {
      await connection.rollback();
      console.error(`  failed: ${err.message}`);
      await connection.end();
      process.exit(1);
    }
  }

  await connection.end();
  console.log('All migrations applied.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
