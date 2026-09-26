import type { Locale } from './request-context.js';
import type { ApplicationStatus } from '../database/entities/application.entity.js';
import type { ApplicationDocType } from '../database/entities/application-document.entity.js';
import type { UserRole } from '../database/entities/user.entity.js';

/**
 * C23: human labels for the codes that go into mail/SMS variables — an
 * Arabic applicant must read "قيد المراجعة", not `under_review`. The wording
 * is the prototype's own (docs/prototype/safeer-prototype.html: the admin
 * status select, pPortalDocs(), the users screen's roles list).
 */
type Labels<K extends string> = Record<K, { ar: string; en: string }>;

const STATUS_LABELS: Labels<ApplicationStatus> = {
  draft: { ar: 'مسودة', en: 'Draft' },
  new: { ar: 'جديد', en: 'New' },
  under_review: { ar: 'قيد المراجعة', en: 'Under review' },
  docs_missing: { ar: 'مستندات ناقصة', en: 'Documents missing' },
  interview: { ar: 'مقابلة', en: 'Interview' },
  accepted: { ar: 'مقبول', en: 'Accepted' },
  rejected: { ar: 'مرفوض', en: 'Rejected' },
};

const DOC_TYPE_LABELS: Labels<ApplicationDocType> = {
  id_copy: { ar: 'صورة الهوية', en: 'ID copy' },
  certificate: { ar: 'الشهادة الثانوية', en: 'High school certificate' },
  admission_letter: { ar: 'خطاب القبول الجامعي', en: 'University admission letter' },
  other: { ar: 'مستند اختياري', en: 'Optional document' },
};

const ROLE_LABELS: Labels<UserRole> = {
  admin: { ar: 'مدير عام', en: 'Admin' },
  reviewer: { ar: 'مراجع طلبات', en: 'Reviewer' },
  editor: { ar: 'محرر محتوى', en: 'Editor' },
  support: { ar: 'دعم ومراسلات', en: 'Support' },
};

const CONTACT_SUBJECT_LABELS: Labels<'scholarship' | 'partnership' | 'feedback' | 'other'> = {
  scholarship: { ar: 'استفسار عن المنح', en: 'Scholarship enquiry' },
  partnership: { ar: 'طلب شراكة', en: 'Partnership request' },
  feedback: { ar: 'ملاحظة أو اقتراح', en: 'Feedback' },
  other: { ar: 'موضوع آخر', en: 'Other' },
};

export const contactSubjectLabel = (subject: string, locale: Locale): string =>
  CONTACT_SUBJECT_LABELS[subject as keyof typeof CONTACT_SUBJECT_LABELS]?.[locale] ?? subject;

export const statusLabel = (status: ApplicationStatus, locale: Locale): string => STATUS_LABELS[status]?.[locale] ?? status;
export const docTypeLabel = (docType: ApplicationDocType, locale: Locale): string => DOC_TYPE_LABELS[docType]?.[locale] ?? docType;
export const roleLabel = (role: UserRole, locale: Locale): string => ROLE_LABELS[role]?.[locale] ?? role;

export function docTypeList(docTypes: ApplicationDocType[], locale: Locale): string {
  return docTypes.map((t) => docTypeLabel(t, locale)).join(locale === 'ar' ? '، ' : ', ');
}

/**
 * The association's own time zone, for showing a time to a person (an
 * interview slot in a mail). Storage and comparisons stay UTC (C9).
 */
export const DISPLAY_TIME_ZONE = 'Asia/Riyadh';

/** A date and time for a mail/SMS, in the association's time zone and the recipient's language (Gregorian calendar). */
export function formatDateTime(value: Date, locale: Locale): { date: string; time: string } {
  const tag = locale === 'ar' ? 'ar-u-ca-gregory' : 'en-GB';
  return {
    date: new Intl.DateTimeFormat(tag, { timeZone: DISPLAY_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(value),
    time: new Intl.DateTimeFormat(tag, { timeZone: DISPLAY_TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(value),
  };
}
