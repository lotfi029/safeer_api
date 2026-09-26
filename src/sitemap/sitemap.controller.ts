import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { Page } from '../database/entities/page.entity.js';
import { Post } from '../database/entities/post.entity.js';
import { NewsCategory } from '../database/entities/news-category.entity.js';

export interface SitemapEntry {
  slug: string;
  updatedAt: Date;
}

export interface SitemapIndex {
  pages: SitemapEntry[];
  posts: SitemapEntry[];
  categories: SitemapEntry[];
}

/**
 * `GET sitemap-index` (B15, safeer-backend-fr-review.md) — every published
 * page and post slug, plus every news category, with their `updatedAt`, so
 * the (Next.js) frontend can build its own `sitemap.xml` and per-locale
 * `hreflang` alternates without scraping every public route itself.
 * `news_categories` has no `is_published` column (every category is public,
 * same as `NewsController.categories()`), so it isn't filtered.
 *
 * Cached under both `pages` and `news` — the same two tags
 * `admin/pages`/`admin/news`/`admin/news-categories` already purge on
 * every write (admin-pages.controller.ts, admin-news*.controller.ts), so
 * this never needs a tag of its own.
 */
@Controller('sitemap-index')
@SkipThrottle()
export class SitemapController {
  constructor(
    @InjectRepository(Page) private readonly pageRepo: Repository<Page>,
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    @InjectRepository(NewsCategory) private readonly categoryRepo: Repository<NewsCategory>,
  ) {}

  @Public()
  @Get()
  @UseInterceptors(CacheInterceptor)
  @CacheTags('pages', 'news')
  @CacheKeyParams()
  async get(): Promise<SitemapIndex> {
    const [pages, posts, categories] = await Promise.all([
      this.pageRepo.find({ where: { isPublished: true }, select: { slug: true, updatedAt: true } }),
      this.postRepo.find({ where: { isPublished: true }, select: { slug: true, updatedAt: true } }),
      this.categoryRepo.find({ select: { slug: true, updatedAt: true } }),
    ]);

    return {
      pages: pages.map((p) => ({ slug: p.slug, updatedAt: p.updatedAt })),
      posts: posts.map((p) => ({ slug: p.slug, updatedAt: p.updatedAt })),
      categories: categories.map((c) => ({ slug: c.slug, updatedAt: c.updatedAt })),
    };
  }
}
