// test/interviews.spec.ts — Phase 4 of the fix plan, C17 (interview booking):
//   the slot list is future-only and empty once booked; a second booking is
//   SLOT_ALREADY_BOOKED; DELETE portal/interview frees the slot; /portal/me
//   carries the booking; a slot must end after it starts (create and PATCH);
//   booking, cancelling and a staff edit of a booked slot each mail the
//   applicant (interview_booked / interview_cancelled / interview_updated).

import { adminApi, api, createApplication, deleteApplication, withDb, type TestApplicant } from './helpers';
import { withMailSink } from './smtp-sink';

const HOUR = 60 * 60 * 1000;
const slotIds: string[] = [];

async function createSlot(startOffsetMs: number, location = 'Jest room'): Promise<string> {
  const startsAt = new Date(Date.now() + startOffsetMs);
  const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
  const res = await adminApi('POST', '/admin/interview-slots', {
    body: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), locationAr: location, locationEn: location },
  });
  if (res.status !== 201) throw new Error(`slot create failed: ${res.status} ${JSON.stringify(res.body)}`);
  slotIds.push(String(res.body.id));
  return String(res.body.id);
}

async function interviewApplicant(): Promise<TestApplicant> {
  const applicant = await createApplication();
  await withDb((conn) => conn.execute("UPDATE applications SET status = 'interview' WHERE id = ?", [applicant.id]));
  return applicant;
}

async function mailKeys(applicationId: string): Promise<string[]> {
  return withDb((conn) =>
    conn
      .execute("SELECT template_key FROM mail_log WHERE entity_type = 'applications' AND entity_id = ? ORDER BY id", [applicationId])
      .then(([rows]: any) => rows.map((r: any) => r.template_key)),
  );
}

afterAll(async () => {
  await withDb(async (conn) => {
    for (const id of slotIds) await conn.execute('DELETE FROM interview_slots WHERE id = ?', [id]);
  });
});

describe('C17: interview booking', () => {
  it('lists only future open slots, and none once the applicant has booked', async () => {
    const past = await createSlot(-2 * HOUR);
    const future = await createSlot(48 * HOUR);
    const applicant = await interviewApplicant();
    try {
      const listed = await api('GET', '/portal/interview-slots', { session: applicant });
      expect(listed.status).toBe(200);
      const ids = listed.body.map((s: any) => String(s.id));
      expect(ids).toContain(future);
      expect(ids).not.toContain(past);
      // Never another applicant's booking.
      expect(Object.keys(listed.body[0]).sort()).toEqual(['endsAt', 'id', 'location', 'startsAt']);

      expect((await api('POST', '/portal/interview', { session: applicant, body: { slotId: future } })).status).toBe(201);
      const after = await api('GET', '/portal/interview-slots', { session: applicant });
      expect(after.body).toEqual([]);
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('a past slot cannot be booked', async () => {
    const past = await createSlot(-3 * HOUR);
    const applicant = await interviewApplicant();
    try {
      const res = await api('POST', '/portal/interview', { session: applicant, body: { slotId: past } });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INTERVIEW_NOT_AVAILABLE');
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('a second booking by the same applicant, or of a taken slot, is SLOT_ALREADY_BOOKED', async () => {
    const first = await createSlot(50 * HOUR);
    const second = await createSlot(51 * HOUR);
    const one = await interviewApplicant();
    const two = await interviewApplicant();
    try {
      expect((await api('POST', '/portal/interview', { session: one, body: { slotId: first } })).status).toBe(201);

      const again = await api('POST', '/portal/interview', { session: one, body: { slotId: second } });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('SLOT_ALREADY_BOOKED');

      const taken = await api('POST', '/portal/interview', { session: two, body: { slotId: first } });
      expect(taken.status).toBe(409);
      expect(taken.body.code).toBe('SLOT_ALREADY_BOOKED');
    } finally {
      await deleteApplication(one.id);
      await deleteApplication(two.id);
    }
  });

  it('/portal/me carries the booking; DELETE portal/interview frees the slot and records the event', async () => {
    const slot = await createSlot(52 * HOUR, 'قاعة الاختبار');
    const applicant = await interviewApplicant();
    try {
      const before = await api('GET', '/portal/me', { session: applicant });
      expect(before.body.interview).toBeNull();

      await api('POST', '/portal/interview', { session: applicant, body: { slotId: slot } });
      const booked = await api('GET', '/portal/me', { session: applicant });
      expect(String(booked.body.interview.id)).toBe(slot);
      expect(booked.body.interview.location).toBe('قاعة الاختبار');

      const cancelled = await api('DELETE', '/portal/interview', { session: applicant });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toEqual({ cancelled: true });

      const [row]: any = await withDb((conn) => conn.execute('SELECT application_id FROM interview_slots WHERE id = ?', [slot]).then(([r]: any) => r));
      expect(row.application_id).toBeNull();
      const events: any[] = await withDb((conn) =>
        conn.execute('SELECT type FROM application_events WHERE application_id = ? ORDER BY id', [applicant.id]).then(([r]: any) => r),
      );
      expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['INTERVIEW_BOOKED', 'INTERVIEW_CANCELLED']));
      expect((await api('GET', '/portal/me', { session: applicant })).body.interview).toBeNull();

      // Nothing left to cancel.
      expect((await api('DELETE', '/portal/interview', { session: applicant })).status).toBe(404);
      // The slot is open again.
      const listed = await api('GET', '/portal/interview-slots', { session: applicant });
      expect(listed.body.map((s: any) => String(s.id))).toContain(slot);
    } finally {
      await deleteApplication(applicant.id);
    }
  });

  it('a slot must end after it starts, on create and on a partial PATCH', async () => {
    const start = new Date(Date.now() + 60 * HOUR);
    const bad = await adminApi('POST', '/admin/interview-slots', {
      body: { startsAt: start.toISOString(), endsAt: start.toISOString() },
    });
    expect(bad.status).toBe(400);

    const slot = await createSlot(61 * HOUR);
    const patch = await adminApi('PATCH', `/admin/interview-slots/${slot}`, {
      body: { endsAt: new Date(Date.now() + 10 * HOUR).toISOString() },
    });
    expect(patch.status).toBe(400);
  });

  it('booking, a staff edit and cancelling each notify the applicant, in their language and time zone', async () => {
    await withMailSink(async (sink) => {
      const slot = await createSlot(70 * HOUR, 'مقر الجمعية');
      const applicant = await interviewApplicant();
      try {
        await api('POST', '/portal/interview', { session: applicant, body: { slotId: slot } });
        const bookedMail = await sink.waitFor((m) => m.to.includes(applicant.email) && m.html.includes('مقر الجمعية'));
        expect(bookedMail.html).toContain('dir="rtl"');

        const newStart = new Date(Date.now() + 72 * HOUR);
        const edited = await adminApi('PATCH', `/admin/interview-slots/${slot}`, {
          body: { startsAt: newStart.toISOString(), endsAt: new Date(newStart.getTime() + 30 * 60 * 1000).toISOString(), locationAr: 'القاعة الكبرى' },
        });
        expect(edited.status).toBe(200);
        await sink.waitFor((m) => m.to.includes(applicant.email) && m.html.includes('القاعة الكبرى'));

        await api('DELETE', '/portal/interview', { session: applicant });
        const keys = await mailKeys(applicant.id);
        expect(keys).toEqual(expect.arrayContaining(['interview_booked', 'interview_updated', 'interview_cancelled']));
      } finally {
        await deleteApplication(applicant.id);
      }
    });
  });

  it('an edit of an unbooked slot sends nothing', async () => {
    const slot = await createSlot(80 * HOUR);
    const before: number = await withDb((conn) =>
      conn.execute("SELECT COUNT(*) AS n FROM mail_log WHERE template_key = 'interview_updated'").then(([r]: any) => Number(r[0].n)),
    );
    expect((await adminApi('PATCH', `/admin/interview-slots/${slot}`, { body: { locationAr: 'مكان آخر' } })).status).toBe(200);
    const after: number = await withDb((conn) =>
      conn.execute("SELECT COUNT(*) AS n FROM mail_log WHERE template_key = 'interview_updated'").then(([r]: any) => Number(r[0].n)),
    );
    expect(after).toBe(before);
  });
});
