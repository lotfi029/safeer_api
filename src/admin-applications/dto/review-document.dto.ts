import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `reason` is optional at the schema level and enforced as required-when-
 * rejecting in the service (a plain 400 VALIDATION_FAILED) — zod's own
 * `.refine()` would work too, but keeping the "reason required on reject"
 * rule next to the rest of admin-applications.service.ts's document-review
 * logic (which also has to check it isn't blank) reads better than splitting
 * the same rule across a schema and a service.
 */
export const reviewDocumentSchema = z
  .object({
    status: z.enum(['accepted', 'rejected']),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

export class ReviewDocumentDto extends createZodDto(reviewDocumentSchema) {}
