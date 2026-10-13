// test/contact-subjects.spec.ts — feat/governance-contact (A5): the contact
// form's subjects are inquiry, partnership, support, feedback and other
// (021 turned `scholarship` into `inquiry`), and GET meta/enums serves the
// same list with its labels.

import { api, withDb } from './helpers';

const SUBJECTS = ['inquiry', 'partnership', 'support', 'feedback', 'other'];

function contactBody(subject: string, email: string) {
  return { name: 'Sara Ali', email, phone: null, subject, body: 'Hello there', formRenderedAt: Date.now() - 10_000 };
}

describe('contact subjects', () => {
  const tag = `jest-subject-${Date.now()}`;

  afterAll(async () => {
    await withDb((conn) => conn.execute('DELETE FROM contact_messages WHERE email LIKE ?', [`${tag}-%`]));
  });

  it.each(SUBJECTS)('POST /contact accepts %s and stores it', async (subject) => {
    const email = `${tag}-${subject}@example.com`;
    const res = await api('POST', '/contact', { body: contactBody(subject, email) });
    expect(res.status).toBe(201);
    const [rows]: any = await withDb((conn) => conn.execute('SELECT subject FROM contact_messages WHERE email = ?', [email]));
    expect(rows.map((r: any) => r.subject)).toEqual([subject]);
  });

  it.each(['scholarship', 'donation', ''])('POST /contact refuses the subject %j (400)', async (subject) => {
    const email = `${tag}-refused-${subject || 'empty'}@example.com`;
    const res = await api('POST', '/contact', { body: contactBody(subject, email) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    const [rows]: any = await withDb((conn) => conn.execute('SELECT id FROM contact_messages WHERE email = ?', [email]));
    expect(rows).toEqual([]);
  });

  it('GET meta/enums lists the subjects with their labels', async () => {
    const res = await api('GET', '/meta/enums');
    expect(res.status).toBe(200);
    // LocaleInterceptor collapses labelAr/labelEn into `label` (ar by default).
    expect(res.body.contactSubject).toEqual([
      { value: 'inquiry', label: 'استفسار' },
      { value: 'partnership', label: 'شراكة' },
      { value: 'support', label: 'دعم وتبرع' },
      { value: 'feedback', label: 'ملاحظات' },
      { value: 'other', label: 'أخرى' },
    ]);
    const en = await api('GET', '/meta/enums?lang=en');
    expect(en.body.contactSubject.map((o: any) => o.label)).toEqual(['Inquiry', 'Partnership', 'Support and donations', 'Feedback', 'Other']);
    expect(Object.keys(res.body).sort()).toEqual(['contactSubject', 'partnerCategory']);
  });
});
