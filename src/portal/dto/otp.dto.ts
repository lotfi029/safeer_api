import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** A reference (e.g. `SA-2026-00185`), an email address, or a phone number — resolved by `PortalOtpService.findApplication()`. */
export const requestOtpSchema = z
  .object({
    identifier: z.string().min(1).max(191),
    /**
     * B1 (safeer-backend-fr-review.md): the caller's preferred delivery
     * channel. Omitted means "prefer SMS when a real driver is
     * configured, otherwise email" — see `PortalOtpService.requestOtp`.
     * Not a promise the code is actually sent that way: SMS falls back to
     * email when the driver is `log` in production or the send fails.
     */
    channel: z.enum(['sms', 'email']).optional(),
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
