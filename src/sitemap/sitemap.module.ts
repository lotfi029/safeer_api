import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { Page } from '../database/entities/page.entity.js';
import { Post } from '../database/entities/post.entity.js';
import { NewsCategory } from '../database/entities/news-category.entity.js';
import { SitemapController } from './sitemap.controller.js';

/** B15 (safeer-backend-fr-review.md) — see sitemap.controller.ts. */
@Module({
  imports: [TypeOrmModule.forFeature([Page, Post, NewsCategory]), CacheModule],
  controllers: [SitemapController],
})
export class SitemapModule {}
