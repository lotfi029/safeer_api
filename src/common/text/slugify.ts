import type { Repository } from 'typeorm';
import { normalizeAr } from './normalize-ar.js';
import { SLUG_MAX, isValidSlug } from '../validation/slug.js';

/**
 * Same algorithm tools/seed-from-prototype.mjs uses for dev-sample slugs
 * (P3) — kept identical so a live create produces the same shape of slug a
 * regenerated seed would. `normalizeAr` only strips diacritics/hamza
 * variants; it does not transliterate to Latin, so an Arabic-only title
 * still falls through to the caller's fallback (trap 2: never derive a slug
 * from raw Arabic).
 */
function slugifyEn(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `title_en` when present, else normalised `title_ar`, else '' (caller supplies the fallback). */
export function slugBase(titleEn: string | null | undefined, titleAr: string | null | undefined): string {
  if (titleEn && titleEn.trim()) return slugifyEn(titleEn);
  if (titleAr && titleAr.trim()) return slugifyEn(normalizeAr(titleAr));
  return '';
}

/**
 * Generates a slug and guarantees it's free by suffixing `-2`, `-3`, … —
 * this is the CREATE-time path (13-backend-build-plan.md P8: "generate from
 * title_en … never change a published slug"), so a collision here is
 * resolved silently rather than surfaced as SLUG_TAKEN; SLUG_TAKEN is for an
 * editor explicitly setting a slug by hand (posts/products/library_items
 * expose it as an optional field on update, not on create).
 */
export async function generateUniqueSlug<E extends { id: string; slug: string }>(
  repo: Repository<E>,
  titleEn: string | null | undefined,
  titleAr: string | null | undefined,
  fallback: string,
  reserved?: ReadonlySet<string>,
): Promise<string> {
  // C14: a generated slug always satisfies the same rules as a hand-set one
  // — trimmed at a word boundary to leave room for a `-N` suffix inside
  // SLUG_MAX, and never a reserved word (→ the fallback instead).
  const full = slugBase(titleEn, titleAr);
  let base = (full.length > SLUG_MAX - 6 ? full.slice(0, SLUG_MAX - 6).replace(/-[^-]*$/, '') : full).replace(/-+$/, '');
  if (!isValidSlug(base, reserved)) base = fallback;
  let candidate = base;
  let i = 2;
  // eslint-disable-next-line no-await-in-loop -- sequential by design: each check depends on the last candidate
  while (await repo.exists({ where: { slug: candidate } as object })) {
    candidate = `${base}-${i++}`;
  }
  return candidate;
}
