import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// `token` mirrors mail-settings.dto.ts's `password`: omitted or empty leaves
// the stored ciphertext untouched — only a non-empty string replaces it.
export const updateSmsSettingsSchema = z
  .object({
    isEnabled: z.boolean().optional(),
    driver: z.enum(['log', 'http']).optional(),
    providerUrl: z.string().url().max(500).nullable().optional(),
    token: z.string().min(1).max(255).optional(),
    senderName: z.string().max(120).nullable().optional(),
  })
  .strict();

export const testSmsSchema = z.object({ to: z.string().min(3).max(40) }).strict();

export class UpdateSmsSettingsDto extends createZodDto(updateSmsSettingsSchema) {}
export class TestSmsDto extends createZodDto(testSmsSchema) {}
