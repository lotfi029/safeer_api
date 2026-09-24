import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { MarkdownModule } from '../common/markdown/markdown.module.js';
import { ConfigModule } from '../config/config.module.js';
import { Post } from '../database/entities/post.entity.js';
import { NewsCategory } from '../database/entities/news-category.entity.js';
import { NewsController } from './news.controller.js';
import { AdminNewsController } from './admin-news.controller.js';
import { AdminNewsCategoriesController } from './admin-news-categories.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Post, NewsCategory]), CacheModule, MarkdownModule, ConfigModule],
  controllers: [NewsController, AdminNewsController, AdminNewsCategoriesController],
})
export class NewsModule {}
