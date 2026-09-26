import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { safeUrl } from '../../common/validation/safe-url.js';

export const createPageSchema = z
  .object({
    slug: z.string().min(1).max(191),
    titleAr: z.string().min(1).max(191),
    titleEn: z.string().max(191).nullable().optional(),
    metaTitleAr: z.string().max(191).nullable().optional(),
    metaTitleEn: z.string().max(191).nullable().optional(),
    metaDescriptionAr: z.string().max(500).nullable().optional(),
    metaDescriptionEn: z.string().max(500).nullable().optional(),
    isPublished: z.boolean().optional(),
    needsReview: z.boolean().optional(),
  })
  .strict();

export const updatePageSchema = createPageSchema.partial();

export class CreatePageDto extends createZodDto(createPageSchema) {}
export class UpdatePageDto extends createZodDto(updatePageSchema) {}

export const createPageSectionSchema = z
  .object({
    pageId: z.string().min(1),
    sectionKey: z.string().min(1).max(64),
    labelAr: z.string().max(191).nullable().optional(),
    labelEn: z.string().max(191).nullable().optional(),
    headingAr: z.string().max(255).nullable().optional(),
    headingEn: z.string().max(255).nullable().optional(),
    bodyAr: z.string().nullable().optional(),
    bodyEn: z.string().nullable().optional(),
    primaryButtonLabelAr: z.string().max(120).nullable().optional(),
    primaryButtonLabelEn: z.string().max(120).nullable().optional(),
    primaryButtonUrl: safeUrl({ relative: true }).nullable().optional(), // C10
    secondaryButtonLabelAr: z.string().max(120).nullable().optional(),
    secondaryButtonLabelEn: z.string().max(120).nullable().optional(),
    secondaryButtonUrl: safeUrl({ relative: true }).nullable().optional(), // C10
    imageAssetId: z.string().nullable().optional(),
    isPublished: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updatePageSectionSchema = createPageSectionSchema.partial();

export class CreatePageSectionDto extends createZodDto(createPageSectionSchema) {}
export class UpdatePageSectionDto extends createZodDto(updatePageSectionSchema) {}
