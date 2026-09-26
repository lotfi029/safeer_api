import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { personName } from '../../common/validation/person-name.js';

// `website` is a honeypot: a real visitor never sees or fills this field
// (hidden by CSS on the form); a bot that fills every input trips it.
// `formRenderedAt` is the client's own clock (epoch ms) when the form was
// first shown — compared against arrival time for the minimum time-on-form
// check. Neither is persisted.
export const contactSchema = z
  .object({
    name: personName(191), // C16
    email: z.string().email().max(191),
    phone: z.string().max(40).nullable().optional(),
    subject: z.enum(['scholarship', 'partnership', 'feedback', 'other']),
    body: z.string().min(1).max(5000),
    website: z.string().max(255).optional(),
    formRenderedAt: z.number().int().positive(),
  })
  .strict();

export class ContactDto extends createZodDto(contactSchema) {}

export const newsletterSchema = z
  .object({
    email: z.string().email().max(191),
    website: z.string().max(255).optional(),
    formRenderedAt: z.number().int().positive(),
  })
  .strict();

export class NewsletterDto extends createZodDto(newsletterSchema) {}
