import { createZodDto } from 'nestjs-zod';
import { partialApplicationSchema } from '../../applications/application-fields.schema.js';

export class UpdateApplicationDto extends createZodDto(partialApplicationSchema) {}
