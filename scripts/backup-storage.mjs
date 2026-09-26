#!/usr/bin/env node
// scripts/backup-storage.mjs — Phase 5 (storage abstraction, decision 3,
// safeer-backend-fix-prompt.md). KNOWN-ISSUES.md's own gap ("nothing backs
// up STORAGE_ROOT itself") for local mode; a no-op for S3, whose provider
// already owns durability/backups for whatever bucket it is.
//
// Usage:
//   node scripts/backup-storage.mjs [outDir]
//   npm run backup:storage
//
// Local mode: writes <outDir>/safeer-storage-<UTC timestamp>.tar.gz of the
// whole STORAGE_ROOT tree. outDir defaults to ./var/backups, created if
// missing. Cron line (docs/backend/DEPLOYMENT-HOSTINGER.md, "Backups"):
//   0 3 * * * cd /path/to/safeer_api && NODE_ENV=production node scripts/backup-storage.mjs /path/to/backups >> /var/log/safeer-storage-backup.log 2>&1
//
// S3 mode: prints a message and exits 0 — nothing to do here. Back up the
// S3_BUCKET_PRIVATE/S3_BUCKET_PUBLIC buckets with the provider's own
// mechanism (versioning, cross-region replication, a scheduled export),
// documented in docs/backend/DEPLOYMENT-HOSTINGER.md.

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from '../dist/config/env.js';

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
}

async function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

async function main() {
  const env = loadEnv();

  if (env.STORAGE_DRIVER === 's3') {
    console.log(
      'STORAGE_DRIVER=s3 — nothing to back up here. Back up the S3_BUCKET_PRIVATE/S3_BUCKET_PUBLIC buckets ' +
        "with the provider's own mechanism (versioning, replication, a scheduled export).",
    );
    return;
  }

  const outDir = path.resolve(process.argv[2] ?? './var/backups');
  await mkdir(outDir, { recursive: true });

  const storageRoot = path.resolve(env.STORAGE_ROOT);
  try {
    await stat(storageRoot);
  } catch {
    console.error(`STORAGE_ROOT (${storageRoot}) does not exist — nothing to back up.`);
    process.exit(1);
  }

  const archiveName = `safeer-storage-${timestamp()}.tar.gz`;
  const archivePath = path.join(outDir, archiveName);

  // -C into the parent of STORAGE_ROOT and archive its basename, so the
  // tarball extracts to a directory named for STORAGE_ROOT itself, not an
  // absolute-path tree.
  await run('tar', ['-czf', archivePath, '-C', path.dirname(storageRoot), path.basename(storageRoot)]);

  console.log(`Wrote ${archivePath}`);
}

await main();
