import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createDocCategorySchema = z
  .object({
    slug: z.string().min(1).max(64),
    nameAr: z.string().min(1).max(191),
    nameEn: z.string().max(191).nullable().optional(),
    isPublished: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateDocCategorySchema = createDocCategorySchema.partial();

export class CreateDocCategoryDto extends createZodDto(createDocCategorySchema) {}
export class UpdateDocCategoryDto extends createZodDto(updateDocCategorySchema) {}
