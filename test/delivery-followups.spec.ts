// test/delivery-followups.spec.ts — the Low items from
// docs/safeer-delivery-review.md §3 that need their own processes or
// scratch databases (A5, A6, A9 and A10 live next to the features they fix):
//   A7  APP_ENCRYPTION_KEY guard: migrate and the app refuse a wrong key
//   A8  the __dev routes don't exist in staging/production
//   A11 019 scrubs old OTP codes from the logs and keeps an active admin;
//       a superseded document has no download link and its route says why
//   A12 map_embed_url (allow-listed) and map_lat/lng in settings and GET /site

import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adminApi, api, createApplication, deleteApplication, uploadApplicationDocument, withDb } from './helpers';
import { ROOT, dbEnv, dropDatabase, recreateDatabase, runScript, withServer } from './scripts.helpers';

const APP_ENV: Record<string, string> = JSON.parse(process.env.TEST_APP_ENV ?? '{}');
const RIGHT_KEY = APP_ENV.APP_ENCRYPTION_KEY;
const WRONG_KEY = Buffer.alloc(32, 7).toString('base64');
const kcv = (key: string) => createHmac('sha256', Buffer.from(key, 'base64')).update('safeer:app-encryption-key-check:v1').digest('hex');

let nextPort = Number(process.env.TEST_PORT ?? 3901) + 10;

interface BootedApp {
  child: ChildProcess;
  base: string;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Boots a second API process with the suite's settings plus `overrides`; resolves once it is healthy or has exited. */
async function bootApp(overrides: Record<string, string>): Promise<BootedApp & { healthy: boolean }> {
  const port = String(nextPort++);
  let output = '';
  const child = spawn(process.execPath, ['dist/main.js'], { cwd: ROOT, env: { ...APP_ENV, ...overrides, PORT: port } });
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  let done = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => {
      done = true;
      resolve({ code, signal });
    }),
  );
  const deadline = Date.now() + 45_000;
  while (!done && Date.now() < deadline) {
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) {
        return { child, base: `http://localhost:${port}/api/v1`, output: () => output, exited, healthy: true };
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { child, base: `http://localhost:${port}/api/v1`, output: () => output, exited, healthy: false };
}

function stop(app: BootedApp | undefined): void {
  if (app && app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
}

describe('A7: APP_ENCRYPTION_KEY guard', () => {
  const migrate = (key: string) =>
    runScript('scripts/migrate.mjs', dbEnv(process.env.TEST_DB_NAME!, { APP_ENCRYPTION_KEY: key, STORAGE_ROOT: APP_ENV.STORAGE_ROOT }));

  it('the check value was stored on first use, and migrate refuses any other key', async () => {
    const [[row]]: any = await withDb((conn) => conn.query('SELECT encryption_key_check AS v FROM site_settings WHERE id = 1'));
    expect(row.v).toBe(kcv(RIGHT_KEY));

    const wrong = migrate(WRONG_KEY);
    expect(wrong.status).toBe(1);
    expect(wrong.output).toMatch(/APP_ENCRYPTION_KEY does not match/);
    expect(migrate(RIGHT_KEY).status).toBe(0);
  });

  it('with no check value yet (a database from before 018), an encrypted value decides — and the right key records it', async () => {
    const [[encrypted]]: any = await withDb((conn) => conn.query('SELECT COUNT(*) AS n FROM applications WHERE id_number_encrypted IS NOT NULL'));
    expect(Number(encrypted.n)).toBeGreaterThan(0); // dev fixtures, encrypted by 012
    await withDb((conn) => conn.query('UPDATE site_settings SET encryption_key_check = NULL WHERE id = 1'));
    try {
      const wrong = migrate(WRONG_KEY);
      expect(wrong.status).toBe(1);
      expect(wrong.output).toMatch(/APP_ENCRYPTION_KEY does not match/);
      expect(migrate(RIGHT_KEY).status).toBe(0);
    } finally {
      await withDb((conn) => conn.query('UPDATE site_settings SET encryption_key_check = ? WHERE id = 1', [kcv(RIGHT_KEY)]));
    }
  });

  it('the app refuses to start with a different key', async () => {
    const app = await bootApp({ APP_ENCRYPTION_KEY: WRONG_KEY });
    try {
      expect(app.healthy).toBe(false);
      const { code } = await app.exited;
      expect(code).not.toBe(0);
      expect(app.output()).toMatch(/APP_ENCRYPTION_KEY does not match/);
    } finally {
      stop(app);
    }
  }, 60_000);
});

describe('A8: no __dev routes outside development/test', () => {
  it.each(['staging', 'production'])('%s: the __dev routes are not registered at all', async (nodeEnv) => {
    const app = await bootApp({ NODE_ENV: nodeEnv, ALLOW_DEV_PASSWORD_FIXUP: 'false' });
    try {
      expect(app.healthy).toBe(true);
      expect((await fetch(`${app.base}/site`)).status).toBe(200);
      // Nest's own "Cannot GET …" for an unmapped route — not the hook's "Not found".
      for (const [method, route] of [
        ['GET', '__dev/otp/1'],
        ['POST', '__dev/settle'],
        ['POST', '__dev/maintenance/run'],
      ]) {
        const res = await fetch(`${app.base}/${route}`, { method });
        expect(res.status).toBe(404);
        expect((await res.json()).title).toBe(`Cannot ${method} /api/v1/${route}`);
      }
    } finally {
      stop(app);
    }
  }, 60_000);
});

describe('A11: upgrade-path gaps', () => {
  const DB = `${process.env.TEST_DB_NAME}_a11`;
  let dir: string;

  afterAll(async () => {
    await dropDatabase(DB);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('019 masks OTP codes left in old log rows and re-enables one admin when none is active', async () => {
    // A database migrated up to 018, then written to the way it was before 007/008.
    dir = mkdtempSync(path.join(tmpdir(), 'safeer-a11-'));
    mkdirSync(path.join(dir, 'dev'));
    const all = readdirSync(path.join(ROOT, 'migrations')).filter((f) => /^\d{3}_.*\.(sql|mjs)$/.test(f));
    for (const f of all.filter((f) => f < '019')) copyFileSync(path.join(ROOT, 'migrations', f), path.join(dir, f));
    copyFileSync(path.join(ROOT, 'migrations/dev/003_dev_sample.sql'), path.join(dir, 'dev/003_dev_sample.sql'));
    await recreateDatabase(DB);
    const env = dbEnv(DB, { MIGRATIONS_DIR: dir, APP_ENCRYPTION_KEY: RIGHT_KEY, STORAGE_ROOT: path.join(dir, 'assets') });
    expect(runScript('scripts/migrate.mjs', env).status).toBe(0);

    await withServer(async (conn) => {
      await conn.query(
        "INSERT INTO sms_log (template_key, to_phone, message, payload) VALUES ('otp_code', '+966500000000', 'رمز الدخول إلى بوابة سفير: 482913 (صالح 10 دقائق)', JSON_OBJECT('message', '482913'))",
      );
      await conn.query("INSERT INTO sms_log (template_key, to_phone, message) VALUES ('status_changed', '+966500000000', 'Ref SA-2026-123456')");
      await conn.query(
        "INSERT INTO mail_log (template_key, to_email, subject, payload) VALUES ('otp_code', 'a@example.com', 'رمز الدخول 731200', JSON_OBJECT('subject', '731200'))",
      );
      await conn.query(
        `INSERT INTO users (name, email, password_hash, role, status, last_login_at) VALUES
           ('Old admin', 'old-admin@example.com', 'x', 'admin', 'disabled', UTC_TIMESTAMP(3) - INTERVAL 30 DAY),
           ('Recent admin', 'recent-admin@example.com', 'x', 'admin', 'disabled', UTC_TIMESTAMP(3) - INTERVAL 1 DAY),
           ('An editor', 'editor@example.com', 'x', 'editor', 'active', UTC_TIMESTAMP(3))`,
      );
    }, DB);

    copyFileSync(path.join(ROOT, 'migrations/019_upgrade_path_fixes.sql'), path.join(dir, '019_upgrade_path_fixes.sql'));
    const upgraded = runScript('scripts/migrate.mjs', env);
    expect(upgraded.output).toMatch(/019_upgrade_path_fixes\.sql/);
    expect(upgraded.status).toBe(0);

    await withServer(async (conn) => {
      const [sms]: any = await conn.query("SELECT template_key, message, payload FROM sms_log ORDER BY id");
      expect(sms[0].message).toBe('رمز الدخول إلى بوابة سفير: •••••• (صالح 10 دقائق)');
      expect(sms[0].payload).toBeNull();
      expect(sms[1].message).toBe('Ref SA-2026-123456'); // not an OTP row: untouched
      const [[mail]]: any = await conn.query("SELECT subject, payload FROM mail_log WHERE template_key = 'otp_code'");
      expect(mail.subject).toBe('رمز الدخول ••••••');
      expect(mail.payload).toBeNull();
      const [users]: any = await conn.query('SELECT email, status FROM users ORDER BY email');
      expect(Object.fromEntries(users.map((u: any) => [u.email, u.status]))).toEqual({
        'editor@example.com': 'active',
        'old-admin@example.com': 'disabled',
        'recent-admin@example.com': 'active',
      });
    }, DB);
  }, 120_000);

  it('a superseded document has no download path, and its file route answers 410 DOCUMENT_SUPERSEDED', async () => {
    const applicant = await createApplication();
    try {
      expect((await uploadApplicationDocument(applicant, 'id_copy', 'a11-first')).status).toBe(201);
      expect((await uploadApplicationDocument(applicant, 'id_copy', 'a11-second')).status).toBe(201);
      const [rows]: any = await withDb((conn) =>
        conn.query('SELECT id, superseded_at FROM application_documents WHERE application_id = ? ORDER BY id', [applicant.id]),
      );
      const [old, current] = rows;
      expect(old.superseded_at).not.toBeNull();

      const detail = await adminApi('GET', `/admin/applications/${applicant.id}`);
      expect(detail.body.documents.map((d: any) => [String(d.id), d.downloadPath])).toEqual([
        [String(current.id), `admin/applications/${applicant.id}/documents/${current.id}/file`],
      ]);
      expect((await adminApi('GET', `/${detail.body.documents[0].downloadPath}`)).status).toBe(200);

      const gone = await adminApi('GET', `/admin/applications/${applicant.id}/documents/${old.id}/file`);
      expect(gone.status).toBe(410);
      expect(gone.body.code).toBe('DOCUMENT_SUPERSEDED');
    } finally {
      await deleteApplication(applicant.id);
    }
  });
});

describe('A12: contact-page map', () => {
  it('stores an allow-listed embed URL and the pin, serves them on GET /site, and refuses anything else', async () => {
    const map = { mapEmbedUrl: 'https://www.google.com/maps/embed?pb=!1m18!1m12', mapLat: 24.713552, mapLng: 46.675296 };
    try {
      const put = await adminApi('PUT', '/admin/settings', { body: map });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject(map);
      expect((await adminApi('GET', '/admin/settings')).body).toMatchObject(map);
      expect((await api('GET', '/site')).body.settings).toMatchObject(map);

      for (const bad of [
        { mapEmbedUrl: 'https://evil.example/maps/embed' },
        { mapEmbedUrl: 'http://www.google.com/maps/embed?pb=1' },
        { mapEmbedUrl: 'javascript:alert(1)' },
        { mapLat: 91 },
        { mapLng: -181 },
      ]) {
        expect((await adminApi('PUT', '/admin/settings', { body: bad })).status).toBe(400);
      }
    } finally {
      await adminApi('PUT', '/admin/settings', { body: { mapEmbedUrl: null, mapLat: null, mapLng: null } });
    }
  });
});
