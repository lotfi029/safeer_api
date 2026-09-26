// test/otp-hardening.spec.ts — Phase 1 of the fix plan:
//   C1  no OTP code stored in mail_log / sms_log (subject, payload, message)
//   C22 older codes invalidated, a per-application request budget shared by
//       reference/email/phone, and a DB-backed daily failure lock (10)
//   B1  SMS goes to the E.164 number; a hanging SMS provider times out (C21)
//       and the code falls back to email

import http from 'node:http';
import {
  adminApi,
  api,
  createApplication,
  deleteApplication,
  readMailOtpCode,
  readOtp,
  readSmsOtpCode,
  withDb,
  withSmsEnabled,
  type TestApplicant,
} from './helpers';

async function otpRows(applicationId: string): Promise<Array<{ consumed_at: Date | null; channel: string }>> {
  return withDb((conn) =>
    conn
      .execute('SELECT consumed_at, channel FROM applicant_otps WHERE application_id = ? ORDER BY id', [applicationId])
      .then(([rows]: any) => rows),
  );
}

describe('OTP hardening', () => {
  let applicant: TestApplicant;

  beforeEach(async () => {
    applicant = await createApplication();
  });

  afterEach(async () => {
    await deleteApplication(applicant.id);
  });

  it('C1: the code is in neither mail_log (subject/payload) nor sms_log', async () => {
    await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    const mailCode = await readMailOtpCode(applicant.id);
    const mailRows: any[] = await withDb((conn) =>
      conn
        .execute("SELECT subject, payload FROM mail_log WHERE template_key = 'otp_code' AND entity_id = ?", [applicant.id])
        .then(([rows]: any) => rows),
    );
    expect(mailRows.length).toBeGreaterThan(0);
    for (const row of mailRows) {
      expect(`${row.subject} ${JSON.stringify(row.payload)}`).not.toContain(mailCode);
    }

    await withSmsEnabled(async () => {
      await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference, channel: 'sms' } });
      const smsCode = await readSmsOtpCode(applicant.id);
      const smsRows: any[] = await withDb((conn) =>
        conn
          .execute("SELECT message FROM sms_log WHERE template_key = 'otp_code' AND entity_id = ?", [applicant.id])
          .then(([rows]: any) => rows),
      );
      expect(smsRows.length).toBeGreaterThan(0);
      for (const row of smsRows) {
        expect(row.message).not.toContain(smsCode);
        expect(row.message).toContain('••••••');
      }
    });
  });

  it('C22: issuing a new code invalidates the previous one', async () => {
    await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    const first = await readMailOtpCode(applicant.id);
    await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    const second = await readMailOtpCode(applicant.id);

    const rows = await otpRows(applicant.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].consumed_at).not.toBeNull();
    expect(rows[1].consumed_at).toBeNull();

    if (first !== second) {
      const old = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: first } });
      expect(old.status).toBe(401);
    }
    const fresh = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: second } });
    expect([200, 201]).toContain(fresh.status);
  });

  it('C22: one request budget per application, however it is named (reference, email, phone)', async () => {
    const identifiers = [applicant.reference, applicant.reference, applicant.reference, applicant.email, applicant.email, applicant.phone];
    for (const identifier of identifiers) {
      const res = await api('POST', '/portal/auth/request-otp', { body: { identifier } });
      expect([200, 201]).toContain(res.status);
      expect(res.body.ok).toBe(true);
    }
    // 6 requests, 5 codes: the 6th was silently dropped (same {ok:true}).
    expect(await otpRows(applicant.id)).toHaveLength(5);
  });

  it('C22: 10 wrong codes in a day lock OTP sign-in for that application, even with the right code', async () => {
    for (let round = 0; round < 2; round++) {
      await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
      const code = await readMailOtpCode(applicant.id);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        const res = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: wrong } });
        expect(res.status).toBe(401);
      }
    }
    const [row]: any = await withDb((conn) =>
      conn
        .execute('SELECT otp_fail_count, otp_fail_date = UTC_DATE() AS today FROM applications WHERE id = ?', [applicant.id])
        .then(([rows]: any) => rows),
    );
    expect(Number(row.otp_fail_count)).toBe(10);
    expect(Number(row.today)).toBe(1);

    // Locked: a new request sends nothing (no new row), same response as ever.
    const before = (await otpRows(applicant.id)).length;
    const req = await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.email } });
    expect(req.body.ok).toBe(true);
    expect(await otpRows(applicant.id)).toHaveLength(before);

    // Even a live, correct code is refused while locked.
    await withDb((conn) => conn.execute('UPDATE applicant_otps SET consumed_at = NULL, attempts = 0 WHERE application_id = ? ORDER BY id DESC LIMIT 1', [applicant.id]));
    const { code } = await readOtp(applicant.id);
    const locked = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code } });
    expect(locked.status).toBe(401);

    // A new UTC day resets the counter.
    await withDb((conn) => conn.execute('UPDATE applications SET otp_fail_date = UTC_DATE() - INTERVAL 1 DAY WHERE id = ?', [applicant.id]));
    const unlocked = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code } });
    expect([200, 201]).toContain(unlocked.status);
  });

  it('B1: SMS goes to the E.164 form of a local 05… number', async () => {
    const local = await createApplication({ phone: `05${String(Date.now()).slice(-8)}` });
    try {
      await withSmsEnabled(async () => {
        await api('POST', '/portal/auth/request-otp', { body: { identifier: local.reference, channel: 'sms' } });
        await readSmsOtpCode(local.id);
        const [row]: any = await withDb((conn) =>
          conn
            .execute("SELECT to_phone FROM sms_log WHERE template_key = 'otp_code' AND entity_id = ? ORDER BY id DESC LIMIT 1", [local.id])
            .then(([rows]: any) => rows),
        );
        expect(row.to_phone).toMatch(/^\+9665\d{8}$/);
      });
    } finally {
      await deleteApplication(local.id);
    }
  });

  it('B1/C21: an SMS provider that never answers times out and the code falls back to email', async () => {
    const hanging = http.createServer(() => undefined); // accepts, never responds
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    hanging.unref();
    const port = (hanging.address() as any).port;
    const before = await adminApi('GET', '/admin/sms/settings');
    try {
      const put = await adminApi('PUT', '/admin/sms/settings', {
        body: { isEnabled: true, driver: 'http', providerUrl: `http://127.0.0.1:${port}/send` },
      });
      expect(put.status).toBe(200);
      const started = Date.now();
      const res = await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference, channel: 'sms' } });
      expect([200, 201]).toContain(res.status);
      expect(Date.now() - started).toBeLessThan(9000);
      expect((await readOtp(applicant.id)).channel).toBe('email');
      const [row]: any = await withDb((conn) =>
        conn
          .execute("SELECT status FROM sms_log WHERE template_key = 'otp_code' AND entity_id = ? ORDER BY id DESC LIMIT 1", [applicant.id])
          .then(([rows]: any) => rows),
      );
      expect(row.status).toBe('failed');
    } finally {
      await adminApi('PUT', '/admin/sms/settings', {
        body: { isEnabled: before.body.isEnabled, driver: before.body.driver, providerUrl: before.body.providerUrl ?? null },
      });
      hanging.closeAllConnections();
      hanging.close();
    }
  });
});
