import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `POST admin/users`: an admin creates an active account and sets its first
 * password themselves — no invitation mail (the owner's decision, replacing
 * FR-A-09 for this route; the invite flow stays). Same password rule as
 * accept/reset/change.
 */
export const createUserSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1).max(120),
    /** The role to assign (an id from GET admin/users/assignable-roles). */
    roleId: z.string().regex(/^\d+$/, 'A role id'),
    password: z.string().min(8).max(200),
  })
  .strict();

export class CreateUserDto extends createZodDto(createUserSchema) {}
