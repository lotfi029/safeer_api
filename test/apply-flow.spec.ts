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

  // A6 (safeer-delivery-review.md): the duplicate check is a locking read.
  // With LOWER(a.email) no index applied, so it scanned and locked every open
  // application. The test captures the exact statement the app ran (general
  // log) and EXPLAINs it. On MariaDB 10.11 (dev fixtures), the same query:
  //
  //   plain =    type index_merge, key ix_applications_email,ix_applications_phone_e164,
  //              Extra "Using union(ix_applications_email,ix_applications_phone_e164)", rows 2
  //   LOWER()    type ALL, key NULL, possible_keys without ix_applications_email, rows 6 (every row)
  //
  // Which plan the optimizer picks on a tiny test table can vary, so the
  // assertion is on possible_keys: with LOWER() the email index isn't a
  // candidate at all.
  it('A6: the duplicate check matches case-insensitively and can use the email index', async () => {
    const applicant = await createApplication();
    const [[{ wasOn }]]: any = await withDb((conn) => conn.query("SELECT @@GLOBAL.general_log AS wasOn"));
    try {
      await withDb(async (conn) => {
        await conn.query("SET GLOBAL log_output = 'TABLE'");
        await conn.query('TRUNCATE mysql.general_log');
        await conn.query('SET GLOBAL general_log = 1');
      });
      const res = await fetch(`${process.env.TEST_BASE_URL}/applications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: 'Someone',
          lastName: 'Else',
          birthDate: '2000-01-01',
          phone: `+9665${String(Date.now()).slice(-8)}`,
          nationality: 'SA',
          email: applicant.email.toUpperCase(),
          gender: 'male',
        }),
      });
      // The collation is case-insensitive: an upper-cased email is still the same applicant.
      expect(res.status).toBe(409);

      const plan: any[] = await withDb(async (conn) => {
        await conn.query('SET GLOBAL general_log = 0');
        const [rows]: any = await conn.query(
          "SELECT CONVERT(argument USING utf8mb4) AS sql_text FROM mysql.general_log WHERE CONVERT(argument USING utf8mb4) LIKE '%FOR UPDATE%' AND CONVERT(argument USING utf8mb4) LIKE ?",
          [`%${applicant.email.toUpperCase()}%`],
        );
        expect(rows.length).toBeGreaterThan(0);
        const statement = String(rows[0].sql_text).replace(/\s+FOR UPDATE\s*$/i, '');
        expect(statement).not.toMatch(/LOWER\(/i);
        const [explain]: any = await conn.query(`EXPLAIN ${statement}`);
        return explain;
      });
      const applications = plan.find((row) => row.table === 'a');
      expect(String(applications.possible_keys)).toMatch(/ix_applications_email/);
    } finally {
      await withDb((conn) => conn.query(`SET GLOBAL general_log = ${Number(wasOn) ? 1 : 0}`));
      await deleteApplication(applicant.id);
    }
  });

  // S1/BF-2: concurrent creates take gap locks on the email and phone
  // indexes and the yearly counter row, so InnoDB can pick one of them as a
  // deadlock victim (errno 1213). Without the retry that applicant got a 500.
  // Five rounds of eight, so a lucky schedule can't make it pass by chance.
  it('concurrent creates by distinct applicants all succeed with distinct references (S1)', async () => {
    const ROUNDS = 5;
    const PER_ROUND = 8;
    const statuses: number[] = [];
    const references: string[] = [];
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const results = await Promise.all(
          Array.from({ length: PER_ROUND }, async (_, i) => {
            const tag = `${Date.now()}-${round}-${i}-${Math.random().toString(36).slice(2, 8)}`;
            const res = await fetch(`${process.env.TEST_BASE_URL}/applications`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                firstName: 'Concurrent',
                lastName: 'Applicant',
                birthDate: '2000-01-01',
                phone: `+9665${String(round)}${String(i)}${String(Date.now()).slice(-6)}`,
                nationality: 'SA',
                email: `jest-concurrent-${tag}@example.com`,
                gender: 'male',
              }),
            });
            const body = await res.json().catch(() => ({}));
            return { status: res.status, reference: body.reference as string | undefined };
          }),
        );
        for (const r of results) {
          statuses.push(r.status);
          if (r.reference) references.push(r.reference);
        }
      }
      expect(statuses.filter((s) => s !== 201)).toEqual([]);
      expect(references).toHaveLength(ROUNDS * PER_ROUND);
      expect(new Set(references).size).toBe(ROUNDS * PER_ROUND);
      for (const ref of references) expect(ref).toMatch(REFERENCE_RE);
    } finally {
      await withDb(async (conn) => {
        if (references.length) {
          await conn.query('DELETE FROM applications WHERE reference IN (?)', [references]);
        }
      });
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
