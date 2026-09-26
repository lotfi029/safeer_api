// test/privacy.spec.ts — Phase 4 of the fix plan, privacy and notifications:
//   C20 the overview only carries applications for admin/reviewer, and its
//       audit feed is admin-only and has no diff / IP hash
//   C23 mail carries human labels (status, contact subject, invite role),
//       never enum codes, inside a dir/lang wrapper
//   C27 newsletter double opt-in + signed unsubscribe; nightly retention;
//       DELETE admin/applications/:id anonymises (admin only)
//   C28 the ID number is encrypted at rest, decrypted for staff, masked in CSV

import { existsSync } from 'node:fs';
import path from 'node:path';
import { issueNewsletterToken } from '../src/contact/newsletter-token.util';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  BASE,
  adminApi,
  api,
  createApplication,
  createTempUser,
  deleteApplication,
  deleteTempUser,
  loginAs,
  uploadApplicationDocument,
  withDb,
} from './helpers';
import { withMailSink } from './smtp-sink';

const STORAGE_ROOT = path.resolve(process.env.TEST_STORAGE_ROOT ?? './var/assets-test');
const APP_KEY = process.env.TEST_APP_ENCRYPTION_KEY!;

async function setStatus(applicationId: string, status: string) {
  await withDb((conn) => conn.execute('UPDATE applications SET status = ? WHERE id = ?', [status, applicationId]));
}

async function storageKeys(applicationId: string): Promise<string[]> {
  return withDb((conn) =>
    conn.execute('SELECT storage_key FROM application_documents WHERE application_id = ?', [applicationId]).then(([r]: any) => r.map((x: any) => x.storage_key)),
  );
}

async function scalar<T = any>(sql: string, params: any[] = []): Promise<T> {
  return withDb((conn) => conn.execute(sql, params).then(([rows]: any) => (rows[0] ? (Object.values(rows[0])[0] as T) : (undefined as T))));
}

describe('C20: dashboard overview', () => {
  it.each(['support', 'editor'] as const)('%s gets no application figures and no audit feed', async (role) => {
    const user = await createTempUser(role);
    try {
      const res = await api('GET', '/admin/overview', { session: user });
      expect(res.status).toBe(200);
      expect(res.body.latestApplications).toBeUndefined();
      expect(res.body.series).toBeUndefined();
      expect(res.body.statCards.newApplications).toBeUndefined();
      expect(res.body.recentAuditLog).toEqual([]);
    } finally {
      await deleteTempUser(user.id);
    }
  });

  it('reviewer gets application figures but no audit feed', async () => {
    const user = await createTempUser('reviewer');
    try {
      const res = await api('GET', '/admin/overview', { session: user });
      expect(Array.isArray(res.body.latestApplications)).toBe(true);
      expect(res.body.recentAuditLog).toEqual([]);
    } finally {
      await deleteTempUser(user.id);
    }
  });

  it("admin's audit feed has the actor's name and no diff or IP hash", async () => {
    const res = await adminApi('GET', '/admin/overview');
    expect(res.body.recentAuditLog.length).toBeGreaterThan(0);
    for (const entry of res.body.recentAuditLog) {
      expect(Object.keys(entry).sort()).toEqual(['action', 'actorId', 'actorName', 'createdAt', 'entityId', 'entityLabel', 'entityType', 'id']);
    }
    expect(res.body.recentAuditLog.some((e: any) => typeof e.actorName === 'string')).toBe(true);
  });
});

describe('C23: labels in mail', () => {
  it('a status change mail says "قيد المراجعة", not under_review, inside dir="rtl"', async () => {
    await withMailSink(async (sink) => {
      const applicant = await createApplication();
      try {
        await setStatus(applicant.id, 'new');
        expect((await adminApi('PATCH', `/admin/applications/${applicant.id}`, { body: { status: 'under_review' } })).status).toBe(200);
        const mail = await sink.waitFor((m) => m.to.includes(applicant.email) && m.html.includes('قيد المراجعة'));
        expect(mail.html + mail.text).not.toContain('under_review');
        expect(mail.html).toMatch(/<div dir="rtl" lang="ar">/);
      } finally {
        await deleteApplication(applicant.id);
      }
    });
  });

  it('the contact notification carries the subject label; the invite carries the role label', async () => {
    await withMailSink(async (sink) => {
      const email = `jest-c23-${Date.now()}@example.com`;
      const sent = await api('POST', '/contact', {
        body: { name: 'Sara Ali', email, phone: null, subject: 'partnership', body: 'Hello there', formRenderedAt: Date.now() - 10_000 },
      });
      expect(sent.status).toBe(201);
      const notify = await sink.waitFor((m) => m.to.includes('inbox@example.com') && (m.html + m.text).includes(email));
      expect(notify.html + notify.text).toContain('طلب شراكة');
      expect(notify.html + notify.text).not.toMatch(/\bpartnership\b/);
      await withDb((conn) => conn.execute('DELETE FROM contact_messages WHERE email = ?', [email]));

      const invitee = `jest-c23-invite-${Date.now()}@example.com`;
      expect((await adminApi('POST', '/admin/auth/invite', { body: { email: invitee, name: 'Invited Person', role: 'editor' } })).status).toBe(201);
      const invite = await sink.waitFor((m) => m.to.includes(invitee));
      expect(invite.text).toContain('محرر محتوى');
      expect(invite.text).not.toMatch(/\beditor\b/);
      await withDb((conn) => conn.execute('DELETE FROM users WHERE email = ?', [invitee]));
    });
  });
});

describe('C27: newsletter double opt-in', () => {
  it('subscribe → confirm (link from the mail) → unsubscribe (signed)', async () => {
    await withMailSink(async (sink) => {
      const email = `jest-news-${Date.now()}@example.com`;
      try {
        expect((await api('POST', '/newsletter', { body: { email, formRenderedAt: Date.now() - 10_000 } })).status).toBe(201);
        expect(await scalar('SELECT confirmed_at FROM newsletter_subscribers WHERE email = ?', [email])).toBeNull();

        const mail = await sink.waitFor((m) => m.to.includes(email));
        const match = /newsletter\/confirm\?email=([^&\s"]+)&(?:amp;)?token=([A-Za-z0-9._-]+)/.exec(mail.text + mail.html);
        expect(match).not.toBeNull();
        const token = decodeURIComponent(match![2]);

        expect((await api('POST', '/newsletter/confirm', { body: { email, token: token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) } })).status).toBe(400);
        expect((await api('POST', '/newsletter/confirm', { body: { email, token } })).status).toBe(201);
        expect(await scalar('SELECT confirmed_at FROM newsletter_subscribers WHERE email = ?', [email])).not.toBeNull();

        // A confirm token is not an unsubscribe token.
        expect((await api('POST', '/newsletter/unsubscribe', { body: { email, token } })).status).toBe(400);
        const unsubscribe = issueNewsletterToken(APP_KEY, 'unsubscribe', email);
        expect((await api('POST', '/newsletter/unsubscribe', { body: { email, token: unsubscribe } })).status).toBe(201);
        expect(await scalar('SELECT unsubscribed_at FROM newsletter_subscribers WHERE email = ?', [email])).not.toBeNull();
      } finally {
        await withDb((conn) => conn.execute('DELETE FROM newsletter_subscribers WHERE email = ?', [email]));
      }
    });
  });
});

describe('C27: retention', () => {
  it('the nightly job purges old sms_log, contact messages, idle drafts (with files) and stale newsletter rows', async () => {
    const tag = `jest-retention-${Date.now()}`;
    const draft = await createApplication();
    const kept = await createApplication();
    expect((await uploadApplicationDocument(draft, 'id_copy', tag)).status).toBe(201);
    const [draftKey] = await storageKeys(draft.id);
    expect(existsSync(path.join(STORAGE_ROOT, draftKey))).toBe(true);

    await withDb(async (conn) => {
      await conn.execute(
        "INSERT INTO sms_log (template_key, locale, to_phone, message, status, created_at) VALUES ('otp_code', 'ar', '+966500000000', ?, 'sent', UTC_TIMESTAMP(3) - INTERVAL 100 DAY)",
        [tag],
      );
      await conn.execute(
        "INSERT INTO sms_log (template_key, locale, to_phone, message, status, created_at) VALUES ('otp_code', 'ar', '+966500000000', ?, 'sent', UTC_TIMESTAMP(3) - INTERVAL 10 DAY)",
        [`${tag}-recent`],
      );
      await conn.execute(
        "INSERT INTO contact_messages (name, email, subject, body, created_at) VALUES ('Old', ?, 'other', 'x', UTC_TIMESTAMP(3) - INTERVAL 800 DAY)",
        [`${tag}@example.com`],
      );
      await conn.execute(
        'INSERT INTO newsletter_subscribers (email, created_at, confirmed_at, unsubscribed_at) VALUES (?, UTC_TIMESTAMP(3) - INTERVAL 90 DAY, UTC_TIMESTAMP(3) - INTERVAL 90 DAY, UTC_TIMESTAMP(3) - INTERVAL 40 DAY)',
        [`${tag}-unsub@example.com`],
      );
      await conn.execute('INSERT INTO newsletter_subscribers (email, created_at) VALUES (?, UTC_TIMESTAMP(3) - INTERVAL 40 DAY)', [`${tag}-unconfirmed@example.com`]);
      await conn.execute('INSERT INTO newsletter_subscribers (email, created_at, confirmed_at) VALUES (?, UTC_TIMESTAMP(3) - INTERVAL 400 DAY, UTC_TIMESTAMP(3) - INTERVAL 400 DAY)', [
        `${tag}-active@example.com`,
      ]);
      await conn.execute('UPDATE applications SET updated_at = UTC_TIMESTAMP(3) - INTERVAL 200 DAY WHERE id = ?', [draft.id]);
      // A submitted application is never purged by age.
      await conn.execute("UPDATE applications SET status = 'new', updated_at = UTC_TIMESTAMP(3) - INTERVAL 400 DAY WHERE id = ?", [kept.id]);
    });

    try {
      expect((await api('POST', '/__dev/maintenance/run')).status).toBe(200);

      expect(await scalar('SELECT COUNT(*) FROM sms_log WHERE message = ?', [tag])).toBe(0);
      expect(await scalar('SELECT COUNT(*) FROM sms_log WHERE message = ?', [`${tag}-recent`])).toBe(1);
      expect(await scalar('SELECT COUNT(*) FROM contact_messages WHERE email = ?', [`${tag}@example.com`])).toBe(0);
      expect(await scalar('SELECT COUNT(*) FROM newsletter_subscribers WHERE email LIKE ?', [`${tag}-%`])).toBe(1);
      expect(await scalar('SELECT COUNT(*) FROM applications WHERE id = ?', [draft.id])).toBe(0);
      expect(existsSync(path.join(STORAGE_ROOT, draftKey))).toBe(false);
      expect(await scalar('SELECT COUNT(*) FROM applications WHERE id = ?', [kept.id])).toBe(1);
    } finally {
      await withDb(async (conn) => {
        await conn.execute('DELETE FROM sms_log WHERE message LIKE ?', [`${tag}%`]);
        await conn.execute('DELETE FROM newsletter_subscribers WHERE email LIKE ?', [`${tag}-%`]);
      });
      await deleteApplication(draft.id);
      await deleteApplication(kept.id);
    }
  });
});

describe('C27: DELETE admin/applications/:id anonymises', () => {
  it('reviewers cannot; an admin removes the PII, documents (files too), notes and logs, and it is audited', async () => {
    const applicant = await createApplication({ firstName: 'Anon', idNumber: '1098765432' });
    expect((await uploadApplicationDocument(applicant, 'id_copy', 'anon')).status).toBe(201);
    const [key] = await storageKeys(applicant.id);
    await setStatus(applicant.id, 'new');
    expect((await adminApi('POST', `/admin/applications/${applicant.id}/notes`, { body: { body: 'private note' } })).status).toBe(201);

    const reviewer = await createTempUser('reviewer');
    try {
      expect((await api('DELETE', `/admin/applications/${applicant.id}`, { session: reviewer })).status).toBe(403);

      const res = await adminApi('DELETE', `/admin/applications/${applicant.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ anonymized: true, reference: applicant.reference });

      const [row]: any = await withDb((conn) => conn.execute('SELECT * FROM applications WHERE id = ?', [applicant.id]).then(([r]: any) => r));
      for (const column of ['first_name', 'last_name', 'email', 'phone', 'phone_e164', 'id_number_encrypted', 'birth_date']) {
        expect(row[column]).toBeNull();
      }
      expect(row.anonymized_at).not.toBeNull();
      expect(row.reference).toBe(applicant.reference);
      expect(await scalar('SELECT COUNT(*) FROM application_documents WHERE application_id = ?', [applicant.id])).toBe(0);
      expect(await scalar('SELECT COUNT(*) FROM application_notes WHERE application_id = ?', [applicant.id])).toBe(0);
      expect(await scalar("SELECT COUNT(*) FROM mail_log WHERE entity_type = 'applications' AND entity_id = ?", [applicant.id])).toBe(0);
      expect(existsSync(path.join(STORAGE_ROOT, key))).toBe(false);
      // The audit row lands just after the response.
      let action: string | undefined;
      for (let i = 0; i < 50 && action !== 'delete'; i++) {
        action = await scalar("SELECT action FROM audit_log WHERE entity_type = 'applications' AND entity_id = ? ORDER BY id DESC LIMIT 1", [applicant.id]);
        if (action !== 'delete') await new Promise((r) => setTimeout(r, 50));
      }
      expect(action).toBe('delete');
    } finally {
      await deleteTempUser(reviewer.id);
      await deleteApplication(applicant.id);
    }
  });
});

describe('C28: ID number encrypted at rest', () => {
  it('the table holds no plaintext; staff see it decrypted; the CSV shows only the last 4 digits', async () => {
    const idNumber = `10${String(Date.now()).slice(-8)}`;
    const applicant = await createApplication({ idNumber });
    try {
      const columns: any[] = await withDb((conn) => conn.execute("SHOW COLUMNS FROM applications LIKE 'id_number%'").then(([r]: any) => r));
      expect(columns.map((c) => c.Field)).toEqual(['id_number_encrypted']);
      const stored: Buffer = await scalar('SELECT id_number_encrypted FROM applications WHERE id = ?', [applicant.id]);
      expect(stored).toBeInstanceOf(Buffer);
      expect(stored.toString('latin1')).not.toContain(idNumber);

      const detail = await adminApi('GET', `/admin/applications/${applicant.id}`);
      expect(detail.body.personal.idNumber).toBe(idNumber);
      const me = await api('GET', '/portal/me', { session: applicant });
      expect(JSON.stringify(me.body)).toContain(idNumber);

      await setStatus(applicant.id, 'new');
      const admin = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
      const csv = await fetch(`${BASE}/admin/applications/export.csv?q=${applicant.reference}`, { headers: { Cookie: admin.cookie } }).then((r) => r.text());
      expect(csv).toContain('ID (last 4)');
      expect(csv).toContain(`••••${idNumber.slice(-4)}`);
      expect(csv).not.toContain(idNumber);
    } finally {
      await deleteApplication(applicant.id);
    }
  });
});
