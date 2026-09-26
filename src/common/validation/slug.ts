import { z } from 'zod';

/**
 * C14: a URL slug — lower-case ASCII letters and digits in hyphen-separated
 * words, at most SLUG_MAX characters (leaving room under varchar(191) for a
 * `-N` de-duplication suffix).
 */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 180;

/**
 * Words that are (or may become) fixed routes next to `/news/:slug` —
 * `GET /news/featured` already is one — so no post may take them.
 */
export const RESERVED_POST_SLUGS = new Set(['featured', 'new', 'edit', 'preview', 'admin', 'api', 'sitemap', 'search', 'feed', 'rss', 'categories', 'category']);

export function slugSchema({ reserved }: { reserved?: ReadonlySet<string> } = {}) {
  return z
    .string()
    .trim()
    .min(1)
    .max(SLUG_MAX)
    .regex(SLUG_RE, 'must be lower-case letters and digits separated by single hyphens')
    .refine((v) => !reserved?.has(v), { message: 'this slug is reserved' });
}

export function isValidSlug(value: string, reserved?: ReadonlySet<string>): boolean {
  return value.length <= SLUG_MAX && SLUG_RE.test(value) && !reserved?.has(value);
}
