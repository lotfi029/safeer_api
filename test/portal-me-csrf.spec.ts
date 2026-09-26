// test/portal-me-csrf.spec.ts — B16: GET portal/me carries the session's
// CSRF token (the same value GET admin/me would compute), so the portal can
// keep writing after a page reload.

import { api, createApplication, deleteApplication, readMailOtpCode, verifyOtpSession, type TestApplicant } from './helpers';

describe('GET portal/me csrfToken (B16)', () => {
  let applicant: TestApplicant;

  beforeEach(async () => {
    applicant = await createApplication();
  });

  afterEach(async () => {
    await deleteApplication(applicant.id);
  });

  it('returns the same token POST applications issued for this session', async () => {
    const me = await api('GET', '/portal/me', { session: applicant });
    expect(me.status).toBe(200);
    expect(me.body.reference).toBe(applicant.reference);
    expect(me.body.csrfToken).toBe(applicant.csrfToken);
  });

  it('returns the token verify-otp issued, and that token alone authorises a write', async () => {
    const requested = await api('POST', '/portal/auth/request-otp', { body: { identifier: applicant.reference } });
    expect([200, 201]).toContain(requested.status);
    const code = await readMailOtpCode(applicant.id);
    const session = await verifyOtpSession(applicant.reference, code);

    // Simulate a reload: only the cookie survives; the token comes from /me.
    const me = await api('GET', '/portal/me', { session: { cookie: session.cookie, csrfToken: '' } });
    expect(me.status).toBe(200);
    expect(me.body.csrfToken).toBe(session.csrfToken);

    const patch = await api('PATCH', '/portal/application', {
      body: { university: 'Reload University' },
      session: { cookie: session.cookie, csrfToken: me.body.csrfToken },
    });
    expect(patch.status).toBe(200);

    const forged = await api('PATCH', '/portal/application', {
      body: { university: 'No Token University' },
      session: { cookie: session.cookie, csrfToken: 'not-the-token' },
    });
    expect(forged.status).toBe(403);
  });
});
