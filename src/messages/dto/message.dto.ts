import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const replyMessageSchema = z.object({ body: z.string().min(1).max(5000) }).strict();
export class ReplyMessageDto extends createZodDto(replyMessageSchema) {}

export const setMessageStatusSchema = z.object({ status: z.enum(['unread', 'read', 'archived']) }).strict();
export class SetMessageStatusDto extends createZodDto(setMessageStatusSchema) {}

/**
 * `authorName` defaults to the message's own `name` when omitted, and
 * `authorDesc` maps onto the testimonial's `authorDescAr` (the message has no
 * separate ar/en split to draw an English description from) — see
 * messages.service.ts's `convertToTestimonial`.
 */
export const convertToTestimonialSchema = z
  .object({
    quoteAr: z.string().min(1),
    quoteEn: z.string().nullable().optional(),
    authorName: z.string().min(1).max(191).optional(),
    authorDesc: z.string().max(255).nullable().optional(),
  })
  .strict();
export class ConvertToTestimonialDto extends createZodDto(convertToTestimonialSchema) {}
