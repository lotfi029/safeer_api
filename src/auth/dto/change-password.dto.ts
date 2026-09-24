import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
  })
  .strict();

export class ChangePasswordDto extends createZodDto(changePasswordSchema) {}
