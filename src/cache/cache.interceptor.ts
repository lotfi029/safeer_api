import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { type Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { RequestContext } from '../common/request-context.js';
import { CACHE_TAGS_KEY } from './cache-tags.decorator.js';
import { CACHE_KEY_PARAMS_KEY } from './cache-key-params.decorator.js';
import { PREVIEW_AWARE_KEY } from './preview-aware.decorator.js';
import { CacheService } from './cache.service.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';

/**
 * 30-backend-finishing-prompt.md §2.3 (task 3): this used to be one fixed
 * allowlist (`CACHEABLE_QUERY_KEYS`) shared by every cached route, built
 * from the *union* of every route's params (B1-7's own history: page/limit/
 * itemLang/lang/q for the library, page/limit for news, then `path` for
 * 4.3's `/redirects/resolve`). That made the key too wide for any *other*
 * route: `/home` and `/languages` read no query params at all, but a `path`
 * value now varied their cache key too, so `GET /home?path=<n>` minted a
 * distinct entry per `n` — ~500 of those (CACHE_MAX_ENTRIES' default) evict
 * every real entry the LRU held, on an anonymous, `@SkipThrottle()`d route.
 *
 * `@CacheKeyParams(...)` (read below via the same `Reflector` already used
 * for `CACHE_TAGS_KEY`) makes each route declare only the keys *it* reads,
 * defaulting to none. The two defect classes the old comment recorded
 * still apply to whichever route actually reads the param:
 *
 * 4.1: `itemLang` must be in `/library/:type`'s own key or the filter
 * appears to work until the first cache hit — `?itemLang=ha` and
 * `?itemLang=ar` would collide on the same cache key and the second
 * request would silently serve the first request's (wrong) list.
 *
 * 4.3: `path` must be in `/redirects/resolve`'s own key — without it, every
 * distinct `?path=` collapses onto one cache key and the second lookup for
 * a *different* path would silently be served the first lookup's redirect
 * target.
 *
 * `cache-tag-assertion.ts` fails the boot if any `@CacheTags` handler has
 * no `@CacheKeyParams` declared at all (an explicit `@CacheKeyParams()`
 * counts) — the default-to-none behaviour below is deliberately only ever
 * reached for a route that opted into it, not one that simply forgot.
 */
function cacheKeyParams(reflector: Reflector, context: ExecutionContext): string[] {
  return reflector.get<string[]>(CACHE_KEY_PARAMS_KEY, context.getHandler()) ?? [];
}

/**
 * Applied per-route (via `@UseInterceptors(CacheInterceptor)`) to public GET
 * endpoints only (P9's composite reads). Key is
 * `method + path + declared query + locale`, matching
 * 13-backend-build-plan.md P5 for path/locale, tightened for query (B1-7,
 * then task 3 above), so a write's `purgeTag` (wired into the CRUD kernel,
 * P8) is authoritative without the API needing more than one process
 * (D-10).
 */
@Injectable()
export class CacheInterceptor implements NestInterceptor {
  constructor(
    private readonly cache: CacheService,
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestContext>();
    if (req.method !== 'GET') {
      return next.handle();
    }

    // C24 (was 7.8/FR-G-05's blanket bypass): `?preview=` is never part of
    // the cache key. On a route that doesn't support previews it is simply
    // ignored — `GET /home?preview=x` is served from the cache like any
    // other request, so the parameter is no longer a free way to push every
    // request through to the database. On a @PreviewAware() route the
    // cached copy is skipped (a cached *published* body must not stand in
    // for a preview), and after the handler runs: if it verified the token
    // (`req.previewVerified`), the response is private and never stored; if
    // not, it's the ordinary public response and is cached as usual.
    const previewAware = this.reflector.get<boolean>(PREVIEW_AWARE_KEY, context.getHandler()) === true;
    const previewRequested = previewAware && req.query?.preview !== undefined;

    // 26-backend-code-review.md Task 2 / 28-caching-review.md §3: these
    // headers used to be set here unconditionally, before it was known
    // whether the handler would even succeed. HttpExceptionFilter finishes
    // an error response with .status().type().json(), none of which clears
    // a header set earlier in the pipeline — so a transient 500 (a two-
    // second MySQL blip during a deploy, say) went out stamped "public,
    // max-age=60, stale-while-revalidate=600", and a CDN in front would
    // cache the outage for up to 10x the TTL after the cause had already
    // cleared. Moved into setCacheHeaders(), called only on the paths that
    // are actually known-cacheable: a cache hit, and a successful response
    // inside tap(). A thrown handler now reaches neither.
    // (HttpExceptionFilter additionally sets Cache-Control: no-store on
    // every >=400 response as a second, route-independent backstop.)
    const res = context.switchToHttp().getResponse<Response>();
    const setCacheHeaders = () => {
      res.setHeader('Cache-Control', `public, max-age=${this.env.CACHE_TTL_SECONDS}, stale-while-revalidate=${this.env.CACHE_TTL_SECONDS * 10}`);
      res.setHeader('Vary', 'Accept-Language');
    };

    const keyParams = cacheKeyParams(this.reflector, context);
    const key = this.buildCacheKey(req, keyParams);
    const cached = previewRequested ? undefined : this.cache.get(key);
    if (cached !== undefined) {
      setCacheHeaders();
      return of(cached);
    }

    const tags = this.reflector.get<string[]>(CACHE_TAGS_KEY, context.getHandler()) ?? [];
    // C31: taken before the handler reads anything — see CacheService.versionOf().
    const version = this.cache.versionOf(tags);
    return next.handle().pipe(
      tap((data) => {
        if (req.previewVerified) {
          res.setHeader('Cache-Control', 'private, no-store');
          return;
        }
        setCacheHeaders();
        // 30-backend-finishing-prompt.md §2.3: a handler sets this when the
        // *particular* response isn't worth caching even though the route
        // is — an empty `beyondMaxOffset` page (one anonymous request per
        // absurd page number would otherwise mint one entry each), or a
        // `/library/:type?q=` search (a distinct term is a miss every
        // time regardless, so caching it buys no hits and only spends
        // eviction budget). `q` stays in the key above either way, so a
        // *read* can never serve one searcher's results back to another —
        // this only stops the *write*.
        if (req.skipCacheWrite) return;
        this.cache.set(key, data, tags, version);
      }),
    );
  }

  /**
   * Iterating `keyParams` in the order the route declared them (rather than
   * `Object.keys(req.query)`) makes this naturally order-insensitive:
   * `?a=1&b=2` and `?b=2&a=1` always produce the same key, where the old
   * `JSON.stringify(req.query)` treated them as two distinct entries.
   *
   * 28-caching-review.md §4.1: no `:${req.locale}` suffix. What this stores
   * is the pre-collapse bilingual payload — `LocaleInterceptor` is a global
   * `APP_INTERCEPTOR` (app.module.ts), which Nest runs *outside* this
   * route-scoped interceptor, so it collapses to the visitor's locale on
   * the way out of every response, hit or miss. Safe only as long as no
   * cached handler itself branches on `req.locale` (none does today) — a
   * future one that does must put locale into that route's own
   * `@CacheKeyParams` (there is no longer a shared `lang` slot to piggyback
   * on: task 3a removed the one place that read `?lang=` as anything but
   * the UI locale `LocaleInterceptor` already resolves separately).
   */
  private buildCacheKey(req: RequestContext, keyParams: string[]): string {
    const parts: string[] = [];
    for (const key of keyParams) {
      const value = req.query?.[key];
      if (value !== undefined) parts.push(`${key}=${String(value)}`);
    }
    return `GET:${req.path}:${parts.join('&')}`;
  }
}
