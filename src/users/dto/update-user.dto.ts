import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateUserSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    email: z.string().email().optional(),
    /** PERM-4: the role to assign (an id from GET admin/users/assignable-roles). */
    roleId: z.string().regex(/^\d+$/, 'A role id').optional(),
    /** C3: an admin enables or disables the account. `invited` is set only by the invitation flow. */
    status: z.enum(['active', 'disabled']).optional(),
    /** C12: clears a running brute-force lock and the failed-sign-in counter. */
    unlock: z.literal(true).optional(),
  })
  .strict();

export class UpdateUserDto extends createZodDto(updateUserSchema) {}
