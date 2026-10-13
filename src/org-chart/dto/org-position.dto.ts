import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ORG_TONES } from '../../database/entities/org-position.entity.js';

export const createOrgPositionSchema = z
  .object({
    nameAr: z.string().trim().min(1).max(190),
    nameEn: z.string().trim().max(190).nullable().optional(),
    /** The position this one reports to (admin/org-positions id), or null for a top-level box. At most 5 levels. */
    parentId: z.string().regex(/^\d+$/).nullable().optional(),
    tone: z.enum(ORG_TONES as [string, ...string[]]).optional(),
    /** Show the names of the published members holding this position. */
    showHolders: z.boolean().optional(),
    isPublished: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateOrgPositionSchema = createOrgPositionSchema.partial();

export class CreateOrgPositionDto extends createZodDto(createOrgPositionSchema) {}
export class UpdateOrgPositionDto extends createZodDto(updateOrgPositionSchema) {}
