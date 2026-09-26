import { Controller, Get, Inject, Param, Query, Req, UseInterceptors } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { verifyPreviewToken } from '../auth/preview-token.util.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import type { RequestContext } from '../common/request-context.js';
import { MarkdownService } from '../common/markdown/markdown.service.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { escapeLikeValue, readPageLimit, readString } from '../common/query/list-params.js';
import { Post } from '../database/entities/post.entity.js';
import { NewsCategory } from '../database/entities/news-category.entity.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { toPublicPostSummary, toPublicPostDetail, toPublicNewsCategory, type PublicPostSummary, type PublicPostDetail, type PublicNewsCategory } from './public-post.js';
import type { PagedResult } from '../common/crud/crud.factory.js';

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 48;
const RELATED_LIMIT = 3;
const WORDS_PER_MINUTE = 200;

function estimateReadMinutes(text: string | null | undefined): number {
  if (!text) return 1;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
}

/**
 * Public read side of `admin/news` (table `posts`) plus `admin/news-categories`
 * (table `news_categories`) — same "public name differs from the table"
 * split as african_api's news.controller.ts/posts.controller.ts.
 */
@Controller()
@SkipThrottle()
export class NewsController {
  constructor(
    @InjectRepository(Post) private readonly repo: Repository<Post>,
    @InjectRepository(NewsCategory) private readonly categoryRepo: Repository<NewsCategory>,
    private readonly markdown: MarkdownService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @ApiQuery({ name: 'page', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: String })
  @ApiQuery({ name: 'category', required: false, type: String, description: 'A news_categories.slug' })
  @ApiQuery({ name: 'q', required: false, type: String })
  @Public()
  @Get('news')
  @UseInterceptors(CacheInterceptor)
  @CacheTags('news')
  @CacheKeyParams('page', 'limit', 'category', 'q')
  async list(@Query() query: Record<string, unknown>, @Req() req: RequestContext): Promise<PagedResult<PublicPostSummary>> {
    const { page, limit, offset, beyondMaxOffset } = readPageLimit(query, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });
    const categorySlug = readString(query, 'category');
    const q = readString(query, 'q');

    const qb = this.repo
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.category', 'c')
      .leftJoinAndSelect('p.coverAsset', 'cover')
      .where('p.isPublished = true');

    if (categorySlug) {
      qb.andWhere('c.slug = :categorySlug', { categorySlug });
    }
    if (q) {
      // B13 (safeer-backend-fr-review.md): escape LIKE's own '%'/'_' wildcards in the search term itself.
      const escaped = escapeLikeValue(q);
      qb.andWhere(
        "(p.titleAr LIKE :q ESCAPE '\\\\' OR p.titleEn LIKE :q ESCAPE '\\\\' OR p.excerptAr LIKE :q ESCAPE '\\\\' OR p.excerptEn LIKE :q ESCAPE '\\\\')",
        { q: `%${escaped}%` },
      );
      // A distinct search term is a cache miss every time regardless — not worth spending eviction budget on.
      req.skipCacheWrite = true;
    }
    qb.orderBy('p.publishedOn', 'DESC').addOrderBy('p.id', 'DESC');

    if (beyondMaxOffset) {
      req.skipCacheWrite = true;
      const total = await qb.getCount();
      return { data: [], total, page, limit };
    }

    qb.skip(offset).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data: data.map(toPublicPostSummary), total, page, limit };
  }

  @Public()
  @Get('news/featured')
  @UseInterceptors(CacheInterceptor)
  @CacheTags('news')
  @CacheKeyParams()
  async featured(): Promise<PublicPostSummary | null> {
    const post = await this.repo.findOne({
      where: { isPublished: true, isFeatured: true },
      order: { publishedOn: 'DESC' },
      relations: { category: true, coverAsset: true },
    });
    return post ? toPublicPostSummary(post) : null;
  }

  @Public()
  @Get('news-categories')
  @UseInterceptors(CacheInterceptor)
  @CacheTags('news')
  @CacheKeyParams()
  async categories(): Promise<PublicNewsCategory[]> {
    const categories = await this.categoryRepo.find({ order: { sortOrder: 'ASC' } });
    return categories.map(toPublicNewsCategory);
  }

  @ApiQuery({ name: 'preview', required: false, type: String, description: 'A token from GET /admin/preview-token, lets this show an unpublished row.' })
  @Public()
  @Get('news/:slug')
  @UseInterceptors(CacheInterceptor)
  @CacheTags('news')
  // `preview` bypasses the cache entirely (see cache.interceptor.ts) — this
  // route's cache key varies on nothing but the path (the slug).
  @CacheKeyParams()
  async bySlug(@Param('slug') slug: string, @Query() query: Record<string, unknown>): Promise<PublicPostDetail> {
    const post = await this.repo.findOne({ where: { slug }, relations: { category: true, coverAsset: true } });
    if (!post || !this.isVisible(post, query)) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');

    const readMinutes = estimateReadMinutes(post.bodyEn && post.bodyEn.trim() ? post.bodyEn : post.bodyAr);

    // Fetches one extra so excluding the current post (below) still leaves
    // up to RELATED_LIMIT — `find()` has no "not equal" operator worth
    // reaching for `Not()` over here for a single extra row.
    const related = post.categoryId
      ? await this.repo.find({
          where: { categoryId: post.categoryId, isPublished: true },
          order: { publishedOn: 'DESC' },
          take: RELATED_LIMIT + 1,
          relations: { category: true, coverAsset: true },
        })
      : [];
    const relatedFiltered = related.filter((r) => r.id !== post.id).slice(0, RELATED_LIMIT);

    // D-08: Markdown is rendered and sanitised on read, never stored as HTML.
    post.bodyAr = this.markdown.render(post.bodyAr);
    post.bodyEn = post.bodyEn ? this.markdown.render(post.bodyEn) : null;

    return toPublicPostDetail(post, readMinutes, relatedFiltered);
  }

  private isVisible(post: Post, query: Record<string, unknown>): boolean {
    if (post.isPublished) return true;
    const token = readString(query, 'preview');
    return !!token && verifyPreviewToken(this.env.APP_ENCRYPTION_KEY, 'posts', post.id, token);
  }
}
