import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// `key` and `variables` are never editable here — `variables` is "the
// allow-list, owned by the code" (database/entities/sms-template.entity.ts).
export const updateSmsTemplateSchema = z
  .object({
    nameAr: z.string().min(1).max(191).optional(),
    nameEn: z.string().max(191).nullable().optional(),
    bodyAr: z.string().min(1).max(480).optional(),
    bodyEn: z.string().max(480).nullable().optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict();

export const previewSmsTemplateSchema = z
  .object({
    vars: z.record(z.string(), z.string()).optional(),
    locale: z.enum(['ar', 'en']).optional(),
  })
  .strict();

export class UpdateSmsTemplateDto extends createZodDto(updateSmsTemplateSchema) {}
export class PreviewSmsTemplateDto extends createZodDto(previewSmsTemplateSchema) {}
