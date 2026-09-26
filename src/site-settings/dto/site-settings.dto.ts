import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { safeUrl } from '../../common/validation/safe-url.js';

export const updateSiteSettingsSchema = z
  .object({
    orgNameAr: z.string().min(1).max(191).optional(),
    orgNameEn: z.string().trim().max(191).nullable().optional(),
    taglineAr: z.string().max(255).nullable().optional(),
    taglineEn: z.string().trim().max(255).nullable().optional(),
    footerBlurbAr: z.string().nullable().optional(),
    footerBlurbEn: z.string().trim().nullable().optional(),
    rightsLineAr: z.string().max(255).nullable().optional(),
    rightsLineEn: z.string().trim().max(255).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    email: z.string().email().max(191).nullable().optional(),
    addressAr: z.string().max(255).nullable().optional(),
    addressEn: z.string().trim().max(255).nullable().optional(),
    facebookUrl: safeUrl().nullable().optional(), // C10
    instagramUrl: safeUrl().nullable().optional(), // C10
    xUrl: safeUrl().nullable().optional(), // C10
    youtubeUrl: safeUrl().nullable().optional(), // C10
    linkedinUrl: safeUrl().nullable().optional(), // C10
    whatsappUrl: safeUrl().nullable().optional(), // C10
    tiktokUrl: safeUrl().nullable().optional(), // C10
    enEnabled: z.boolean().optional(),
    seoTitleAr: z.string().max(191).nullable().optional(),
    seoTitleEn: z.string().trim().max(191).nullable().optional(),
    seoDescriptionAr: z.string().max(500).nullable().optional(),
    seoDescriptionEn: z.string().trim().max(500).nullable().optional(),
    notifyEmailOnStatusChange: z.boolean().optional(),
    notifySmsOnStatusChange: z.boolean().optional(),
    applicationRefPrefix: z
      .string()
      .min(1)
      .max(10)
      .regex(/^[A-Z]+$/, 'applicationRefPrefix must be uppercase letters only')
      .optional(),
  })
  .strict();

export class UpdateSiteSettingsDto extends createZodDto(updateSiteSettingsSchema) {}
