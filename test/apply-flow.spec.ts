// test/apply-flow.spec.ts — Phase 6, area 2: create (reference format +
// sequencing), autosave, submit rules (missing docs, consent), duplicate
// active application (B2).

import { api, createApplication, deleteApplication, uploadApplicationDocument, withDb, type TestApplicant } from './helpers';

const REFERENCE_RE = /^SA-\d{4}-\d{5}$/;

describe('apply flow', () => {
  it('POST applications mints a reference matching SA-YYYY-NNNNN and starts a draft', async () => {
    const applicant = await createApplication();
    try {
      expect(applicant.reference).toMatch(REFERENCE_RE);
      const status = await withDb((conn) =>
        conn.execute('SELECT status FROM applications WHERE id = ?', [applicant.id]).then(([rows]: any) => rows[0]?.status),
      );
      expect(status).toBe('draft');
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('two consecutive creates mint strictly increasing sequence numbers within the same year', async () => {
    const a = await createApplication();
    const b = await createApplication();
    try {
      const seqOf = (ref: string) => Number(ref.split('-')[2]);
      expect(seqOf(b.reference)).toBe(seqOf(a.reference) + 1);
    } finally {
      await deleteApplication(a.id);
      await deleteApplication(b.id);
    }
  });

  it('PATCH portal/application autosaves a subset of fields and advances currentStep', async () => {
    const applicant = await createApplication();
    try {
      const patch = await api('PATCH', '/portal/application', {
        body: { university: 'Test University', major: 'Testing', degreeLevel: 'bachelor' },
        session: applicant,
      });
      expect(patch.status).toBe(200);
      expect(patch.body.currentStep).toBeGreaterThanOrEqual(2);
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('submit is refused (409 DOCUMENTS_INCOMPLETE) when required documents are missing', async () => {
    const applicant = await createApplication();
    try {
      const submit = await api('POST', '/portal/application/submit', {
        body: fullSubmitBody(applicant),
        session: applicant,
      });
      expect(submit.status).toBe(409);
      expect(submit.body?.code).toBe('DOCUMENTS_INCOMPLETE');
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('submit is refused (400) when consent is not exactly true', async () => {
    const applicant = await createApplication();
    try {
      for (const docType of ['id_copy', 'certificate', 'admission_letter']) {
        await uploadApplicationDocument(applicant, docType, `apply-flow-${docType}`);
      }
      const { consent: _drop, ...body } = fullSubmitBody(applicant);
      const submit = await api('POST', '/portal/application/submit', { body: { ...body, consent: false }, session: applicant });
      expect(submit.status).toBe(400);
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('submit succeeds once every required document is present and consent is true', async () => {
    const applicant = await createApplication();
    try {
      for (const docType of ['id_copy', 'certificate', 'admission_letter']) {
        const up = await uploadApplicationDocument(applicant, docType, `apply-flow-ok-${docType}`);
        expect(up.status).toBe(201);
      }
      const submit = await api('POST', '/portal/application/submit', { body: fullSubmitBody(applicant), session: applicant });
      expect([200, 201]).toContain(submit.status);
      expect(submit.body.status).toBe('new');
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('B2: a second POST applications for the same email is refused with 409 APPLICATION_EXISTS', async () => {
    const applicant = await createApplication();
    try {
      const res = await fetch(`${process.env.TEST_BASE_URL}/applications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: 'Someone',
          lastName: 'Else',
          birthDate: '2000-01-01',
          phone: `+9665${String(Date.now()).slice(-8)}`,
          nationality: 'SA',
          email: applicant.email,
          gender: 'male',
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('APPLICATION_EXISTS');
    } finally {
      await deleteApplication(applicant.id);
    }
  });
});

function fullSubmitBody(applicant: TestApplicant) {
  return {
    firstName: 'Test',
    middleName: null,
    lastName: 'Applicant',
    birthDate: '2000-01-01',
    phone: `+9665${String(Date.now()).slice(-8)}`,
    nationality: 'SA',
    email: applicant.email,
    gender: 'male',
    university: 'Test University',
    major: 'Testing',
    degreeLevel: 'bachelor',
    consent: true,
  };
}
