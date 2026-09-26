import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { safeUrl } from '../../common/validation/safe-url.js';
import { slugSchema } from '../../common/validation/slug.js';

export const createPageSchema = z
  .object({
    slug: slugSchema(), // C14
    titleAr: z.string().min(1).max(191),
    titleEn: z.string().trim().max(191).nullable().optional(),
    metaTitleAr: z.string().max(191).nullable().optional(),
    metaTitleEn: z.string().trim().max(191).nullable().optional(),
    metaDescriptionAr: z.string().max(500).nullable().optional(),
    metaDescriptionEn: z.string().trim().max(500).nullable().optional(),
    isPublished: z.boolean().optional(),
    needsReview: z.boolean().optional(),
  })
  .strict();

/**
 * C14: a page's slug is read-only once created — system pages (`home`,
 * `about`, …) are addressed by slug from the site nav, the home aggregate
 * and the frontend's routes, so renaming one breaks them. Sending `slug`
 * on update is a 400 (strict schema).
 */
export const updatePageSchema = createPageSchema.omit({ slug: true }).partial().strict();

export class CreatePageDto extends createZodDto(createPageSchema) {}
export class UpdatePageDto extends createZodDto(updatePageSchema) {}

export const createPageSectionSchema = z
  .object({
    pageId: z.string().min(1),
    sectionKey: z.string().min(1).max(64),
    labelAr: z.string().max(191).nullable().optional(),
    labelEn: z.string().trim().max(191).nullable().optional(),
    headingAr: z.string().max(255).nullable().optional(),
    headingEn: z.string().trim().max(255).nullable().optional(),
    bodyAr: z.string().nullable().optional(),
    bodyEn: z.string().trim().nullable().optional(),
    primaryButtonLabelAr: z.string().max(120).nullable().optional(),
    primaryButtonLabelEn: z.string().trim().max(120).nullable().optional(),
    primaryButtonUrl: safeUrl({ relative: true }).nullable().optional(), // C10
    secondaryButtonLabelAr: z.string().max(120).nullable().optional(),
    secondaryButtonLabelEn: z.string().trim().max(120).nullable().optional(),
    secondaryButtonUrl: safeUrl({ relative: true }).nullable().optional(), // C10
    imageAssetId: z.string().nullable().optional(),
    isPublished: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updatePageSectionSchema = createPageSectionSchema.partial();

export class CreatePageSectionDto extends createZodDto(createPageSectionSchema) {}
export class UpdatePageSectionDto extends createZodDto(updatePageSectionSchema) {}
