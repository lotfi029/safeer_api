import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { safeUrl } from '../../common/validation/safe-url.js';

export const createPartnerSchema = z
  .object({
    nameAr: z.string().min(1).max(191),
    nameEn: z.string().trim().max(191).nullable().optional(),
    category: z.enum(['government', 'university', 'association', 'supporter']),
    url: safeUrl().nullable().optional(), // C10
    logoAssetId: z.string().nullable().optional(),
    isPublished: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updatePartnerSchema = createPartnerSchema.partial();

export class CreatePartnerDto extends createZodDto(createPartnerSchema) {}
export class UpdatePartnerDto extends createZodDto(updatePartnerSchema) {}
