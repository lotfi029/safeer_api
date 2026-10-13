// test/privacy.spec.ts — Phase 4 of the fix plan, privacy and notifications:
//   C20 the overview's audit feed is admin-only and has no diff / IP hash
//   C23 mail carries human labels (contact subject, invite role), never
//       enum codes
//   C27 newsletter double opt-in + signed unsubscribe; nightly retention

import { issueNewsletterToken } from '../src/contact/newsletter-token.util';
import { adminApi, api, createTempUser, deleteTempUser, withDb } from './helpers';
import { withMailSink } from './smtp-sink';

const APP_KEY = process.env.TEST_APP_ENCRYPTION_KEY!;

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

  // A5 (safeer-delivery-review.md): editors don't own the inbox, so they
  // must not see its unread count either — only admin and support do.
  it.each([
    ['editor', false],
    ['support', true],
  ] as const)('%s sees the unread-messages figures: %s', async (role, visible) => {
    const user = await createTempUser(role);
    try {
      const res = await api('GET', '/admin/overview', { session: user });
      expect(res.status).toBe(200);
      expect('unreadMessages' in res.body.statCards).toBe(visible);
      expect('unreadMessages' in res.body.badges).toBe(visible);
    } finally {
      await deleteTempUser(user.id);
    }
  });

  it('the overview carries no application blocks for any role', async () => {
    const res = await adminApi('GET', '/admin/overview');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['badges', 'contentAlerts', 'recentAuditLog', 'statCards']);
    expect(res.body.statCards.newApplications).toBeUndefined();
    expect(res.body.badges.newApplications).toBeUndefined();
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
  it('the contact notification carries the subject label; the invite carries the role label', async () => {
    await withMailSink(async (sink) => {
      const email = `jest-c23-${Date.now()}@example.com`;
      const sent = await api('POST', '/contact', {
        body: { name: 'Sara Ali', email, phone: null, subject: 'partnership', body: 'Hello there', formRenderedAt: Date.now() - 10_000 },
      });
      expect(sent.status).toBe(201);
      const notify = await sink.waitFor((m) => m.to.includes('inbox@example.com') && (m.html + m.text).includes(email));
      expect(notify.html + notify.text).toContain('شراكة');
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
  it('the nightly job purges old contact messages and stale newsletter rows', async () => {
    const tag = `jest-retention-${Date.now()}`;

    await withDb(async (conn) => {
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
    });

    try {
      expect((await api('POST', '/__dev/maintenance/run')).status).toBe(200);

      expect(await scalar('SELECT COUNT(*) FROM contact_messages WHERE email = ?', [`${tag}@example.com`])).toBe(0);
      expect(await scalar('SELECT COUNT(*) FROM newsletter_subscribers WHERE email LIKE ?', [`${tag}-%`])).toBe(1);
    } finally {
      await withDb(async (conn) => {
        await conn.execute('DELETE FROM newsletter_subscribers WHERE email LIKE ?', [`${tag}-%`]);
      });
    }
  });
});
