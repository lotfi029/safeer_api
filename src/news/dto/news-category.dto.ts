import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createNewsCategorySchema = z
  .object({
    slug: z.string().min(1).max(191),
    nameAr: z.string().min(1).max(191),
    nameEn: z.string().max(191).nullable().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateNewsCategorySchema = createNewsCategorySchema.partial();

export class CreateNewsCategoryDto extends createZodDto(createNewsCategorySchema) {}
export class UpdateNewsCategoryDto extends createZodDto(updateNewsCategorySchema) {}
