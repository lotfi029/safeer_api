#!/usr/bin/env node
// scripts/db-reset.mjs — drop and recreate DB_NAME, then re-apply every
// migration from disk (18-completion-plan.md C7.4). Gets anyone back to a
// known, seeded state in one command:
//   npm run db:reset -- --confirm=<DB_NAME>
//
// This does NOT re-run `npm run seed` (tools/seed-from-prototype.mjs) — that
// script regenerates migrations/002_seed.sql and migrations/dev/003_dev_sample.sql
// from the prototype's own SEED object via live oEmbed calls, which needs
// network access and a checkout of the sibling prototype repo neither of
// which every machine running `db:reset` can assume. 002/003 are already
// committed, generated SQL; db:reset only needs to re-apply what's on disk.
// Re-run `npm run seed` yourself first if you've changed the prototype seed
// content and want that reflected before resetting.
//
// Guardrails against wiping the wrong database:
// - C8: refuses unless NODE_ENV is development/test and the database is
//   named explicitly: `npm run db:reset -- --confirm=<DB_NAME>`.
// - Refuses anything but a local DB_HOST.
// Connects with the migration credentials, in UTC, like migrate.mjs
// (scripts/lib/db-connection.mjs).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import 'dotenv/config';
import { requireDevDbConfirmation } from './lib/dev-db-guard.mjs';
import { openMigrationConnection } from './lib/db-connection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

async function main() {
  requireDevDbConfirmation('db:reset');
  const host = process.env.DB_HOST;
  if (!LOCAL_HOSTS.has(host)) {
    console.error(`Refusing to reset a non-local DB_HOST (${host}). db:reset is a dev-only convenience.`);
    process.exit(1);
  }
  const dbName = process.env.DB_NAME;

  const connection = await openMigrationConnection('db:reset', process.env.NODE_ENV, { database: null });

  console.log(`Dropping and recreating \`${dbName}\` on ${host} ...`);
  await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\`;`);
  await connection.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  await connection.end();

  console.log('Running migrations ...');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'migrate.mjs')], { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`migrate.mjs exited with code ${code}`))));
  });

  console.log('db:reset complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
