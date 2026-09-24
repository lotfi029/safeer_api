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
  locationEn: z.string().max(255).nullable().optional(),
};

export const createInterviewSlotSchema = z.object(interviewSlotShape).strict();
export const updateInterviewSlotSchema = z.object(interviewSlotShape).partial().strict();
