// test/mail-links.spec.ts — real rendered mail through an in-process SMTP
// sink (test/smtp-sink.ts):
//   C2  every link is a locale-prefixed FRONTEND_BASE_URL page
//   C16 names are letters only; contact_ack echoes nothing; typed text never autolinks

import { adminApi, api, createTempUser, deleteTempUser, withDb } from './helpers';
import { withMailSink } from './smtp-sink';

const FRONTEND = process.env.FRONTEND_BASE_URL ?? 'http://localhost:4200';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function contactBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Sara Ali',
    email: `jest-contact-${Date.now()}@example.com`,
    phone: null,
    subject: 'other',
    body: 'Hello there',
    formRenderedAt: Date.now() - 10_000,
    ...overrides,
  };
}

async function deleteContactMessagesFor(email: string) {
  await withDb((conn) => conn.execute('DELETE FROM contact_messages WHERE email = ?', [email]));
}

describe('mail links and content', () => {
  it('C2: invite and password-reset links point at /{locale}/admin/accept|reset/{token}', async () => {
    await withMailSink(async (sink) => {
      const email = `jest-invite-${Date.now()}@example.com`;
      const invited = await adminApi('POST', '/admin/auth/invite', { body: { email, name: 'Invited Person', role: 'editor' } });
      expect(invited.status).toBe(201);
      try {
        const invite = await sink.waitFor((m) => m.to.includes(email));
        expect(invite.text).toMatch(new RegExp(`${escapeRe(FRONTEND)}/ar/admin/accept/[A-Za-z0-9_-]{20,}`));

        // C3: a pending invitation gets no reset link — forgot-password only serves active accounts.
        await api('POST', '/admin/auth/forgot', { body: { email } });
        const active = await createTempUser('editor');
        try {
          await api('POST', '/admin/auth/forgot', { body: { email: active.email } });
          const reset = await sink.waitFor((m) => m.to.includes(active.email) && /admin\/reset\//.test(m.text));
          expect(reset.text).toMatch(new RegExp(`${escapeRe(FRONTEND)}/ar/admin/reset/[A-Za-z0-9_-]{20,}`));
          expect(sink.messages.some((m) => m.to.includes(email) && /admin\/reset\//.test(m.text))).toBe(false);
        } finally {
          await deleteTempUser(active.id);
        }
      } finally {
        await withDb((conn) => conn.execute('DELETE FROM users WHERE email = ?', [email]));
      }
    });
  });

  it('C2/C16: contact_notify links to the message in the inbox; contact_ack echoes nothing typed; typed text never autolinks', async () => {
    await withMailSink(async (sink) => {
      const body = contactBody({ body: 'Visit www.evil.example or http://evil.example/login now' });
      const res = await api('POST', '/contact', { body });
      expect([200, 201]).toContain(res.status);
      try {
        const [row]: any = await withDb((conn) =>
          conn.execute('SELECT id FROM contact_messages WHERE email = ?', [body.email]).then(([rows]: any) => rows),
        );
        const notify = await sink.waitFor((m) => m.to.includes('inbox@example.com') && m.text.includes(String(body.email)));
        expect(notify.text).toContain(`${FRONTEND}/ar/admin/messages/${row.id}`);
        expect(notify.html).not.toMatch(/href="https?:\/\/(www\.)?evil\.example/);
        expect(notify.html).not.toMatch(/href="http:\/\/www\.evil/);

        const ack = await sink.waitFor((m) => m.to.includes(String(body.email)));
        expect(ack.text + ack.html).not.toContain('Sara');
      } finally {
        await deleteContactMessagesFor(String(body.email));
      }
    });
  });

  describe('C16: names are letters, spaces, apostrophes and hyphens only', () => {
    it.each(['http://evil.example', 'www.evil.example', 'x@evil.example', 'Agent 007'])('POST /contact rejects the name %j', async (name) => {
      const res = await api('POST', '/contact', { body: contactBody({ name }) });
      expect(res.status).toBe(400);
    });

    it('accepts Arabic and Latin names with spaces, apostrophes and hyphens', async () => {
      const body = contactBody({ name: "عبد الله O'Brien-Smith" });
      try {
        expect([200, 201]).toContain((await api('POST', '/contact', { body })).status);
      } finally {
        await deleteContactMessagesFor(String(body.email));
      }
    });
  });
});
