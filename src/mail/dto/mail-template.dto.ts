import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// `key` and `variables` are never editable here — `variables` is "the
// allow-list, owned by the code" (database.entities/mail-template.entity.ts).
export const updateMailTemplateSchema = z
  .object({
    nameAr: z.string().min(1).max(191).optional(),
    nameEn: z.string().max(191).nullable().optional(),
    subjectAr: z.string().min(1).max(255).optional(),
    subjectEn: z.string().max(255).nullable().optional(),
    bodyAr: z.string().min(1).optional(),
    bodyEn: z.string().nullable().optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict();

export const previewMailTemplateSchema = z
  .object({
    vars: z.record(z.string(), z.string()).optional(),
    locale: z.enum(['ar', 'en']).optional(),
  })
  .strict();

export class UpdateMailTemplateDto extends createZodDto(updateMailTemplateSchema) {}
export class PreviewMailTemplateDto extends createZodDto(previewMailTemplateSchema) {}
