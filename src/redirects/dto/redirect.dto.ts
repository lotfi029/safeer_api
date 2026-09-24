import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createRedirectSchema = z
  .object({
    fromPath: z.string().min(1).max(255),
    toPath: z.string().min(1).max(255),
    statusCode: z.union([z.literal(301), z.literal(302)]).optional(),
  })
  .strict();

export const updateRedirectSchema = createRedirectSchema.partial();

export class CreateRedirectDto extends createZodDto(createRedirectSchema) {}
export class UpdateRedirectDto extends createZodDto(updateRedirectSchema) {}
