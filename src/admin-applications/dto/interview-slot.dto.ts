import { z } from 'zod';

/**
 * `z.coerce.date()` (which nestjs-zod uses fine for validation) crashes
 * Swagger generation at boot: `nestjs-zod`'s OpenAPI metadata factory calls
 * zod v4's own `toJSONSchema()`, which throws "Date cannot be represented in
 * JSON Schema" for any `z.date()` (coerced or not) — there is no
 * JSON-Schema type for a native Date. Kept as a validated ISO 8601 string
 * instead: TypeORM's mysql driver's `DateUtils.mixedDateToDate()` already
 * parses a string value the same as a `Date` instance when persisting a
 * `datetime` column (verified against `node_modules/typeorm`), so nothing
 * downstream needs the value pre-converted.
 */
const interviewSlotShape = {
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  locationAr: z.string().max(255).nullable().optional(),
  locationEn: z.string().trim().max(255).nullable().optional(),
};

/** C17: a slot ends after it starts (the update path re-checks against the stored values too). */
const endsAfterStart = (v: { startsAt?: string; endsAt?: string }) =>
  v.startsAt === undefined || v.endsAt === undefined || new Date(v.endsAt) > new Date(v.startsAt);

export const createInterviewSlotSchema = z
  .object(interviewSlotShape)
  .strict()
  .refine(endsAfterStart, { message: 'endsAt must be after startsAt', path: ['endsAt'] });
export const updateInterviewSlotSchema = z
  .object(interviewSlotShape)
  .partial()
  .strict()
  .refine(endsAfterStart, { message: 'endsAt must be after startsAt', path: ['endsAt'] });
