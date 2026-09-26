import { Controller, Delete, Get, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { Area } from '../auth/role-matrix.js';
import { asString } from '../common/query/list-params.js';
import type { RequestContext } from '../common/request-context.js';
import { CacheService } from './cache.service.js';

/**
 * FR-G-12: cache stats and manual purge from the dashboard, no restart
 * needed. `CacheService.stats()`/`clear()`/`purgeTag()` were all written
 * for exactly this (B2) and were dead code until now — everything else in
 * the CRUD kernel already calls `purgeTag()` on write, this is the one
 * caller that lets a human trigger it directly. Admin-only, like every
 * other settings/operational surface (11-architecture.md §3).
 */
@Controller('admin/cache')
@Area('settings')
@ApiCookieAuth()
export class CacheController {
  constructor(private readonly cache: CacheService) {}

  @Get('stats')
  stats() {
    return this.cache.stats();
  }

  @ApiQuery({ name: 'tag', required: false, type: String })
  @Delete()
  clear(@Query('tag') tagRaw: unknown, @Req() req: RequestContext) {
    // 30-backend-finishing-prompt.md §2.5 (task 5): `@Query('tag') tag:
    // string | undefined` is a compile-time-only assertion — Nest still
    // reads it straight off `req.query.tag`, so `?tag=a&tag=b` arrives as
    // `['a', 'b']` (querystring.parse). Branch on whether a `tag` key was
    // present at all (`tagRaw !== undefined`), not on the coerced string —
    // an array is truthy too, so branching on `asString(tagRaw)` directly
    // would make a malformed repeated key fall through to the *full clear*
    // below, which is worse than the original bug: an admin who asked to
    // purge one named tag would wipe the entire cache instead. `asString`
    // only decides what gets passed to `purgeTag` (never an array), so a
    // malformed value still purges nothing — correctly, not by luck.
    if (tagRaw !== undefined) {
      const tag = asString(tagRaw);
      const purged = tag ? this.cache.purgeTag(tag) : 0;
      req.auditContext = {
        action: 'delete',
        entityType: 'cache',
        entityLabel: `Purged tag "${tag ?? String(tagRaw)}" (${purged} entries)`,
      };
      return { purged, tag: tag ?? null };
    }

    const before = this.cache.stats();
    this.cache.clear();
    req.auditContext = {
      action: 'delete',
      entityType: 'cache',
      entityLabel: `Cleared whole cache (${before.entries} entries)`,
    };
    return { purged: before.entries, tag: null };
  }
}
