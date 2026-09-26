import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const setAltTextSchema = z
  .object({
    altAr: z.string().min(1).max(255),
    altEn: z.string().trim().max(255).nullable().optional(),
  })
  .strict();

export class SetAltTextDto extends createZodDto(setAltTextSchema) {}
