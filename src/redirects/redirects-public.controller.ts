import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { CacheService } from '../cache/cache.service.js';
import { declarePurger } from '../cache/cache-tag-registry.js';
import { readString } from '../common/query/list-params.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { Redirect } from '../database/entities/redirect.entity.js';

/**
 * FR-G-08/4.3: the `redirects` table and the automatic redirect-on-slug-
 * change (`crud.factory.ts`'s `saveWithRedirect`) both already existed, but
 * nothing public ever read them and `redirect.hits` was never incremented
 * anywhere. The frontend compensated with a hardcoded table in `server.ts`.
 *
 * A public endpoint, not an Nginx `map`: `saveWithRedirect` writes redirect
 * rows *at runtime*, on every slug edit, in the same transaction as the
 * save — a generated Nginx map would need a regeneration step plus a reload
 * on every one of those edits, and would be stale in between. That gap is
 * exactly the class of bug Task 1 exists to close for the cache, so
 * introducing the same gap here for redirects would be a step backward.
 * This route costs one query per cache TTL instead.
 */
@Controller('redirects')
@SkipThrottle()
export class RedirectsPublicController {
  constructor(
    @InjectRepository(Redirect) private readonly repo: Repository<Redirect>,
    private readonly cache: CacheService,
  ) {
    declarePurger('redirects');
  }

  @ApiQuery({ name: 'path', required: true, type: String })
  @Public()
  @Get('resolve')
  @UseInterceptors(CacheInterceptor)
  @CacheTags('redirects')
  @CacheKeyParams('path')
  async resolve(@Query() query: Record<string, unknown>): Promise<{ toPath: string; statusCode: number }> {
    const path = readString(query, 'path');
    if (!path) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'A "path" query parameter is required');
    }

    const row = await this.repo.findOne({ where: { fromPath: path } });
    if (!row) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'No redirect is registered for this path');
    }

    // Fire-and-forget, same shape as media.service.ts's
    // incrementDownloadCount — a failed counter write must never fail the
    // redirect itself. Known undercount on a cache hit: CacheInterceptor
    // returns the cached body without ever invoking this handler, so a
    // repeatedly-hit redirect's true visit count is higher than `hits`
    // reports. Acceptable for what this counter is for (surfacing which
    // legacy links still get used at all, not precise analytics) — cf.
    // FR-G-08's requirement, which only asks that the redirect works.
    void this.repo.increment({ id: row.id }, 'hits', 1).catch(() => {
      // Best-effort; the redirect response above has already been decided.
    });

    return { toPath: row.toPath, statusCode: row.statusCode };
  }
}
