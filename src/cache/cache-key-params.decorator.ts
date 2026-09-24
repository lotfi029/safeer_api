import { SetMetadata } from '@nestjs/common';

export const CACHE_KEY_PARAMS_KEY = 'cache:key-params';

/**
 * Declares which query params a cached public GET route's response
 * actually varies on, e.g. `@CacheKeyParams('page', 'limit')` or
 * `@CacheKeyParams()` for none — see cache.interceptor.ts's
 * `buildCacheKey()`, which reads this instead of a single fixed allowlist
 * shared by every cached route.
 *
 * Mandatory alongside `@CacheTags` — `cache-tag-assertion.ts` fails the
 * boot if a `@CacheTags` handler has no `@CacheKeyParams` at all, the same
 * fail-closed reasoning as the tag/purger check it sits next to. Without
 * that check, a handler that reads a query param but forgets this
 * decorator would default to *no* key dimension and silently serve one
 * caller's response to another — the exact class of bug this decorator
 * exists to prevent, just moved one step earlier (a missed declaration
 * rather than a wrong one).
 */
export const CacheKeyParams = (...keys: string[]) => SetMetadata(CACHE_KEY_PARAMS_KEY, keys);
