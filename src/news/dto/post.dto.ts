import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// `slug` and `createdBy` are never client-settable at create time — the
// controller derives them (generated slug, req.user.id), matching
// african_api's posts.controller.ts. `slug` is exposed only on update, for
// an editor explicitly renaming a draft.
export const createPostSchema = z
  .object({
    titleAr: z.string().min(1).max(191),
    titleEn: z.string().max(191).nullable().optional(),
    excerptAr: z.string().nullable().optional(),
    excerptEn: z.string().nullable().optional(),
    bodyAr: z.string().nullable().optional(),
    bodyEn: z.string().nullable().optional(),
    categoryId: z.string().min(1),
    coverAssetId: z.string().nullable().optional(),
    publishedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    isFeatured: z.boolean().optional(),
    isLegacy: z.boolean().optional(),
    isPublished: z.boolean().optional(),
  })
  .strict();

export const updatePostSchema = createPostSchema.partial().extend({
  slug: z.string().min(1).max(191).optional(),
});

export class CreatePostDto extends createZodDto(createPostSchema) {}
export class UpdatePostDto extends createZodDto(updatePostSchema) {}
