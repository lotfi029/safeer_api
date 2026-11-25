import type { Locale } from './request-context.js';
import type { ContactMessageSubject } from '../database/entities/contact-message.entity.js';

/**
 * C23: human labels for the codes that go into mail variables — an Arabic
 * reader must read "استفسار", not `inquiry`. (Role names used to live here
 * too; since PERM-4 they are the `roles` table's own `name_ar`/`name_en`.)
 */
type Labels<K extends string> = Record<K, { ar: string; en: string }>;

/** The contact form's subjects — also served by GET meta/enums (contactSubject). */
export const CONTACT_SUBJECT_LABELS: Labels<ContactMessageSubject> = {
  inquiry: { ar: 'استفسار', en: 'Inquiry' },
  partnership: { ar: 'شراكة', en: 'Partnership' },
  support: { ar: 'دعم وتبرع', en: 'Support and donations' },
  feedback: { ar: 'ملاحظات', en: 'Feedback' },
  other: { ar: 'أخرى', en: 'Other' },
};

export const contactSubjectLabel = (subject: string, locale: Locale): string =>
  CONTACT_SUBJECT_LABELS[subject as keyof typeof CONTACT_SUBJECT_LABELS]?.[locale] ?? subject;
