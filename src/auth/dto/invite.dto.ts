import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const inviteSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1).max(120),
    role: z.enum(['admin', 'editor', 'support']),
  })
  .strict();

export class InviteDto extends createZodDto(inviteSchema) {}
