import { createZodDto } from 'nestjs-zod';
import { createApplicationSchema } from '../application-fields.schema.js';

export class CreateApplicationDto extends createZodDto(createApplicationSchema) {}
