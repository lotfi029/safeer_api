// test/utc.spec.ts — C9: OTPs, reset tokens and sessions expire at the right
// moment whatever the process time zone. global-setup.ts boots the app with
// TZ=Asia/Riyadh (UTC+3), and CI also runs MySQL itself off-UTC, so a
// connection that isn't pinned to UTC shows up here as a 3-hour error:
// - write side: `expires_at` is compared with UTC_TIMESTAMP(), not NOW(),
//   so the assertion holds only if the app wrote a UTC value;
// - check side: rows expiring a minute from now (UTC) must still be
//   accepted, and rows a minute past must be refused.

import { createHash, randomBytes } from 'node:crypto';
import { api, createApplication, createTempUser, deleteApplication, deleteTempUser, loginAs, readMailOtpCode, waitForAuthToken, withDb } from './helpers';

const IDLE_HOURS = Number(process.env.SESSION_IDLE_HOURS ?? 8);
const ABSOLUTE_DAYS = Number(process.env.SESSION_ABSOLUTE_DAYS ?? 30);

/** Seconds from UTC now until the given DATETIME column value. */
async function secondsUntil(table: string, column: string, where: string, params: Array<string | number>): Promise<number> {
  return withDb((conn) =>
    conn
      .execute(`SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), ${column}) AS s FROM ${table} WHERE ${where} ORDER BY id DESC LIMIT 1`, params)
      .then(([rows]: any) => Number(rows[0].s)),
  );
}

async function exec(sql: string, params: Array<string | number>): Promise<void> {
  await withDb((conn) => conn.execute(sql, params));
}

describe('UTC everywhere (C9)', () => {
  it('the app process really runs off-UTC in this suite', () => {
    expect(process.env.TEST_APP_TZ).not.toMatch(/^(UTC|Etc\/UTC|Z)?$/);
  });

  it('OTP: written as UTC now + 10 min; accepted until then, refused after', async () => {
    const applicant = await createApplication();
    try {
      await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
      const left = await secondsUntil('applicant_otps', 'expires_at', 'application_id = ?', [applicant.id]);
      expect(Math.abs(left - 600)).toBeLessThanOrEqual(15);

      // One minute left on the UTC clock: still valid.
      await exec('UPDATE applicant_otps SET expires_at = UTC_TIMESTAMP(3) + INTERVAL 1 MINUTE WHERE application_id = ?', [applicant.id]);
      const code = await readMailOtpCode(applicant.id);
      const ok = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code } });
      expect([200, 201]).toContain(ok.status);

      // A fresh code, expired a minute ago on the UTC clock: refused.
      await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
      await exec(
        'UPDATE applicant_otps SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE application_id = ? AND consumed_at IS NULL',
        [applicant.id],
      );
      const expiredCode = await readMailOtpCode(applicant.id);
      const refused = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: expiredCode } });
      expect(refused.status).toBe(401);
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('password reset token: written as UTC now + 60 min; accepted until then, refused after', async () => {
    const user = await createTempUser('editor');
    try {
      const forgot = await api('POST', '/admin/auth/forgot', { body: { email: user.email } });
      expect([200, 201]).toContain(forgot.status);
      await waitForAuthToken(user.id);
      const left = await secondsUntil('auth_tokens', 'expires_at', "user_id = ? AND purpose = 'reset'", [user.id]);
      expect(Math.abs(left - 3600)).toBeLessThanOrEqual(15);

      const insertToken = async (offset: string) => {
        const raw = randomBytes(32).toString('base64url');
        const hash = createHash('sha256').update(raw).digest('hex');
        await exec(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, 'reset', ?, UTC_TIMESTAMP(3) ${offset})`, [
          user.id,
          hash,
        ]);
        return raw;
      };

      const expired = await insertToken('- INTERVAL 1 MINUTE');
      const refused = await api('POST', `/admin/auth/reset/${expired}`, { body: { password: 'Utc-Reset-P4ssword!' } });
      expect(refused.status).toBe(400);

      const valid = await insertToken('+ INTERVAL 1 MINUTE');
      const accepted = await api('POST', `/admin/auth/reset/${valid}`, { body: { password: 'Utc-Reset-P4ssword!' } });
      expect(accepted.status).toBe(201);
    } finally {
      await deleteTempUser(user.id);
    }
  });

  it('staff session: absolute and idle expiry are measured on the UTC clock', async () => {
    const user = await createTempUser('editor');
    try {
      const where = 'user_id = ? AND revoked_at IS NULL';
      const left = await secondsUntil('sessions', 'expires_at', where, [user.id]);
      expect(Math.abs(left - ABSOLUTE_DAYS * 86400)).toBeLessThanOrEqual(15);

      // Idle: seen (idle − 1) hours ago is still live; (idle + 1) hours ago is not.
      await exec(`UPDATE sessions SET last_seen_at = UTC_TIMESTAMP(3) - INTERVAL ${IDLE_HOURS - 1} HOUR WHERE ${where}`, [user.id]);
      expect((await api('GET', '/admin/me', { session: user })).status).toBe(200);
      await exec(`UPDATE sessions SET last_seen_at = UTC_TIMESTAMP(3) - INTERVAL ${IDLE_HOURS + 1} HOUR WHERE ${where}`, [user.id]);
      expect((await api('GET', '/admin/me', { session: user })).status).toBe(401);

      // Absolute: one minute left is live; one minute past is not.
      const second = await loginAs(user.email, 'Jest-Test-P4ssword!');
      await exec(`UPDATE sessions SET expires_at = UTC_TIMESTAMP(3) + INTERVAL 1 MINUTE WHERE ${where}`, [user.id]);
      expect((await api('GET', '/admin/me', { session: second })).status).toBe(200);
      await exec(`UPDATE sessions SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE ${where}`, [user.id]);
      expect((await api('GET', '/admin/me', { session: second })).status).toBe(401);
    } finally {
      await deleteTempUser(user.id);
    }
  });

  it('applicant session: absolute expiry is written on the UTC clock', async () => {
    const applicant = await createApplication();
    try {
      const left = await secondsUntil('applicant_sessions', 'expires_at', 'application_id = ?', [applicant.id]);
      const days = Number(process.env.APPLICANT_SESSION_ABSOLUTE_DAYS ?? 7);
      expect(Math.abs(left - days * 86400)).toBeLessThanOrEqual(15);
    } finally {
      await deleteApplication(applicant.id);
    }
  });
});
