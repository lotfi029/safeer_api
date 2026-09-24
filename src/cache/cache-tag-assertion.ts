import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { CACHE_TAGS_KEY } from './cache-tags.decorator.js';
import { CACHE_KEY_PARAMS_KEY } from './cache-key-params.decorator.js';
import { declaredPurgers } from './cache-tag-registry.js';

/**
 * Boot-time check that every tag a cached route is *served* under is a tag some
 * write path actually *purges* — see cache-tag-registry.ts for the defect class
 * this closes (a library edit was invisible on the public site for a full TTL
 * because `@CacheTags('library')` had no purger).
 *
 * Fail-closed, deliberately: a served tag with no purger means stale content is
 * served to the public with no way to invalidate it short of a restart, and
 * unpublishing is a content-safety action. Refusing to boot is the correct
 * response, and it is the only thing that makes this category of mistake
 * impossible to ship rather than merely documented.
 *
 * The reverse direction — a purger with no server — is logged, not thrown: the
 * purger set legitimately contains all 14 collections' table names (the
 * kernel's `entityType`), which nothing serves by design.
 *
 * 30-backend-finishing-prompt.md §2.3 (task 3): also fails the boot if any
 * `@CacheTags` handler has no `@CacheKeyParams` declared at all.
 * `cache.interceptor.ts`'s `buildCacheKey` defaults to no query dimension
 * when the decorator is absent — correct for a route that genuinely reads
 * none, but silently wrong for one that reads a param and its author simply
 * forgot the decorator: that handler would still work today, then start
 * serving one caller's response to another the moment it starts reading a
 * query param without also adding this. An explicit `@CacheKeyParams()` (no
 * params) is how a route says "I checked, there is nothing to key on" —
 * `reflector.get` returns `[]` for that (a defined, empty array) and
 * `undefined` only when the decorator was never applied, which is what
 * distinguishes "declared none" from "forgot to declare".
 */
@Injectable()
export class CacheTagAssertion implements OnApplicationBootstrap {
  private readonly logger = new Logger(CacheTagAssertion.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const { served, undeclaredKeyParams } = this.collectServedTags();
    const purged = declaredPurgers();

    if (undeclaredKeyParams.length > 0) {
      throw new Error(
        `Cached route handler(s) with @CacheTags but no @CacheKeyParams: ${undeclaredKeyParams.sort().join(', ')}. ` +
          'The cache key defaults to no query dimension when this is missing — fine for a ' +
          'route that reads no query params, but silently wrong for one that does: it would ' +
          "serve one caller's response back to a different caller with different query " +
          "input. Add @CacheKeyParams('the', 'params', 'this', 'route', 'reads'), or " +
          '@CacheKeyParams() with none if it genuinely reads none. See ' +
          'src/cache/cache-key-params.decorator.ts.',
      );
    }

    const orphans = [...served].filter((tag) => !purged.has(tag)).sort();
    if (orphans.length > 0) {
      throw new Error(
        `Cache tag(s) served by a route but purged by nothing: ${orphans.join(', ')}. ` +
          'A write to the owning collection would leave these responses stale for a full ' +
          'CACHE_TTL_SECONDS (and up to 10x that behind a CDN). Add the tag to that ' +
          "collection's extraPurgeTags, or declarePurger() it from whichever write path " +
          'invalidates it. See src/cache/cache-tag-registry.ts.',
      );
    }

    const unserved = [...purged].filter((tag) => !served.has(tag)).sort();
    if (unserved.length > 0) {
      this.logger.debug(`Cache tags purged but served by no route (expected — table names): ${unserved.join(', ')}`);
    }
    this.logger.log(`Cache tag check passed: ${[...served].sort().join(', ')}`);
  }

  /**
   * Every `@CacheTags(...)` value declared on any controller handler in the
   * app, plus (`Controller.method` form) any such handler missing
   * `@CacheKeyParams`.
   */
  private collectServedTags(): { served: Set<string>; undeclaredKeyParams: string[] } {
    const tags = new Set<string>();
    const undeclaredKeyParams: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance) continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = (instance as Record<string, unknown>)[methodName];
        if (typeof handler !== 'function') continue;
        const handlerTags = this.reflector.get<string[]>(CACHE_TAGS_KEY, handler);
        if (!handlerTags) continue;
        for (const tag of handlerTags) tags.add(tag);
        if (this.reflector.get<string[]>(CACHE_KEY_PARAMS_KEY, handler) === undefined) {
          undeclaredKeyParams.push(`${instance.constructor.name}.${methodName}`);
        }
      }
    }
    return { served: tags, undeclaredKeyParams };
  }
}
