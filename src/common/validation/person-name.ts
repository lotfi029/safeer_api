import { z } from 'zod';

/**
 * C16: a person's name — Arabic or Latin letters (with their combining
 * marks: harakat, accents), spaces, apostrophes and hyphens only. Names are
 * echoed into mail sent to unverified addresses (contact_ack,
 * contact_notify), so nothing that could render as a
 * URL, an email address or markup — `:`, `/`, `.`, `@`, digits — may get in.
 */
const PERSON_NAME_RE = /^(?:(?=[\p{Script=Arabic}\p{Script=Latin}])\p{L}|\p{M}|['’ -])+$/u;

export function personName(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(PERSON_NAME_RE, "must contain only Arabic or Latin letters, spaces, ' and -");
}
