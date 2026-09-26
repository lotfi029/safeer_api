// test/global-setup.ts — Phase 6 (safeer-backend-fix-prompt.md): a real
// MySQL database, created and migrated here (never mocked), plus a real
// running instance of the compiled app (dist/main.js, from `npm run build`
// — run that first, same as scripts/smoke.mjs's own prerequisite) that
// every spec file talks to over plain HTTP, exactly like scripts/smoke.mjs
// does against the dev server. Mutating `process.env` here is the
// documented way to hand values to the test workers (jest.setup.ts /
// test/helpers.ts read them back via `process.env`).

import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const TEST_DB_NAME = process.env.TEST_DB_NAME ?? `${process.env.DB_NAME ?? 'safeer'}_test`;
const TEST_PORT = process.env.TEST_PORT ?? '3901';
const PID_FILE = path.join(__dirname, '.server.pid');

function runNode(script: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(process.execPath, [script], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${script} exited with code ${result.status}`);
  }
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not become healthy at ${url} within ${timeoutMs}ms`);
}

module.exports = async function globalSetup() {
  const rootDbEnv = {
    ...process.env,
    DB_HOST: process.env.DB_HOST ?? '127.0.0.1',
    DB_PORT: process.env.DB_PORT ?? '3306',
    DB_USER: process.env.DB_USER ?? 'root',
    DB_PASSWORD: process.env.DB_PASSWORD ?? '',
  };

  // 1. Fresh test database.
  const admin = await mysql.createConnection({
    host: rootDbEnv.DB_HOST,
    port: Number(rootDbEnv.DB_PORT),
    user: rootDbEnv.DB_USER,
    password: rootDbEnv.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
  await admin.query(`CREATE DATABASE \`${TEST_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();

  // 2. Migrate it — NODE_ENV=test still includes migrations/dev/003_dev_sample.sql
  // (migrate.mjs only excludes it for 'production'), so specs can assert
  // against its fixtures the same way scripts/smoke.mjs's own dev-mode run
  // does. NODE_ENV=test (not 'development') matters again in step 3: it's
  // what TestAwareThrottlerGuard checks to bypass the per-route throttles
  // this suite would otherwise blow through in minutes.
  // The same APP_ENCRYPTION_KEY the app gets below: migration 012 encrypts
  // id numbers with it (C28), and the app must be able to decrypt them.
  const appEncryptionKey = process.env.APP_ENCRYPTION_KEY ?? 'ukhiU9W4qpmJr9pwnzL01FaECwZTTOF3Y2vPKga7xrk=';
  const storageRoot = process.env.TEST_STORAGE_ROOT ?? './var/assets-test';
  // STORAGE_ROOT too: migrate writes placeholder files for the dev fixtures' stored keys there (C45).
  const migrateEnv = { ...rootDbEnv, NODE_ENV: 'test', DB_NAME: TEST_DB_NAME, APP_ENCRYPTION_KEY: appEncryptionKey, STORAGE_ROOT: storageRoot };
  runNode('scripts/migrate.mjs', migrateEnv);

  // 3. Boot the real (compiled) app against that database, on its own port.
  // C9: deliberately NOT in UTC (Asia/Riyadh, UTC+3, by default) — every
  // spec then runs against an app whose process clock disagrees with UTC,
  // which is what proves the database layer pins everything to UTC
  // (src/database/utc.ts, test/utc.spec.ts).
  const appEnv = {
    ...migrateEnv,
    TZ: process.env.TEST_APP_TZ ?? 'Asia/Riyadh',
    PORT: TEST_PORT,
    STORAGE_ROOT: storageRoot,
    BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@safeer-sa.org',
    BOOTSTRAP_ADMIN_PASSWORD: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'test-only-password',
    APP_ENCRYPTION_KEY: appEncryptionKey,
    IP_HASH_SALT: process.env.IP_HASH_SALT ?? 'test-only-salt',
    CORS_ORIGINS: process.env.CORS_ORIGINS ?? 'http://localhost:4200',
    FRONTEND_BASE_URL: process.env.FRONTEND_BASE_URL ?? 'http://localhost:4200',
    ALLOW_DEV_PASSWORD_FIXUP: 'true',
  };

  const server = spawn(process.execPath, ['--enable-source-maps', 'dist/main.js'], {
    cwd: path.join(__dirname, '..'),
    env: appEnv,
    stdio: 'inherit',
    detached: true,
  });
  writeFileSync(PID_FILE, String(server.pid));

  await waitForHealth(`http://localhost:${TEST_PORT}/health`);

  process.env.TEST_BASE_URL = `http://localhost:${TEST_PORT}/api/v1`;
  process.env.TEST_HEALTH_URL = `http://localhost:${TEST_PORT}/health`;
  process.env.TEST_APP_TZ = appEnv.TZ;
  // A4: test/shutdown.spec.ts boots a second instance with the same settings.
  process.env.TEST_APP_ENV = JSON.stringify(appEnv);
  // C27 specs sign a newsletter unsubscribe link with the same key the app uses.
  process.env.TEST_APP_ENCRYPTION_KEY = appEncryptionKey;
  process.env.TEST_DB_NAME = TEST_DB_NAME;
  process.env.TEST_DB_HOST = rootDbEnv.DB_HOST;
  process.env.TEST_DB_PORT = rootDbEnv.DB_PORT;
  process.env.TEST_DB_USER = rootDbEnv.DB_USER;
  process.env.TEST_DB_PASSWORD = rootDbEnv.DB_PASSWORD;
  process.env.TEST_ADMIN_EMAIL = appEnv.BOOTSTRAP_ADMIN_EMAIL;
  process.env.TEST_ADMIN_PASSWORD = appEnv.BOOTSTRAP_ADMIN_PASSWORD;
};
