import { createZodDto } from 'nestjs-zod';
import { correctionsSchema } from '../../applications/application-fields.schema.js';

export class ApplicationCorrectionsDto extends createZodDto(correctionsSchema) {}
