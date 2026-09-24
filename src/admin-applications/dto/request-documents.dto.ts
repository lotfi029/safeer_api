import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const DOC_TYPE_VALUES = ['id_copy', 'certificate', 'admission_letter', 'other'] as const;

export const requestDocumentsSchema = z
  .object({
    docTypes: z.array(z.enum(DOC_TYPE_VALUES)).min(1),
    message: z.string().max(2000).nullable().optional(),
  })
  .strict();

export class RequestDocumentsDto extends createZodDto(requestDocumentsSchema) {}
