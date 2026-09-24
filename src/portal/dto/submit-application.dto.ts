import { createZodDto } from 'nestjs-zod';
import { fullApplicationSchema } from '../../applications/application-fields.schema.js';

export class SubmitApplicationDto extends createZodDto(fullApplicationSchema) {}
