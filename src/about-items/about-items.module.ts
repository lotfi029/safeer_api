import { Controller, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { CrudController } from '../common/crud/crud.factory.js';
import { Area } from '../auth/role-matrix.js';
import { AboutItem } from '../database/entities/about-item.entity.js';
import { createAboutItemSchema, updateAboutItemSchema } from './dto/about-item.dto.js';
import { AboutItemsController } from './about-items.controller.js';
import { MarkdownModule } from '../common/markdown/markdown.module.js';

/** `?kind=vision|mission|goal|care_pillar|scholarship_step|requirement` filters for free via the kernel's automatic column filter. */
@Controller('admin/about-items')
@Area('content')
class AdminAboutItemsController extends CrudController<AboutItem>({
  path: 'admin/about-items',
  deleteArea: 'content',
  entity: AboutItem,
  createDto: createAboutItemSchema,
  updateDto: updateAboutItemSchema,
  publishable: true,
  sortable: true,
  searchable: ['titleAr', 'titleEn'],
  extraPurgeTags: ['home'], // plus its own `about_items` tag (GET about-items)
  label: (a) => a.titleAr,
}) {}

/** Public read side: GET about-items (B18) and GET /home's goals/pillars. */
@Module({
  imports: [TypeOrmModule.forFeature([AboutItem]), CacheModule, MarkdownModule],
  controllers: [AboutItemsController, AdminAboutItemsController],
})
export class AboutItemsModule {}
