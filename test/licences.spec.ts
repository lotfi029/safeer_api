// test/licences.spec.ts — feat/governance-contact (A7, 022): licences.
//   GET licences: published only, the primary first, then by sort order;
//   the primary *published* licence's number and issuer reach GET /site
//   (and leave it when it is unpublished or deleted); a published licence's
//   file is public on /files, an unpublished one's is not; an asset a
//   licence uses can't be deleted (409 ASSET_IN_USE naming the licence).

import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE, adminApi, api, loginAs, tinyPdf } from './helpers';

const ORIGIN = BASE.replace(/\/api\/v1$/, '');

async function uploadPdf(tag: string): Promise<{ id: string; publicId: string }> {
  const admin = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(tinyPdf(tag))], { type: 'application/pdf' }), `${tag}.pdf`);
  const res = await fetch(`${BASE}/admin/media`, { method: 'POST', headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrfToken }, body: form });
  const body = await res.json();
  expect(res.status).toBe(201);
  return { id: body.id, publicId: body.publicId };
}

describe('licences (022)', () => {
  const licenceIds: string[] = [];
  const assetIds: string[] = [];

  afterAll(async () => {
    for (const id of licenceIds) await adminApi('DELETE', `/admin/licences/${id}`);
    for (const id of assetIds) await adminApi('DELETE', `/admin/media/${id}`);
  });

  async function createLicence(body: Record<string, unknown>) {
    const res = await adminApi('POST', '/admin/licences', { body });
    expect(res.status).toBe(201);
    licenceIds.push(res.body.id);
    return res.body;
  }

  it('lists published licences, primary first, and writes the primary through to GET /site', async () => {
    const fileA = await uploadPdf(`licence-a-${Date.now()}`);
    const fileC = await uploadPdf(`licence-c-${Date.now()}`);
    assetIds.push(fileA.id, fileC.id);

    const a = await createLicence({
      titleAr: 'ترخيص المركز الوطني',
      titleEn: 'National centre licence',
      number: 'NC-1234',
      issuerAr: 'المركز الوطني لتنمية القطاع غير الربحي',
      issuerEn: 'National Center for Non-Profit Sector',
      issuedOn: '2024-01-15',
      expiresOn: '2027-01-14',
      assetId: fileA.id,
      isPublished: true,
      sortOrder: 50,
    });
    const b = await createLicence({ titleAr: 'شهادة تسجيل', number: 'REG-9', isPublished: true, sortOrder: 40 });
    const c = await createLicence({ titleAr: 'مسودة ترخيص', assetId: fileC.id, isPublished: false, sortOrder: 1 });

    let list = await api('GET', '/licences?lang=en');
    expect(list.status).toBe(200);
    let ids = list.body.map((l: any) => l.id);
    expect(ids).not.toContain(c.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id)); // sort order 40 before 50
    const shown = list.body.find((l: any) => l.id === a.id);
    expect(Object.keys(shown).sort()).toEqual(['asset', 'expiresOn', 'id', 'isPrimary', 'issuedOn', 'issuer', 'number', 'title']);
    expect(shown).toMatchObject({
      title: 'National centre licence',
      issuer: 'National Center for Non-Profit Sector',
      number: 'NC-1234',
      issuedOn: '2024-01-15',
      expiresOn: '2027-01-14',
      isPrimary: false,
    });
    expect(shown.asset.publicId).toBe(fileA.publicId);

    // Make A primary: it moves to the front, and GET /site carries it.
    const primary = await adminApi('PATCH', `/admin/licences/${a.id}/primary`);
    expect(primary.status).toBe(200);
    expect(primary.body.isPrimary).toBe(true);
    list = await api('GET', '/licences');
    expect(list.body[0].id).toBe(a.id);
    expect(list.body.filter((l: any) => l.isPrimary)).toHaveLength(1);
    let site = await api('GET', '/site?lang=en');
    expect(site.body.settings).toMatchObject({ licenceNo: 'NC-1234', licenceIssuer: 'National Center for Non-Profit Sector' });
    expect((await api('GET', '/site')).body.settings.licenceIssuer).toBe('المركز الوطني لتنمية القطاع غير الربحي');

    // B becomes primary on update: A loses the flag, the site follows B.
    const bPrimary = await adminApi('PATCH', `/admin/licences/${b.id}`, { body: { isPrimary: true } });
    expect(bPrimary.status).toBe(200);
    expect((await adminApi('GET', `/admin/licences/${a.id}`)).body.isPrimary).toBe(false);
    site = await api('GET', '/site');
    expect(site.body.settings.licenceNo).toBe('REG-9');
    expect(site.body.settings.licenceIssuer).toBeNull();

    // An edit of the primary's number flows through; unpublishing it clears the site; republishing restores it.
    await adminApi('PATCH', `/admin/licences/${b.id}`, { body: { number: 'REG-10' } });
    expect((await api('GET', '/site')).body.settings.licenceNo).toBe('REG-10');
    await adminApi('PATCH', `/admin/licences/${b.id}/publish`, { body: { isPublished: false } });
    expect((await api('GET', '/site')).body.settings.licenceNo).toBeNull();
    expect((await api('GET', '/licences')).body.map((l: any) => l.id)).not.toContain(b.id);
    await adminApi('PATCH', `/admin/licences/${b.id}/publish`, { body: { isPublished: true } });
    expect((await api('GET', '/site')).body.settings.licenceNo).toBe('REG-10');
    expect((await api('GET', '/home')).body.settings.licenceNo).toBe('REG-10');

    // Deleting the primary clears the site.
    expect((await adminApi('DELETE', `/admin/licences/${b.id}`)).status).toBe(200);
    licenceIds.splice(licenceIds.indexOf(b.id), 1);
    expect((await api('GET', '/site')).body.settings.licenceNo).toBeNull();
  });

  it("a published licence's file is public; an unpublished one's is not; a used asset can't be deleted", async () => {
    const file = await uploadPdf(`licence-file-${Date.now()}`);
    assetIds.push(file.id);
    const licence = await createLicence({ titleAr: 'ترخيص للملف', assetId: file.id, isPublished: false });

    expect((await fetch(`${ORIGIN}/files/${file.publicId}`)).status).toBe(404);
    await adminApi('PATCH', `/admin/licences/${licence.id}/publish`, { body: { isPublished: true } });
    expect((await fetch(`${ORIGIN}/files/${file.publicId}`)).status).toBe(200);

    const del = await adminApi('DELETE', `/admin/media/${file.id}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('ASSET_IN_USE');
    expect(del.body.usages).toEqual([{ entity: 'licences', id: licence.id, label: 'ترخيص للملف' }]);
  });

  it('validates the asset, the dates and the fields; settings refuse the written-through columns', async () => {
    expect((await adminApi('POST', '/admin/licences', { body: { titleAr: 'س', assetId: '999999999' } })).status).toBe(400);
    expect((await adminApi('POST', '/admin/licences', { body: { titleAr: 'س', issuedOn: '2025-05-01', expiresOn: '2025-04-30' } })).status).toBe(400);
    expect((await adminApi('POST', '/admin/licences', { body: { titleAr: '' } })).status).toBe(400);
    expect((await adminApi('POST', '/admin/licences', { body: { titleAr: 'س', number: 'x'.repeat(101) } })).status).toBe(400);
    expect((await adminApi('POST', '/admin/licences', { body: { titleAr: 'س', issuedOn: '15/01/2024' } })).status).toBe(400);
    expect((await adminApi('PATCH', '/admin/licences/999999999/primary')).status).toBe(404);
    expect((await adminApi('PUT', '/admin/settings', { body: { licenceNo: 'X' } })).status).toBe(400);
  });

  it('anonymous callers cannot reach admin/licences', async () => {
    expect((await api('GET', '/admin/licences')).status).toBe(401);
  });
});
