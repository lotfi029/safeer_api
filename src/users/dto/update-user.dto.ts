import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateUserSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    email: z.string().email().optional(),
    role: z.enum(['admin', 'reviewer', 'editor', 'support']).optional(),
    isLocked: z.boolean().optional(),
  })
  .strict();

export class UpdateUserDto extends createZodDto(updateUserSchema) {}
