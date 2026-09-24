import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// `password` is intentionally not nullable: omitted or `''` leaves the
// stored credential untouched (trap 12); only a non-empty string replaces
// it. The stored ciphertext itself is never part of this schema — nothing
// here can read it back out.
export const updateMailSettingsSchema = z
  .object({
    isEnabled: z.boolean().optional(),
    driver: z.enum(['smtp', 'log']).optional(),
    host: z.string().max(191).nullable().optional(),
    port: z.number().int().positive().max(65535).nullable().optional(),
    encryption: z.enum(['none', 'tls', 'starttls']).optional(),
    username: z.string().max(191).nullable().optional(),
    password: z.string().min(1).max(255).optional(),
    fromNameAr: z.string().max(120).nullable().optional(),
    fromNameEn: z.string().max(120).nullable().optional(),
    fromEmail: z.string().email().max(191).nullable().optional(),
    replyTo: z.string().email().max(191).nullable().optional(),
    notifyEmail: z.string().email().max(191).nullable().optional(),
  })
  .strict();

export const testMailSchema = z.object({ to: z.string().email() }).strict();

export class UpdateMailSettingsDto extends createZodDto(updateMailSettingsSchema) {}
export class TestMailDto extends createZodDto(testMailSchema) {}
