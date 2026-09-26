import type { Env } from '../config/env.js';
import type { Application } from '../database/entities/application.entity.js';
import type { InterviewSlot } from '../database/entities/interview-slot.entity.js';
import type { MailServiceInterface } from '../mail/mail.service.interface.js';
import type { SmsServiceInterface } from '../sms/sms.service.interface.js';
import { formatDateTime } from '../common/labels.js';
import { portalLoginUrl } from '../common/links/frontend-url.js';

export type InterviewNotice = 'interview_booked' | 'interview_cancelled' | 'interview_updated';

/**
 * C17: the mail + SMS for a booked, cancelled or changed interview, with the
 * slot's date/time in the association's time zone and the applicant's
 * language. Called only after the change has committed.
 */
export async function sendInterviewNotice(
  deps: { env: Env; mail: MailServiceInterface; sms: SmsServiceInterface },
  key: InterviewNotice,
  application: Application,
  slot: Pick<InterviewSlot, 'startsAt' | 'locationAr' | 'locationEn'>,
): Promise<void> {
  const locale = application.locale;
  const { date, time } = formatDateTime(new Date(slot.startsAt), locale);
  const location = (locale === 'en' ? slot.locationEn || slot.locationAr : slot.locationAr || slot.locationEn) ?? '';
  const name = `${application.firstName ?? ''} ${application.lastName ?? ''}`.trim();
  const entity = { type: 'applications', id: application.id };
  await deps.mail.send({
    key,
    to: application.email ?? '',
    vars: { name, reference: application.reference, date, time, location, link: portalLoginUrl(deps.env, locale) },
    locale,
    entity,
  });
  await deps.sms.send({
    key,
    to: application.phoneE164 ?? application.phone ?? '',
    vars: { reference: application.reference, date, time },
    locale,
    entity,
  });
}
