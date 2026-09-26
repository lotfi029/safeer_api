import { z } from 'zod';
import { normalizePhone } from '../common/phone.js';
import { personName } from '../common/validation/person-name.js';

/**
 * The three form steps the prototype's apply flow collects, as raw zod
 * shapes so `POST applications` (step 1 only, required), `PATCH
 * portal/application` (any subset, all optional) and `POST
 * portal/application/submit` (everything, required) can each build the
 * exact schema they need from the same field definitions rather than
 * three hand-copied lists that could drift.
 */

export const step1Shape = {
  // C16: letters (Arabic/Latin), spaces, ' and - only.
  firstName: personName(120),
  middleName: personName(120).nullable().optional(),
  lastName: personName(120),
  /** YYYY-MM-DD — matches `applications.birth_date`'s DATE column. */
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'birthDate must be YYYY-MM-DD'),
  /** Normalised to E.164 on save (B2) — see `Application.syncPhoneE164`/`normalizePhone`. `+966` is the default country code for a local `05…` number. */
  phone: z
    .string()
    .min(5)
    .max(40)
    .refine((v) => normalizePhone(v) !== null, 'phone must be a valid phone number (e.g. 05XXXXXXXX or +9665XXXXXXXX)'),
  /** ISO 3166-1 alpha-2, stored upper-case. */
  nationality: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, 'nationality must be a 2-letter country code')
    .transform((v) => v.toUpperCase()),
  idNumber: z.string().min(1).max(40).nullable().optional(),
  email: z.string().email().max(191),
  currentJob: z.string().min(1).max(191).nullable().optional(),
  gender: z.enum(['male', 'female']),
} satisfies z.ZodRawShape;

export const step2Shape = {
  university: z.string().min(1).max(191),
  major: z.string().min(1).max(191),
  degreeLevel: z.enum(['bachelor', 'master', 'phd']),
  scholarshipNote: z.string().min(1).max(5000).nullable().optional(),
} satisfies z.ZodRawShape;

export const STEP1_KEYS = Object.keys(step1Shape);
export const STEP2_KEYS = Object.keys(step2Shape);
export const STEP3_KEYS = ['consent'];

/** `POST applications` — step 1 only, the fields the "start an application" form collects. */
export const createApplicationSchema = z.object(step1Shape).strict();

/** `POST portal/application/submit` — every field across all three steps, all required (the nullable-optional ones stay optional even here — a middle name, ID number, current job or scholarship note is never mandatory). Consent must be explicitly `true`. */
export const fullApplicationSchema = z
  .object({
    ...step1Shape,
    ...step2Shape,
    consent: z.literal(true),
  })
  .strict();

/** `PATCH portal/application` — any subset of the same fields, for autosave. */
export const partialApplicationSchema = z
  .object({
    ...step1Shape,
    ...step2Shape,
    consent: z.boolean(),
  })
  .partial()
  .strict();

/**
 * Which of the 3 form steps a PATCH payload touches, used to compute how
 * far `current_step` should advance (applications.service.ts and
 * portal-application.service.ts share this so "progress" means the same
 * thing in both places, even though only the portal PATCH actually calls
 * it today).
 */
export function highestStepInPayload(keys: string[]): number {
  let step = 0;
  if (keys.some((k) => STEP1_KEYS.includes(k))) step = 1;
  if (keys.some((k) => STEP2_KEYS.includes(k))) step = 2;
  if (keys.some((k) => STEP3_KEYS.includes(k))) step = 3;
  return step;
}
