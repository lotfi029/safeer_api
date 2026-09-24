/**
 * 26-backend-code-review.md H1/H2 — shared guards for every hand-written
 * list route (the CRUD kernel has its own copy of the same logic at
 * crud.factory.ts's `list()`, which imports these same helpers).
 *
 * H2's stated reproduction (`?q[x]=y` producing `query.q = {x:'y'}` via a
 * `qs`-style query parser) does not reproduce on this app — Express 5.2.1's
 * *default* query parser is `'simple'` (Node's built-in `querystring`), not
 * `qs`, and nothing in `main.ts` overrides it (verified directly: a live
 * `?q[x]=y` request returns a normal 200, and `querystring.parse` confirms
 * bracket notation becomes a flat key, never a nested object). The
 * underlying finding still holds via a different, still-live mechanism:
 * `querystring.parse` turns a *repeated* key into an array
 * (`?q=a&q=b` → `{ q: ['a', 'b'] }`), and a handler that assumes a string
 * (`normalizeAr(query.q)`, an auto-filter's `e.${key} = :${key}`) still
 * breaks the same way on an array as it would on an object. `asString`
 * guards against both shapes identically, so it doesn't matter which one a
 * client actually sends.
 */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Reads one key off a whole-object `@Query() query: Record<string, ...>` and guards its type. */
export function readString(query: Record<string, unknown>, key: string): string | undefined {
  return asString(query[key]);
}

/**
 * H1: `page` was floored at 1 but never capped, and fed `.skip((page - 1) *
 * limit)` directly — `?page=900000000&limit=48` issues
 * `LIMIT 48 OFFSET 43199999952` plus a full COUNT, on a single MySQL
 * instance behind a single Node process (`ecosystem.config.cjs` pins
 * `instances: 1`), from an anonymous, unthrottled request on every
 * `@SkipThrottle()` public list route. Clamping the *page number* would
 * only move the cliff; clamping the computed offset is what actually bounds
 * the query MySQL runs.
 *
 * 30-backend-finishing-prompt.md §2.5 (task 5): this one constant is shared
 * by every hand-written list route (audit/submissions/donations/mail-log/
 * news/library-public/media/governance ×3) and the CRUD kernel, not just
 * the public "library" collections NFR-12 (7.6) documents a ~10,000-item
 * ceiling for. It used to sit at exactly that ceiling, which collided with
 * it rather than sitting clear of it: at `limit=48` (library-public.
 * controller.ts's max), page 210 computes offset 10,032 — past
 * `MAX_OFFSET` even though a 10,000-item collection's genuine last page is
 * only slightly below it, and a caller with `limit=200` (audit/mail-log's
 * max) crosses `MAX_OFFSET` more than a full page earlier still. Raised
 * comfortably clear of `10_000 + 200`, the largest ceiling+limit
 * combination any current caller has, while still nowhere near the
 * pathological offset H1 was about.
 */
const MAX_OFFSET = 20_000;

export interface PageLimitOptions {
  defaultLimit: number;
  maxLimit: number;
}

export interface PageLimitResult {
  page: number;
  limit: number;
  /** Already clamped to MAX_OFFSET — safe to pass straight to `.skip()`/`OFFSET`. */
  offset: number;
  /**
   * True when `(page - 1) * limit` exceeded MAX_OFFSET before clamping.
   * A caller should skip the underlying query entirely and return an empty
   * page rather than silently re-serving whatever the clamped offset lands
   * on (which would otherwise look like a real, if wrong, page of results).
   */
  beyondMaxOffset: boolean;
}

export function readPageLimit(query: Record<string, unknown>, opts: PageLimitOptions): PageLimitResult {
  const pageRaw = asString(query.page);
  const limitRaw = asString(query.limit);
  const page = Math.max(1, Number.parseInt(pageRaw ?? '1', 10) || 1);
  const limit = Math.min(opts.maxLimit, Math.max(1, Number.parseInt(limitRaw ?? String(opts.defaultLimit), 10) || opts.defaultLimit));
  const rawOffset = (page - 1) * limit;
  const beyondMaxOffset = rawOffset > MAX_OFFSET;
  return { page, limit, offset: Math.min(rawOffset, MAX_OFFSET), beyondMaxOffset };
}

/**
 * `%`, `_` and `\` are LIKE metacharacters — unescaped, a `?q=` value could
 * alter the match pattern rather than just its value (an unbounded `%`, or
 * `\` breaking the `ESCAPE '\\'` clause every caller pairs this with).
 * Previously duplicated identically in `crud.factory.ts` (the CRUD kernel's
 * own `?q=` search) and `admin-applications.service.ts` (its hand-written
 * reference/name/email search) — extracted here so both share one
 * definition, the same way `asString`/`readPageLimit` already are.
 */
export function escapeLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
