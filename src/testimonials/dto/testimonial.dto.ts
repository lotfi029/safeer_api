import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createTestimonialSchema = z
  .object({
    quoteAr: z.string().min(1),
    quoteEn: z.string().trim().nullable().optional(),
    authorName: z.string().min(1).max(191),
    authorDescAr: z.string().max(255).nullable().optional(),
    authorDescEn: z.string().trim().max(255).nullable().optional(),
    status: z.enum(['pending', 'published', 'hidden']).optional(),
    isFeatured: z.boolean().optional(),
    source: z.enum(['manual', 'contact_form']).optional(),
    sourceMessageId: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateTestimonialSchema = createTestimonialSchema.partial();

export class CreateTestimonialDto extends createZodDto(createTestimonialSchema) {}
export class UpdateTestimonialDto extends createZodDto(updateTestimonialSchema) {}

export const setTestimonialStatusSchema = z.object({ status: z.enum(['pending', 'published', 'hidden']) }).strict();
export class SetTestimonialStatusDto extends createZodDto(setTestimonialStatusSchema) {}

export const setTestimonialFeatureSchema = z.object({ isFeatured: z.boolean() }).strict();
export class SetTestimonialFeatureDto extends createZodDto(setTestimonialFeatureSchema) {}

export const createTestimonialThemeSchema = z
  .object({
    titleAr: z.string().min(1).max(191),
    titleEn: z.string().trim().max(191).nullable().optional(),
    descriptionAr: z.string().nullable().optional(),
    descriptionEn: z.string().trim().nullable().optional(),
    isImprovement: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateTestimonialThemeSchema = createTestimonialThemeSchema.partial();

export class CreateTestimonialThemeDto extends createZodDto(createTestimonialThemeSchema) {}
export class UpdateTestimonialThemeDto extends createZodDto(updateTestimonialThemeSchema) {}
