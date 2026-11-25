import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const inviteSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1).max(120),
    /** PERM-4: the role to assign (an id from GET admin/users/assignable-roles). */
    roleId: z.string().regex(/^\d+$/, 'A role id'),
  })
  .strict();

export class InviteDto extends createZodDto(inviteSchema) {}
