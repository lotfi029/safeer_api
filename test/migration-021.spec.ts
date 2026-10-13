// test/migration-021.spec.ts — feat/governance-contact (A4): 021 on a
// database that was in use before it (migrated to 020 with the dev fixtures,
// then written to):
//   - a staff account still holding `reviewer` stops it before anything
//     changes, with a message that says what to do;
//   - once that account is reassigned it applies: the scholarship and SMS
//     tables are gone, a `scholarship` contact message becomes `inquiry`, the
//     scholarships page and its mail templates are deleted, and buttons that
//     led to /apply, /portal or /scholarships lead to /contact.

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, dbEnv, dropDatabase, recreateDatabase, runScript, withServer } from './scripts.helpers';

const APP_ENV: Record<string, string> = JSON.parse(process.env.TEST_APP_ENV ?? '{}');
const DB = `${process.env.TEST_DB_NAME}_m021`;

async function scalar(sql: string, params: unknown[] = []): Promise<any> {
  return withServer(async (conn) => {
    const [rows]: any = await conn.query(sql, params);
    return rows[0] ? Object.values(rows[0])[0] : undefined;
  }, DB);
}

describe('021_remove_portal_sms on a database in use', () => {
  let dir: string;

  afterAll(async () => {
    await dropDatabase(DB);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('refuses while a reviewer exists, then removes the feature and moves scholarship messages to inquiry', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'safeer-m021-'));
    mkdirSync(path.join(dir, 'dev'));
    const all = readdirSync(path.join(ROOT, 'migrations')).filter((f) => /^\d{3}_.*\.(sql|mjs)$/.test(f));
    for (const f of all.filter((f) => f < '021')) copyFileSync(path.join(ROOT, 'migrations', f), path.join(dir, f));
    copyFileSync(path.join(ROOT, 'migrations/dev/003_dev_sample.sql'), path.join(dir, 'dev/003_dev_sample.sql'));
    await recreateDatabase(DB);
    const env = dbEnv(DB, { MIGRATIONS_DIR: dir, APP_ENCRYPTION_KEY: APP_ENV.APP_ENCRYPTION_KEY, STORAGE_ROOT: path.join(dir, 'assets') });
    expect(runScript('scripts/migrate.mjs', env).status).toBe(0);

    await withServer(async (conn) => {
      await conn.query(
        "INSERT INTO contact_messages (name, email, subject, body) VALUES ('Old enquiry', 'm021@example.com', 'scholarship', 'About the scholarship')",
      );
      await conn.query("INSERT INTO users (name, email, password_hash, role, status) VALUES ('A reviewer', 'm021-reviewer@example.com', 'x', 'reviewer', 'active')");
    }, DB);
    expect(Number(await scalar("SELECT COUNT(*) FROM contact_messages WHERE subject = 'scholarship'"))).toBeGreaterThan(0);

    copyFileSync(path.join(ROOT, 'migrations/021_remove_portal_sms.sql'), path.join(dir, '021_remove_portal_sms.sql'));
    const refused = runScript('scripts/migrate.mjs', env);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('021_remove_portal_sms.sql failed');
    expect(refused.output).toContain('021_reassign_reviewer_users_first');
    // The guard runs before any DDL: nothing changed.
    expect(Number(await scalar("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ? AND table_name = 'applications'", [DB]))).toBe(1);
    expect(await scalar("SELECT COLUMN_TYPE FROM information_schema.columns WHERE table_schema = ? AND table_name = 'users' AND column_name = 'role'", [DB])).toContain(
      'reviewer',
    );
    expect(Number(await scalar("SELECT COUNT(*) FROM schema_migrations WHERE version = '021_remove_portal_sms.sql'"))).toBe(0);

    await withServer((conn) => conn.query("UPDATE users SET role = 'editor' WHERE email = 'm021-reviewer@example.com'"), DB);
    const applied = runScript('scripts/migrate.mjs', env);
    expect(applied.output).not.toContain('failed');
    expect(applied.status).toBe(0);

    const gone = ['applications', 'application_documents', 'application_notes', 'application_events', 'interview_slots', 'applicant_sessions', 'applicant_otps', 'counters', 'sms_log', 'sms_settings', 'sms_templates'];
    const [left]: any = await withServer(
      (conn) => conn.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_name IN (?)', [DB, gone]),
      DB,
    );
    expect(left).toEqual([]);
    expect(await scalar("SELECT COUNT(*) FROM contact_messages WHERE subject = 'inquiry' AND email = 'm021@example.com'")).toBe(1);
    expect(await scalar("SELECT COLUMN_TYPE FROM information_schema.columns WHERE table_schema = ? AND table_name = 'contact_messages' AND column_name = 'subject'", [DB])).toBe(
      "enum('inquiry','partnership','support','feedback','other')",
    );
    expect(await scalar("SELECT COLUMN_TYPE FROM information_schema.columns WHERE table_schema = ? AND table_name = 'users' AND column_name = 'role'", [DB])).toBe(
      "enum('admin','editor','support')",
    );
    expect(await scalar("SELECT COUNT(*) FROM pages WHERE slug = 'scholarships'")).toBe(0);
    expect(await scalar("SELECT COUNT(*) FROM about_items WHERE kind NOT IN ('vision', 'mission', 'goal', 'care_pillar')")).toBe(0);
    expect(await scalar("SELECT COUNT(*) FROM mail_templates WHERE `key` IN ('otp_code', 'application_started', 'interview_booked')")).toBe(0);
    expect(await scalar("SELECT COUNT(*) FROM mail_templates WHERE `key` IN ('contact_ack', 'contact_notify', 'password_reset')")).toBe(3);
    expect(
      await scalar("SELECT COUNT(*) FROM page_sections WHERE primary_button_url REGEXP '^/(apply|portal|scholarships)' OR secondary_button_url REGEXP '^/(apply|portal|scholarships)'"),
    ).toBe(0);
    expect(
      await scalar(
        "SELECT s.primary_button_url FROM page_sections s JOIN pages p ON p.id = s.page_id WHERE p.slug = 'home' AND s.section_key = 'hero'",
      ),
    ).toBe('/contact');
    const [settingsColumns]: any = await withServer(
      (conn) =>
        conn.query(
          "SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ? AND table_name = 'site_settings' AND column_name IN ('notify_email_on_status_change', 'notify_sms_on_status_change', 'application_ref_prefix')",
          [DB],
        ),
      DB,
    );
    expect(settingsColumns).toEqual([]);

    expect(runScript('scripts/migrate.mjs', env).stdout).toContain('Nothing to migrate');
  }, 120_000);
});
