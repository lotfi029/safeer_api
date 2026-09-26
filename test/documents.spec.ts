// test/documents.spec.ts — Phase 6, area 4: upload status rules (B3), no
// superseding an accepted document (B3), ownership 404, MIME/size rejection.

import { adminApi, api, createApplication, deleteApplication, tinyPdf, uploadApplicationDocument, type TestApplicant } from './helpers';

async function submitWithDocs(applicant: TestApplicant) {
  for (const docType of ['id_copy', 'certificate', 'admission_letter']) {
    const up = await uploadApplicationDocument(applicant, docType, `docs-spec-${docType}`);
    expect(up.status).toBe(201);
  }
  const submit = await api('POST', '/portal/application/submit', {
    session: applicant,
    body: {
      firstName: 'Test',
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
    },
  });
  expect([200, 201]).toContain(submit.status);
}

describe('documents (B3)', () => {
  it('upload succeeds while the application is a draft', async () => {
    const applicant = await createApplication();
    try {
      const up = await uploadApplicationDocument(applicant, 'id_copy', 'draft-upload');
      expect(up.status).toBe(201);
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('rejects an upload with an unsupported MIME type', async () => {
    const applicant = await createApplication();
    try {
      const form = new FormData();
      form.append('docType', 'id_copy');
      form.append('file', new Blob([new Uint8Array(Buffer.from('not a real file'))], { type: 'text/plain' }), 'note.txt');
      const res = await fetch(`${process.env.TEST_BASE_URL}/portal/documents`, {
        method: 'POST',
        headers: { Cookie: applicant.cookie, 'X-CSRF-Token': applicant.csrfToken },
        body: form,
      });
      expect(res.status).toBe(400);
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('rejects a file over the 5 MB private-document limit', async () => {
    const applicant = await createApplication();
    try {
      const oversized = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x41)]);
      const form = new FormData();
      form.append('docType', 'id_copy');
      form.append('file', new Blob([new Uint8Array(oversized)], { type: 'application/pdf' }), 'big.pdf');
      const res = await fetch(`${process.env.TEST_BASE_URL}/portal/documents`, {
        method: 'POST',
        headers: { Cookie: applicant.cookie, 'X-CSRF-Token': applicant.csrfToken },
        body: form,
      });
      expect([400, 413]).toContain(res.status);
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('B3: upload is refused (409 APPLICATION_LOCKED) once the application has been submitted (status=new)', async () => {
    const applicant = await createApplication();
    try {
      await submitWithDocs(applicant);
      const reupload = await uploadApplicationDocument(applicant, 'id_copy', 'locked-upload');
      expect(reupload.status).toBe(409);
      expect(reupload.body?.code).toBe('APPLICATION_LOCKED');
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('B3: an accepted document can never be superseded, even once docs_missing/that type is requested again', async () => {
    const applicant = await createApplication();
    try {
      await submitWithDocs(applicant);

      const toUnderReview = await adminApi('PATCH', `/admin/applications/${applicant.id}`, { body: { status: 'under_review' } });
      expect(toUnderReview.status).toBe(200);

      const detail = await adminApi('GET', `/admin/applications/${applicant.id}`);
      const idCopy = detail.body.documents.find((d: any) => d.docType === 'id_copy');
      const accept = await adminApi('PATCH', `/admin/applications/${applicant.id}/documents/${idCopy.id}`, { body: { status: 'accepted' } });
      expect(accept.status).toBe(200);

      const request = await adminApi('POST', `/admin/applications/${applicant.id}/request-documents`, { body: { docTypes: ['id_copy'] } });
      expect([200, 201]).toContain(request.status);

      const reupload = await uploadApplicationDocument(applicant, 'id_copy', 'accepted-blocked');
      expect(reupload.status).toBe(409);
      expect(reupload.body?.code).toBe('APPLICATION_LOCKED');
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('ownership: one applicant cannot delete another applicant\'s document (404, not 403)', async () => {
    const a = await createApplication();
    const b = await createApplication();
    try {
      const upA = await uploadApplicationDocument(a, 'other', 'ownership-a');
      const docId = upA.body.id;

      const crossDelete = await api('DELETE', `/portal/documents/${docId}`, { session: b });
      expect(crossDelete.status).toBe(404);

      const crossFile = await fetch(`${process.env.TEST_BASE_URL}/portal/documents/${docId}/file`, {
        headers: { Cookie: b.cookie },
      });
      expect(crossFile.status).toBe(404);
    } finally {
      await deleteApplication(a.id);
      await deleteApplication(b.id);
    }
  });
});
