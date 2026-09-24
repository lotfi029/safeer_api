import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const bookInterviewSchema = z
  .object({
    /** bigint id, serialized as a string (TypeORM's `bigint` columns map to `string` in this codebase). */
    slotId: z.string().regex(/^\d+$/, 'slotId must be numeric'),
  })
  .strict();

export class BookInterviewDto extends createZodDto(bookInterviewSchema) {}
