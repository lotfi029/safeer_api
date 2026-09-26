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

/**
 * A12: where an embedded map may come from — `https:` only, and only these
 * embed endpoints, because the frontend puts the URL straight into an
 * iframe's `src`. Each entry is a host plus a path prefix.
 */
export const MAP_EMBED_ALLOW_LIST: ReadonlyArray<{ host: string; pathPrefix: string }> = [
  { host: 'www.google.com', pathPrefix: '/maps/embed' },
  { host: 'www.openstreetmap.org', pathPrefix: '/' },
];

export function isMapEmbedUrl(value: string): boolean {
  if (!isSafeUrl(value, false)) return false;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return MAP_EMBED_ALLOW_LIST.some(({ host, pathPrefix }) => url.hostname === host && url.pathname.startsWith(pathPrefix));
}

/** A12: `site_settings.map_embed_url` — a safeUrl() that is also an allow-listed https map embed. */
export function mapEmbedUrl() {
  return z
    .string()
    .trim()
    .max(500)
    .refine(isMapEmbedUrl, { message: 'must be an https Google Maps embed (www.google.com/maps/embed…) or OpenStreetMap (www.openstreetmap.org) URL' });
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
