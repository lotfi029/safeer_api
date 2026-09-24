import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** A reference (e.g. `SA-2026-00185`) or an email address — resolved by `PortalOtpService.findApplication()`. */
export const requestOtpSchema = z
  .object({
    identifier: z.string().min(1).max(191),
  })
  .strict();

export class RequestOtpDto extends createZodDto(requestOtpSchema) {}

export const verifyOtpSchema = z
  .object({
    identifier: z.string().min(1).max(191),
    code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  })
  .strict();

export class VerifyOtpDto extends createZodDto(verifyOtpSchema) {}
