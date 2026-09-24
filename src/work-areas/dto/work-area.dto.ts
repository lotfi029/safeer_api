import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createWorkAreaSchema = z
  .object({
    icon: z.string().max(64).nullable().optional(),
    titleAr: z.string().min(1).max(191),
    titleEn: z.string().max(191).nullable().optional(),
    isPublished: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateWorkAreaSchema = createWorkAreaSchema.partial();

export class CreateWorkAreaDto extends createZodDto(createWorkAreaSchema) {}
export class UpdateWorkAreaDto extends createZodDto(updateWorkAreaSchema) {}

export const createWorkAreaItemSchema = z
  .object({
    workAreaId: z.string().min(1),
    textAr: z.string().min(1).max(255),
    textEn: z.string().max(255).nullable().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateWorkAreaItemSchema = createWorkAreaItemSchema.partial();

export class CreateWorkAreaItemDto extends createZodDto(createWorkAreaItemSchema) {}
export class UpdateWorkAreaItemDto extends createZodDto(updateWorkAreaItemSchema) {}
