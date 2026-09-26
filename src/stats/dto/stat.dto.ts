import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createStatSchema = z
  .object({
    // Nullable — renders as "—" until verified (12-database.md).
    value: z
      .string()
      .regex(/^\d+$/, 'value must be a non-negative integer')
      .nullable()
      .optional(),
    labelAr: z.string().min(1).max(120),
    labelEn: z.string().trim().max(120).nullable().optional(),
    subAr: z.string().max(191).nullable().optional(),
    subEn: z.string().trim().max(191).nullable().optional(),
    isPublished: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateStatSchema = createStatSchema.partial();

export class CreateStatDto extends createZodDto(createStatSchema) {}
export class UpdateStatDto extends createZodDto(updateStatSchema) {}
