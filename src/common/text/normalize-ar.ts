/**
 * Arabic normaliser (13-backend-build-plan.md P5). Used by `search_text` at
 * save time and by search queries at read time — the two must use the
 * identical function or search silently fails. Also used at slug generation
 * so a hamza-only difference collides at generation time rather than in the
 * accent-insensitive unique key (trap 2) — `utf8mb4_unicode_ci` since the
 * MariaDB port, `utf8mb4_0900_ai_ci` before it.
 *
 * Because this runs on BOTH sides — at write time building `search_text`,
 * and at read time on the `?q=` term before it reaches MATCH ... AGAINST —
 * Arabic search is an application-layer guarantee, not a collation-layer
 * one. That is what made the MySQL 8 → MariaDB collation change safe
 * (38-hostinger-shared-deployment-review.md §0).
 */
export const normalizeAr = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '') // tashkeel + tatweel
    .replace(/[أإآ]/g, 'ا') // أإآ → ا
    .replace(/ة/g, 'ه') // ة → ه
    .replace(/ى/g, 'ي') // ى → ي
    .replace(/ؤ/g, 'و') // ؤ → و
    .replace(/ئ/g, 'ي') // ئ → ي
    .replace(/\s+/g, ' ')
    .trim();
