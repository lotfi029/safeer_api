// test/otp.spec.ts — Phase 6, area 3: request by reference/email/phone, the
// 5-attempt cap, non-enumerating responses, and B1's email fallback when
// SMS is 'log'. (The 10-minute expiry is exercised by directly moving an
// `applicant_otps` row's `expires_at` into the past — waiting 10 real
// minutes in a test would be its own kind of bug.)
//
// A fresh application per test rather than one shared one:
// `PortalOtpService`'s own per-identifier request-otp limiter (5 per 15
// min, an in-memory LRUCache — independent of the IP-based ThrottlerGuard
// TestAwareThrottlerGuard bypasses under NODE_ENV=test) would otherwise cap
// this file at 5 request-otp calls total against one reference.

import {
  api,
  createApplication,
  deleteApplication,
  readMailOtpCode,
  readSmsOtpCode,
  settleBackground,
  withDb,
  withSmsEnabled,
  type TestApplicant,
} from './helpers';

describe('OTP (B1/B2)', () => {
  let applicant: TestApplicant;

  beforeEach(async () => {
    applicant = await createApplication();
  });

  afterEach(async () => {
    await deleteApplication(applicant.id);
  });

  it('request-otp always resolves {ok:true}, whether or not the identifier matches an application', async () => {
    const real = await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    expect([200, 201]).toContain(real.status);
    expect(real.body.ok).toBe(true);

    const bogus = await api('POST', '/portal/auth/request-otp', { body: { identifier: 'SA-2099-99999' } });
    expect([200, 201]).toContain(bogus.status);
    expect(bogus.body.ok).toBe(true);
    expect(bogus.body.channelHint).toBe(real.body.channelHint);
  });

  it('resolves by reference over SMS when SMS is enabled', async () => {
    await withSmsEnabled(async () => {
      const byReference = await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference, channel: 'sms' } });
      expect([200, 201]).toContain(byReference.status);
      const code = await readSmsOtpCode(applicant.id);
      expect(code).toMatch(/^\d{6}$/);
    });
  });

  it('resolves by a local 05… phone form, matching the E.164 form stored on the row', async () => {
    const localPhone = `05${String(Date.now()).slice(-8)}`;
    const withLocalPhone = await createApplication({ phone: localPhone });
    try {
      const byPhone = await api('POST', '/portal/auth/request-otp', { body: { identifier: localPhone } });
      expect([200, 201]).toContain(byPhone.status);
      await settleBackground(); // A4: the row is written after the response
      const otpCount = await withDb((conn) =>
        conn
          .execute('SELECT COUNT(*) AS c FROM applicant_otps WHERE application_id = ?', [withLocalPhone.id])
          .then(([rows]: any) => Number(rows[0].c)),
      );
      expect(otpCount).toBe(1);
    } finally {
      await deleteApplication(withLocalPhone.id);
    }
  });

  it('verify-otp succeeds with the right code and mints a session', async () => {
    const req = await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    expect([200, 201]).toContain(req.status);
    const code = await readMailOtpCode(applicant.id);
    const verify = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code } });
    expect([200, 201]).toContain(verify.status);
    expect(typeof verify.body.csrfToken).toBe('string');
  });

  it('5 wrong guesses lock out even the right code afterwards (OTP_INVALID both times)', async () => {
    const req = await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    expect([200, 201]).toContain(req.status);
    const code = await readMailOtpCode(applicant.id);
    const wrongCode = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
      const attempt = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: wrongCode } });
      expect(attempt.status).toBe(401);
      expect(attempt.body?.code).toBe('OTP_INVALID');
    }

    const lockedOut = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code } });
    expect(lockedOut.status).toBe(401);
    expect(lockedOut.body?.code).toBe('OTP_INVALID');
  });

  it('an expired code (expires_at in the past) is rejected the same generic way', async () => {
    const req = await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    expect([200, 201]).toContain(req.status);
    const code = await readMailOtpCode(applicant.id);
    await withDb((conn) =>
      conn.execute('UPDATE applicant_otps SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE application_id = ? ORDER BY id DESC LIMIT 1', [
        applicant.id,
      ]),
    );
    const verify = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code } });
    expect(verify.status).toBe(401);
    expect(verify.body?.code).toBe('OTP_INVALID');
  });

  it('B1: falls back to email when SMS is disabled, and records channel=email on the row', async () => {
    const req = await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    expect([200, 201]).toContain(req.status);
    expect(req.body.channelHint).toBe('email');
    await settleBackground();

    const channel = await withDb((conn) =>
      conn
        .execute('SELECT channel FROM applicant_otps WHERE application_id = ? ORDER BY id DESC LIMIT 1', [applicant.id])
        .then(([rows]: any) => rows[0]?.channel),
    );
    expect(channel).toBe('email');
  });
});
