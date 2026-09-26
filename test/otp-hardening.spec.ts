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
  settleBackground,
  withDb,
  withSmsEnabled,
  type TestApplicant,
} from './helpers';
import { withMailSink } from './smtp-sink';

async function otpRows(applicationId: string): Promise<Array<{ consumed_at: Date | null; channel: string }>> {
  return withDb((conn) =>
    conn
      .execute('SELECT consumed_at, channel FROM applicant_otps WHERE application_id = ? ORDER BY id', [applicationId])
      .then(([rows]: any) => rows),
  );
}

/** A1: the day count, the rolling-hour count, and seconds left on the hour lock (null when none). */
async function otpCounters(applicationId: string): Promise<{ day: number; hour: number; lockLeft: number | null }> {
  const [row]: any = await withDb((conn) =>
    conn
      .execute(
        `SELECT IF(otp_fail_date = UTC_DATE(), otp_fail_count, 0) AS day, otp_hour_count AS hour,
                IF(otp_locked_until > UTC_TIMESTAMP(3), TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), otp_locked_until), NULL) AS lock_left
           FROM applications WHERE id = ?`,
        [applicationId],
      )
      .then(([rows]: any) => rows),
  );
  return { day: Number(row.day), hour: Number(row.hour), lockLeft: row.lock_left === null ? null : Number(row.lock_left) };
}

/** Two codes, five wrong guesses each: 10 failures against live codes. */
async function spendTwoCodes(applicant: TestApplicant): Promise<void> {
  for (let round = 0; round < 2; round++) {
    await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    const code = await readMailOtpCode(applicant.id);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: wrong } });
      expect(res.status).toBe(401);
    }
  }
}

/** Makes the last code live again (attempts back to 0) and returns it. */
async function reviveLastCode(applicationId: string): Promise<string> {
  await withDb((conn) => conn.execute('UPDATE applicant_otps SET consumed_at = NULL, attempts = 0 WHERE application_id = ? ORDER BY id DESC LIMIT 1', [applicationId]));
  return (await readOtp(applicationId)).code;
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
    await settleBackground();
    expect(await otpRows(applicant.id)).toHaveLength(5);
  });

  // A1 (safeer-delivery-review.md): a verify used to count as a failure even
  // when no code had been issued, so 10 calls with nothing but a reference
  // locked any applicant out until the next UTC day.
  it('A1: failed verifies against no live code never count toward a lock', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: '000000' } });
      expect(res.status).toBe(401);
      expect(res.body?.code).toBe('OTP_INVALID');
    }
    expect(await otpCounters(applicant.id)).toEqual({ day: 0, hour: 0, lockLeft: null });

    // The applicant can still sign in normally.
    await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    const code = await readMailOtpCode(applicant.id);
    const ok = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code } });
    expect([200, 201]).toContain(ok.status);
  });

  it('A1: guesses against a spent code (5 attempts used) don’t count either', async () => {
    await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    const code = await readMailOtpCode(applicant.id);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 10; i++) {
      expect((await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: wrong } })).status).toBe(401);
    }
    expect(await otpCounters(applicant.id)).toEqual({ day: 5, hour: 5, lockLeft: null });
  });

  it('A1/C22: 10 wrong codes inside an hour lock OTP sign-in for 1 h, even with the right code', async () => {
    await spendTwoCodes(applicant);
    const counters = await otpCounters(applicant.id);
    expect(counters.day).toBe(10);
    expect(counters.hour).toBe(0); // the window restarts once it locks
    expect(Math.abs(Number(counters.lockLeft) - 3600)).toBeLessThanOrEqual(15);

    // Locked: a new request sends nothing (no new row), same response as ever.
    const before = (await otpRows(applicant.id)).length;
    const req = await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.email } });
    expect(req.body.ok).toBe(true);
    await settleBackground();
    expect(await otpRows(applicant.id)).toHaveLength(before);

    // Even a live, correct code is refused while locked.
    const code = await reviveLastCode(applicant.id);
    const locked = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code } });
    expect(locked.status).toBe(401);

    // The lock ends after an hour — not at the end of the UTC day.
    await withDb((conn) => conn.execute('UPDATE applications SET otp_locked_until = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ?', [applicant.id]));
    const unlocked = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code } });
    expect([200, 201]).toContain(unlocked.status);
    expect(await otpCounters(applicant.id)).toMatchObject({ day: 0, hour: 0 });
  });

  it('A1: a window older than an hour starts again', async () => {
    await withDb((conn) =>
      conn.execute('UPDATE applications SET otp_hour_start = UTC_TIMESTAMP(3) - INTERVAL 61 MINUTE, otp_hour_count = 9 WHERE id = ?', [applicant.id]),
    );
    await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    const code = await readMailOtpCode(applicant.id);
    await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: code === '000000' ? '111111' : '000000' } });
    expect(await otpCounters(applicant.id)).toEqual({ day: 1, hour: 1, lockLeft: null });
  });

  it('A1: 30 wrong codes in a UTC day lock OTP sign-in until the next day', async () => {
    await withDb((conn) => conn.execute('UPDATE applications SET otp_fail_count = 29, otp_fail_date = UTC_DATE() WHERE id = ?', [applicant.id]));
    await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    const code = await readMailOtpCode(applicant.id);
    await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: code === '000000' ? '111111' : '000000' } });
    expect(await otpCounters(applicant.id)).toEqual({ day: 30, hour: 1, lockLeft: null });

    const refused = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code } });
    expect(refused.status).toBe(401);

    await withDb((conn) => conn.execute('UPDATE applications SET otp_fail_date = UTC_DATE() - INTERVAL 1 DAY WHERE id = ?', [applicant.id]));
    const nextDay = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code } });
    expect([200, 201]).toContain(nextDay.status);
  });

  it('A4: a match and a miss answer alike, without waiting for the send', async () => {
    const hanging = http.createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    hanging.unref();
    const before = await adminApi('GET', '/admin/sms/settings');
    try {
      await adminApi('PUT', '/admin/sms/settings', {
        body: { isEnabled: true, driver: 'http', providerUrl: `http://127.0.0.1:${(hanging.address() as any).port}/send` },
      });
      const timed = async (identifier: string) => {
        const started = Date.now();
        const res = await api('POST', '/portal/auth/request-otp', { body: { identifier, channel: 'sms' } });
        return { ms: Date.now() - started, status: res.status, body: res.body };
      };
      const match = await timed(applicant.reference);
      const miss = await timed(`SA-2099-${Math.floor(Math.random() * 90000 + 10000)}`);
      expect(match.ms).toBeLessThan(1000);
      expect(miss.ms).toBeLessThan(1000);
      expect({ status: match.status, body: match.body }).toEqual({ status: miss.status, body: miss.body });
      await settleBackground();
    } finally {
      await adminApi('PUT', '/admin/sms/settings', {
        body: { isEnabled: before.body.isEnabled, driver: before.body.driver, providerUrl: before.body.providerUrl ?? null },
      });
      hanging.closeAllConnections();
      hanging.close();
    }
  });

  it('A4: two quick requests are issued in order — the second code is the one delivered last, and the only one that verifies', async () => {
    await withMailSink(async (sink) => {
      // Back to back: the second request arrives while the first code is still being issued and sent.
      await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference, channel: 'email' } });
      await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.email, channel: 'email' } });
      await settleBackground();

      const mails = sink.messages.filter((m) => m.to.includes(applicant.email));
      expect(mails).toHaveLength(2);
      const [firstCode, secondCode] = mails.map((m) => /\b(\d{6})\b/.exec(m.text)?.[1]);
      expect(firstCode).toMatch(/^\d{6}$/);
      expect(secondCode).toMatch(/^\d{6}$/);
      expect((await readOtp(applicant.id)).code).toBe(secondCode);

      const rows = await otpRows(applicant.id);
      expect(rows.map((r) => r.consumed_at === null)).toEqual([false, true]);
      if (firstCode !== secondCode) {
        const stale = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: firstCode } });
        expect(stale.status).toBe(401);
      }
      const live = await api('POST', '/portal/auth/verify-otp', { body: { identifier: applicant.reference, code: secondCode } });
      expect([200, 201]).toContain(live.status);
    });
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
      // A4: the answer no longer waits for the SMS (it used to take 5 s+ here).
      expect(Date.now() - started).toBeLessThan(1000);

      // B1: the row is committed before the send — it exists while the SMS still hangs.
      const deadline = Date.now() + 3000;
      while ((await otpRows(applicant.id)).length === 0) {
        if (Date.now() > deadline) throw new Error('no applicant_otps row while the SMS was hanging');
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(Date.now() - started).toBeLessThan(4500);

      // After the 5 s timeout the code falls back to email.
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
