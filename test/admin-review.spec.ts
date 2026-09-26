// test/admin-review.spec.ts — Phase 6, area 5: the status-transition map
// (valid/invalid), reject-without-reason (400), assignee validation (B7),
// bulk actions with partial failures, CSV export headers/encoding, and
// notes never exposed on /portal/*.

import { adminApi, api, createApplication, createTempUser, deleteApplication, deleteTempUser, uploadApplicationDocument, withDb, type TestApplicant } from './helpers';

async function submittedApplication(overrides: Record<string, unknown> = {}): Promise<TestApplicant> {
  const applicant = await createApplication(overrides);
  for (const docType of ['id_copy', 'certificate', 'admission_letter']) {
    await uploadApplicationDocument(applicant, docType, `review-${docType}`);
  }
  await api('POST', '/portal/application/submit', {
    session: applicant,
    body: {
      firstName: overrides.firstName ?? 'محمد',
      lastName: overrides.lastName ?? 'الاختبار',
      birthDate: '2000-01-01',
      phone: `+9665${String(Date.now()).slice(-8)}`,
      nationality: 'SA',
      email: applicant.email,
      gender: 'male',
      university: 'Test University',
      major: 'Testing',
      degreeLevel: 'bachelor',
      consent: true,
    },
  });
  return applicant;
}

describe('admin review', () => {
  it('the status-transition map allows under_review -> interview but not new -> interview directly', async () => {
    const applicant = await submittedApplication();
    try {
      const invalid = await adminApi('PATCH', `/admin/applications/${applicant.id}`, { body: { status: 'interview' } });
      expect(invalid.status).toBe(409);
      expect(invalid.body?.code).toBe('INVALID_STATUS_TRANSITION');

      const toUnderReview = await adminApi('PATCH', `/admin/applications/${applicant.id}`, { body: { status: 'under_review' } });
      expect(toUnderReview.status).toBe(200);

      const valid = await adminApi('PATCH', `/admin/applications/${applicant.id}`, { body: { status: 'interview' } });
      expect(valid.status).toBe(200);
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('rejecting a document without a reason is 400', async () => {
    const applicant = await submittedApplication();
    try {
      const detail = await adminApi('GET', `/admin/applications/${applicant.id}`);
      const doc = detail.body.documents[0];
      const reject = await adminApi('PATCH', `/admin/applications/${applicant.id}/documents/${doc.id}`, { body: { status: 'rejected' } });
      expect(reject.status).toBe(400);
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('B7: assigning a non-reviewer role or a locked account is 422 INVALID_ASSIGNEE; a valid unlocked reviewer succeeds', async () => {
    const applicant = await submittedApplication();
    const editor = await createTempUser('editor');
    const reviewer = await createTempUser('reviewer');
    try {
      const toEditor = await adminApi('PATCH', `/admin/applications/${applicant.id}`, { body: { assignedReviewerId: editor.id } });
      expect(toEditor.status).toBe(422);
      expect(toEditor.body?.code).toBe('INVALID_ASSIGNEE');

      await withDb((conn) => conn.execute('UPDATE users SET is_locked = 1 WHERE id = ?', [reviewer.id]));
      const toLocked = await adminApi('PATCH', `/admin/applications/${applicant.id}`, { body: { assignedReviewerId: reviewer.id } });
      expect(toLocked.status).toBe(422);

      await withDb((conn) => conn.execute('UPDATE users SET is_locked = 0 WHERE id = ?', [reviewer.id]));
      const toReviewer = await adminApi('PATCH', `/admin/applications/${applicant.id}`, { body: { assignedReviewerId: reviewer.id } });
      expect(toReviewer.status).toBe(200);

      const assignees = await adminApi('GET', '/admin/applications/assignees');
      expect(assignees.body.map((u: any) => u.id)).toContain(reviewer.id);
      expect(assignees.body.map((u: any) => u.id)).not.toContain(editor.id);
    } finally {
      await deleteApplication(applicant.id);
      await deleteTempUser(editor.id);
      await deleteTempUser(reviewer.id);
    }
  });

  it('bulk status action partially succeeds: a valid id transitions, an invalid one reports ok:false without aborting the batch', async () => {
    const a = await submittedApplication();
    const b = await submittedApplication();
    try {
      // a: new -> under_review (valid). b: forced to 'accepted' directly via DB so the same bulk call's under_review transition is invalid for it.
      await withDb((conn) => conn.execute("UPDATE applications SET status = 'accepted' WHERE id = ?", [b.id]));

      const bulk = await adminApi('POST', '/admin/applications/bulk', {
        body: { ids: [a.id, b.id], action: 'status', status: 'under_review' },
      });
      expect([200, 201]).toContain(bulk.status);
      const results = bulk.body as { id: string; ok: boolean }[];
      expect(results.find((r) => r.id === a.id)?.ok).toBe(true);
      expect(results.find((r) => r.id === b.id)?.ok).toBe(false);

      const aStatus = await withDb((conn) => conn.execute('SELECT status FROM applications WHERE id = ?', [a.id]).then(([rows]: any) => rows[0].status));
      expect(aStatus).toBe('under_review');
    } finally {
      await deleteApplication(a.id);
      await deleteApplication(b.id);
    }
  });

  it('CSV export starts with a UTF-8 BOM, has the expected headers, and decodes Arabic names correctly', async () => {
    const applicant = await submittedApplication({ firstName: 'أحمد', lastName: 'الاختبار' });
    try {
      // A raw fetch, not adminApi() — export.csv isn't JSON, and adminApi() assumes a JSON (or empty) body.
      const res = await adminSessionFetch(`/admin/applications/export.csv?q=${encodeURIComponent(applicant.reference)}`);
      expect(res.status).toBe(200);
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes[0]).toBe(0xef);
      expect(bytes[1]).toBe(0xbb);
      expect(bytes[2]).toBe(0xbf);
      const text = bytes.toString('utf8');
      expect(text).toContain('Reference');
      expect(text).toContain('Name');
      expect(text).toContain('Status');
      expect(text).toContain('أحمد');
      expect(text).toContain('الاختبار');
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it("notes are never exposed on portal/me", async () => {
    const applicant = await submittedApplication();
    try {
      await adminApi('POST', `/admin/applications/${applicant.id}/notes`, { body: { body: 'Internal note — not for the applicant.' } });
      const me = await api('GET', '/portal/me', { session: applicant });
      expect(me.status).toBe(200);
      expect(JSON.stringify(me.body)).not.toContain('Internal note');
      expect(me.body.notes).toBeUndefined();
    } finally {
      await deleteApplication(applicant.id);
    }
  });
});

async function adminSessionFetch(path: string): Promise<Response> {
  const login = await fetch(`${process.env.TEST_BASE_URL}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_ADMIN_EMAIL, password: process.env.TEST_ADMIN_PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  return fetch(`${process.env.TEST_BASE_URL}${path}`, { headers: { Cookie: cookie } });
}
