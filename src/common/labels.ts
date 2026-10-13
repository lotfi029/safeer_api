import type { Locale } from './request-context.js';
import type { UserRole } from '../database/entities/user.entity.js';

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

const CONTACT_SUBJECT_LABELS: Labels<'scholarship' | 'partnership' | 'feedback' | 'other'> = {
  scholarship: { ar: 'استفسار عن المنح', en: 'Scholarship enquiry' },
  partnership: { ar: 'طلب شراكة', en: 'Partnership request' },
  feedback: { ar: 'ملاحظة أو اقتراح', en: 'Feedback' },
  other: { ar: 'موضوع آخر', en: 'Other' },
};

export const contactSubjectLabel = (subject: string, locale: Locale): string =>
  CONTACT_SUBJECT_LABELS[subject as keyof typeof CONTACT_SUBJECT_LABELS]?.[locale] ?? subject;

export const roleLabel = (role: UserRole, locale: Locale): string => ROLE_LABELS[role]?.[locale] ?? role;
