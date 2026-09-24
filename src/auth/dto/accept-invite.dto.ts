import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const acceptInviteSchema = z
  .object({
    password: z.string().min(8),
  })
  .strict();

export class AcceptInviteDto extends createZodDto(acceptInviteSchema) {}
