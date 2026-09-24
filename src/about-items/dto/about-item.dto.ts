import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createAboutItemSchema = z
  .object({
    kind: z.enum(['vision', 'mission', 'goal', 'care_pillar', 'scholarship_step', 'requirement']),
    icon: z.string().max(64).nullable().optional(),
    titleAr: z.string().min(1).max(191),
    titleEn: z.string().max(191).nullable().optional(),
    bodyAr: z.string().nullable().optional(),
    bodyEn: z.string().nullable().optional(),
    isPublished: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateAboutItemSchema = createAboutItemSchema.partial();

export class CreateAboutItemDto extends createZodDto(createAboutItemSchema) {}
export class UpdateAboutItemDto extends createZodDto(updateAboutItemSchema) {}
