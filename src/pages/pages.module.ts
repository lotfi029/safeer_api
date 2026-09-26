import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { Page } from '../database/entities/page.entity.js';
import { PageSection } from '../database/entities/page-section.entity.js';
import { PagesController } from './pages.controller.js';
import { AdminPagesController } from './admin-pages.controller.js';
import { AdminPageSectionsController } from './admin-page-sections.controller.js';
import { MarkdownModule } from '../common/markdown/markdown.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([Page, PageSection]), CacheModule, MarkdownModule],
  controllers: [PagesController, AdminPagesController, AdminPageSectionsController],
})
export class PagesModule {}
