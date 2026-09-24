import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `draft` IS included here, deliberately, even though it's never a valid
 * target — see transitions.ts's header comment. Excluding it from this
 * enum would make `PATCH {status: 'draft'}` fail Zod validation with a
 * generic 400 ("invalid enum value") before ever reaching the transition
 * map, which would bury the actual, more specific reason (this is a
 * disallowed transition, not an unrecognised value) behind a less
 * informative error. Letting it through to `assertStatusTransition()`
 * instead means every disallowed target — `draft` included — gets the same
 * 409 `INVALID_STATUS_TRANSITION` naming the exact `from`/`to` pair,
 * because `APPLICATION_STATUS_TRANSITIONS` never lists `draft` as a target
 * for any status (transitions.ts).
 */
export const ADMIN_SETTABLE_STATUSES = ['draft', 'new', 'under_review', 'docs_missing', 'interview', 'accepted', 'rejected'] as const;

export const updateApplicationAdminSchema = z
  .object({
    status: z.enum(ADMIN_SETTABLE_STATUSES).optional(),
    /** bigint id as a string; `null` clears the assignment. */
    assignedReviewerId: z
      .string()
      .regex(/^\d+$/, 'assignedReviewerId must be numeric')
      .nullable()
      .optional(),
  })
  .strict();

export class UpdateApplicationAdminDto extends createZodDto(updateApplicationAdminSchema) {}
