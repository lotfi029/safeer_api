// test/integrity.spec.ts — Phase 2 of the fix plan:
//   B3  upload status rules under a row lock; an accepted document is never replaced
//   C5  CSV export neutralises formula injection
//   C6  two conflicting status changes: exactly one wins
//   C15 PATCH only while draft; audited corrections while docs_missing
//   C18 replaced files are deleted; per-application quota; upload throttle
//   C19 Arabic filenames survive upload and both download routes
//   B19 document responses never expose storageKey / checksum
//   C34 superseded documents / drafts aren't reviewable

import { existsSync } from 'node:fs';
import path from 'node:path';
import { adminApi, api, BASE, createApplication, deleteApplication, tinyPdf, withDb, type Session, type TestApplicant } from './helpers';

const STORAGE_ROOT = path.resolve(__dirname, '..', process.env.TEST_STORAGE_ROOT ?? './var/assets-test');

async function upload(session: Session, docType: string, filename: string, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append('docType', docType);
  form.append('file', new Blob([new Uint8Array(tinyPdf(filename))], { type: 'application/pdf' }), filename);
  const res = await fetch(`${BASE}/portal/documents`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, ...headers },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

async function setStatus(applicationId: string, status: string) {
  await withDb((conn) => conn.execute('UPDATE applications SET status = ? WHERE id = ?', [status, applicationId]));
}

async function docRow(docId: string): Promise<any> {
  return withDb((conn) => conn.execute('SELECT * FROM application_documents WHERE id = ?', [docId]).then(([rows]: any) => rows[0]));
}

describe('applicant data integrity and files', () => {
  let applicant: TestApplicant;

  beforeEach(async () => {
    applicant = await createApplication();
  });

  afterEach(async () => {
    await deleteApplication(applicant.id);
  });

  describe('B3 upload rules', () => {
    it('refuses uploads once submitted, and in docs_missing allows only requested/rejected types', async () => {
      await setStatus(applicant.id, 'new');
      const locked = await upload(applicant, 'id_copy', 'a.pdf');
      expect(locked.status).toBe(409);
      expect(locked.body.code).toBe('APPLICATION_LOCKED');

      await setStatus(applicant.id, 'docs_missing');
      await withDb((conn) =>
        conn.execute(
          "INSERT INTO application_events (application_id, type, visible_to_applicant, data) VALUES (?, 'DOCS_REQUESTED', 1, ?)",
          [applicant.id, JSON.stringify({ docTypes: ['certificate'], message: null })],
        ),
      );
      const notRequested = await upload(applicant, 'id_copy', 'b.pdf');
      expect(notRequested.status).toBe(409);
      const requested = await upload(applicant, 'certificate', 'c.pdf');
      expect(requested.status).toBe(201);
    });

    it('never replaces an accepted document', async () => {
      const first = await upload(applicant, 'id_copy', 'first.pdf');
      await withDb((conn) => conn.execute("UPDATE application_documents SET status = 'accepted' WHERE id = ?", [first.body.id]));
      const again = await upload(applicant, 'id_copy', 'second.pdf');
      expect(again.status).toBe(409);
      expect((await docRow(first.body.id)).superseded_at).toBeNull();
    });
  });

  describe('C18', () => {
    it('deletes the replaced file after commit but keeps its row', async () => {
      const first = await upload(applicant, 'id_copy', 'v1.pdf');
      const firstRow = await docRow(first.body.id);
      expect(existsSync(path.join(STORAGE_ROOT, firstRow.storage_key))).toBe(true);

      const second = await upload(applicant, 'id_copy', 'v2.pdf');
      expect(second.status).toBe(201);
      const replaced = await docRow(first.body.id);
      expect(replaced.superseded_at).not.toBeNull();
      expect(existsSync(path.join(STORAGE_ROOT, replaced.storage_key))).toBe(false);
      expect(existsSync(path.join(STORAGE_ROOT, (await docRow(second.body.id)).storage_key))).toBe(true);
    });

    it('enforces the per-application quota (30 files, 50 MB)', async () => {
      await withDb(async (conn) => {
        for (let i = 0; i < 30; i++) {
          await conn.execute(
            `INSERT INTO application_documents (application_id, doc_type, original_name, storage_key, mime, size_bytes, checksum, status, superseded_at)
             VALUES (?, 'other', 'x.pdf', ?, 'application/pdf', 10, REPEAT('0', 64), 'under_review', UTC_TIMESTAMP(3))`,
            [applicant.id, `private/applications/${applicant.id}/quota-${i}.pdf`],
          );
        }
      });
      const overCount = await upload(applicant, 'id_copy', 'over.pdf');
      expect(overCount.status).toBe(409);
      expect(overCount.body.code).toBe('QUOTA_EXCEEDED');

      await withDb((conn) => conn.execute('DELETE FROM application_documents WHERE application_id = ?', [applicant.id]));
      await withDb((conn) =>
        conn.execute(
          `INSERT INTO application_documents (application_id, doc_type, original_name, storage_key, mime, size_bytes, checksum, status)
           VALUES (?, 'other', 'big.pdf', 'private/x/big.pdf', 'application/pdf', ?, REPEAT('0', 64), 'under_review')`,
          [applicant.id, 50 * 1024 * 1024],
        ),
      );
      const overBytes = await upload(applicant, 'id_copy', 'over.pdf');
      expect(overBytes.status).toBe(409);
      expect(overBytes.body.code).toBe('QUOTA_EXCEEDED');
    });

    it('throttles uploads at 20 per hour', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) {
        statuses.push((await upload(applicant, 'other', `t${i}.pdf`, { 'x-test-enforce-throttle': '1' })).status);
      }
      expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
      expect(statuses[20]).toBe(429);
    });
  });

  it('C19/B19: an Arabic filename survives upload and both download routes; responses carry no storage details', async () => {
    const name = 'شهادة التخرج.pdf';
    const uploaded = await upload(applicant, 'certificate', name);
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.originalName).toBe(name);
    expect(Object.keys(uploaded.body).sort()).toEqual(['createdAt', 'docType', 'id', 'mime', 'originalName', 'rejectionReason', 'sizeBytes', 'status']);

    const list = await api('GET', '/portal/documents', { session: applicant });
    expect(list.body.documents[0].storageKey).toBeUndefined();
    expect(list.body.documents[0].checksum).toBeUndefined();

    const expected = `filename*=UTF-8''${encodeURIComponent('شهادة التخرج')}.pdf`;
    const portal = await fetch(`${BASE}/portal/documents/${uploaded.body.id}/file`, { headers: { Cookie: applicant.cookie } });
    expect(portal.status).toBe(200);
    expect(portal.headers.get('content-disposition')).toContain(expected);

    const detail = await adminApi('GET', `/admin/applications/${applicant.id}`);
    expect(detail.body.documents[0].storageKey).toBeUndefined();
    expect(detail.body.documents[0].checksum).toBeUndefined();
    const adminLogin = await fetch(`${BASE}/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.TEST_ADMIN_EMAIL, password: process.env.TEST_ADMIN_PASSWORD }),
    });
    const cookie = adminLogin.headers.get('set-cookie')!.split(';')[0];
    const adminFile = await fetch(`${BASE}/admin/applications/${applicant.id}/documents/${uploaded.body.id}/file`, { headers: { Cookie: cookie } });
    expect(adminFile.status).toBe(200);
    expect(adminFile.headers.get('content-disposition')).toContain(expected);
  });

  describe('C15', () => {
    it('PATCH portal/application is refused once the application is no longer a draft', async () => {
      await setStatus(applicant.id, 'docs_missing');
      const res = await api('PATCH', '/portal/application', { session: applicant, body: { firstName: 'Changed' } });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('APPLICATION_LOCKED');
    });

    it('corrections: docs_missing only, whitelisted fields, with a visible event', async () => {
      const inDraft = await api('PATCH', '/portal/application/corrections', { session: applicant, body: { firstName: 'Corrected' } });
      expect(inDraft.status).toBe(409);

      await setStatus(applicant.id, 'docs_missing');
      const email = await api('PATCH', '/portal/application/corrections', { session: applicant, body: { email: 'new@example.com' } });
      expect(email.status).toBe(400);

      const ok = await api('PATCH', '/portal/application/corrections', { session: applicant, body: { firstName: 'Corrected', major: 'Law' } });
      expect(ok.status).toBe(200);
      expect(ok.body.corrected.sort()).toEqual(['firstName', 'major']);

      const [event]: any = await withDb((conn) =>
        conn
          .execute("SELECT visible_to_applicant, data FROM application_events WHERE application_id = ? AND type = 'APPLICANT_CORRECTED'", [applicant.id])
          .then(([rows]: any) => rows),
      );
      expect(Number(event.visible_to_applicant)).toBe(1);
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      expect(data.fields.sort()).toEqual(['firstName', 'major']);
    });
  });

  it('C6: two conflicting status changes race — exactly one wins, one STATUS_CHANGED event', async () => {
    await setStatus(applicant.id, 'under_review');
    const [a, b] = await Promise.all([
      adminApi('PATCH', `/admin/applications/${applicant.id}`, { body: { status: 'accepted' } }),
      adminApi('PATCH', `/admin/applications/${applicant.id}`, { body: { status: 'rejected' } }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe('INVALID_STATUS_TRANSITION');
    const [count]: any = await withDb((conn) =>
      conn
        .execute("SELECT COUNT(*) AS c FROM application_events WHERE application_id = ? AND type = 'STATUS_CHANGED'", [applicant.id])
        .then(([rows]: any) => rows),
    );
    expect(Number(count.c)).toBe(1);
  });

  it('C34: a superseded document, or one on a draft, is not reviewable', async () => {
    const first = await upload(applicant, 'id_copy', 'one.pdf');
    await upload(applicant, 'id_copy', 'two.pdf');
    await setStatus(applicant.id, 'under_review');
    const superseded = await adminApi('PATCH', `/admin/applications/${applicant.id}/documents/${first.body.id}`, { body: { status: 'accepted' } });
    expect(superseded.status).toBe(409);
    expect(superseded.body.code).toBe('DOCUMENT_NOT_REVIEWABLE');

    const current = (await api('GET', '/portal/documents', { session: applicant })).body.documents[0];
    await setStatus(applicant.id, 'draft');
    const onDraft = await adminApi('PATCH', `/admin/applications/${applicant.id}/documents/${current.id}`, { body: { status: 'accepted' } });
    expect(onDraft.status).toBe(409);
  });

  it('C5: an applicant-typed formula is neutralised in export.csv', async () => {
    await api('PATCH', '/portal/application', { session: applicant, body: { university: '=HYPERLINK("http://evil.example","x")' } });
    await setStatus(applicant.id, 'new');
    const res = await fetch(`${BASE}/admin/applications/export.csv?q=${applicant.reference}`, {
      headers: { Cookie: (await loginCookie()) },
    });
    const csv = await res.text();
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
  });
});

async function loginCookie(): Promise<string> {
  const res = await fetch(`${BASE}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_ADMIN_EMAIL, password: process.env.TEST_ADMIN_PASSWORD }),
  });
  return res.headers.get('set-cookie')!.split(';')[0];
}

