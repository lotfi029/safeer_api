import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createBoardMemberSchema = z
  .object({
    nameAr: z.string().min(1).max(191),
    nameEn: z.string().trim().max(191).nullable().optional(),
    roleAr: z.string().min(1).max(120),
    roleEn: z.string().trim().max(120).nullable().optional(),
    grp: z.enum(['board', 'executive']),
    isLead: z.boolean().optional(),
    /** 023: the org-chart position this member holds (admin/org-positions id), or null. */
    orgPositionId: z.string().regex(/^\d+$/).nullable().optional(),
    /** B12 (safeer-backend-fr-review.md) */
    bioAr: z.string().min(1).max(5000).nullable().optional(),
    bioEn: z.string().trim().max(5000).nullable().optional(),
    photoAssetId: z.string().nullable().optional(),
    isPublished: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateBoardMemberSchema = createBoardMemberSchema.partial();

export class CreateBoardMemberDto extends createZodDto(createBoardMemberSchema) {}
export class UpdateBoardMemberDto extends createZodDto(updateBoardMemberSchema) {}
