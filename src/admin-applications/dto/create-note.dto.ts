import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createApplicationNoteSchema = z.object({ body: z.string().min(1).max(5000) }).strict();

export class CreateApplicationNoteDto extends createZodDto(createApplicationNoteSchema) {}
