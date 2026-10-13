import type { Locale } from './request-context.js';
import type { UserRole } from '../database/entities/user.entity.js';
import type { ContactMessageSubject } from '../database/entities/contact-message.entity.js';

/**
 * C23: human labels for the codes that go into mail variables — an Arabic
 * reader must read "محرر محتوى", not `editor`. The wording is the
 * prototype's own (docs/prototype/safeer-prototype.html: the users
 * screen's roles list).
 */
type Labels<K extends string> = Record<K, { ar: string; en: string }>;

const ROLE_LABELS: Labels<UserRole> = {
  admin: { ar: 'مدير عام', en: 'Admin' },
  editor: { ar: 'محرر محتوى', en: 'Editor' },
  support: { ar: 'دعم ومراسلات', en: 'Support' },
};

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

export const roleLabel = (role: UserRole, locale: Locale): string => ROLE_LABELS[role]?.[locale] ?? role;
