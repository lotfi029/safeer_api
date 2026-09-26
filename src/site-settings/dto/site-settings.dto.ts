import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateSiteSettingsSchema = z
  .object({
    orgNameAr: z.string().min(1).max(191).optional(),
    orgNameEn: z.string().max(191).nullable().optional(),
    taglineAr: z.string().max(255).nullable().optional(),
    taglineEn: z.string().max(255).nullable().optional(),
    footerBlurbAr: z.string().nullable().optional(),
    footerBlurbEn: z.string().nullable().optional(),
    rightsLineAr: z.string().max(255).nullable().optional(),
    rightsLineEn: z.string().max(255).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    email: z.string().email().max(191).nullable().optional(),
    addressAr: z.string().max(255).nullable().optional(),
    addressEn: z.string().max(255).nullable().optional(),
    facebookUrl: z.string().url().max(255).nullable().optional(),
    instagramUrl: z.string().url().max(255).nullable().optional(),
    xUrl: z.string().url().max(255).nullable().optional(),
    youtubeUrl: z.string().url().max(255).nullable().optional(),
    linkedinUrl: z.string().url().max(255).nullable().optional(),
    whatsappUrl: z.string().url().max(255).nullable().optional(),
    tiktokUrl: z.string().url().max(255).nullable().optional(),
    enEnabled: z.boolean().optional(),
    seoTitleAr: z.string().max(191).nullable().optional(),
    seoTitleEn: z.string().max(191).nullable().optional(),
    seoDescriptionAr: z.string().max(500).nullable().optional(),
    seoDescriptionEn: z.string().max(500).nullable().optional(),
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
