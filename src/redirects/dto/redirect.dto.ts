import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { SITE_PATH_RE } from '../../common/validation/safe-url.js';

/**
 * C10: both ends of a redirect are site paths — `/…`, never `//host` or an
 * absolute URL, which would make the site an open redirect. `from` and
 * `to` must differ; chains (a → b → c) are refused by RedirectsController,
 * which can see the other rows.
 */
const sitePath = z
  .string()
  .trim()
  .min(2)
  .max(255)
  .regex(SITE_PATH_RE, 'must be a site path starting with a single / (no scheme, no //host)');

export const createRedirectSchema = z
  .object({
    fromPath: sitePath,
    toPath: sitePath,
    statusCode: z.union([z.literal(301), z.literal(302)]).optional(),
  })
  .strict()
  .refine((v) => v.fromPath !== v.toPath, { message: 'fromPath and toPath must differ', path: ['toPath'] });

export const updateRedirectSchema = z
  .object({
    fromPath: sitePath.optional(),
    toPath: sitePath.optional(),
    statusCode: z.union([z.literal(301), z.literal(302)]).optional(),
  })
  .strict();

export class CreateRedirectDto extends createZodDto(createRedirectSchema) {}
export class UpdateRedirectDto extends createZodDto(updateRedirectSchema) {}
