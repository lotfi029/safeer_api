import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const createLicenceSchema = z
  .object({
    titleAr: z.string().trim().min(1).max(191),
    titleEn: z.string().trim().max(191).nullable().optional(),
    number: z.string().trim().max(100).nullable().optional(),
    issuerAr: z.string().trim().max(190).nullable().optional(),
    issuerEn: z.string().trim().max(190).nullable().optional(),
    issuedOn: isoDate.nullable().optional(),
    expiresOn: isoDate.nullable().optional(),
    /** The licence document — a media asset id (PDF or image), or null for none yet. */
    assetId: z.string().regex(/^\d+$/).nullable().optional(),
    /** true makes this the one primary licence (any other loses the flag). */
    isPrimary: z.boolean().optional(),
    isPublished: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateLicenceSchema = createLicenceSchema.partial();

export const publishLicenceSchema = z.object({ isPublished: z.boolean().optional() }).strict();

export class CreateLicenceDto extends createZodDto(createLicenceSchema) {}
export class UpdateLicenceDto extends createZodDto(updateLicenceSchema) {}
export class PublishLicenceDto extends createZodDto(publishLicenceSchema) {}
