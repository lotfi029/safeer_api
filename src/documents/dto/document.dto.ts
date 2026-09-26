import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createDocumentSchema = z
  .object({
    categoryId: z.string().min(1),
    titleAr: z.string().min(1).max(255),
    titleEn: z.string().trim().max(255).nullable().optional(),
    // NULL renders as "coming soon" — deliberately nullable, not required.
    assetId: z.string().nullable().optional(),
    docDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    isPublished: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateDocumentSchema = createDocumentSchema.partial();

export class CreateDocumentDto extends createZodDto(createDocumentSchema) {}
export class UpdateDocumentDto extends createZodDto(updateDocumentSchema) {}
