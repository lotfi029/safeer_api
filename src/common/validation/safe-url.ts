import { z } from 'zod';

/**
 * C10: a URL that is stored and rendered on the public site (page-section
 * buttons, partner links, social links). zod's `.url()` accepts any scheme
 * — `javascript:alert(1)` included — so an editor could plant stored XSS.
 * Allowed: absolute `https:` / `http:` / `mailto:` / `tel:` URLs, and, where
 * `relative` is set, a site-relative path `/…` (never `//host`, which a
 * browser treats as another origin).
 */
const ALLOWED_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'tel:']);
export const SITE_PATH_RE = /^\/(?!\/)[^\s\\]*$/;

export function isSafeUrl(value: string, relative: boolean): boolean {
  if (relative && SITE_PATH_RE.test(value)) return true;
  if (/[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (!ALLOWED_SCHEMES.has(url.protocol)) return false;
    return url.protocol === 'mailto:' || url.protocol === 'tel:' || Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function safeUrl({ relative = false, max = 255 }: { relative?: boolean; max?: number } = {}) {
  return z
    .string()
    .trim()
    .max(max)
    .refine((v) => isSafeUrl(v, relative), {
      message: relative
        ? 'must be an http(s), mailto: or tel: URL, or a site path starting with a single /'
        : 'must be an http(s), mailto: or tel: URL',
    });
}
