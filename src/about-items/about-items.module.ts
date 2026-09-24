import { Controller, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '../cache/cache.module.js';
import { CrudController } from '../common/crud/crud.factory.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AboutItem } from '../database/entities/about-item.entity.js';
import { createAboutItemSchema, updateAboutItemSchema } from './dto/about-item.dto.js';

/** `?kind=vision|mission|goal|care_pillar|scholarship_step|requirement` filters for free via the kernel's automatic column filter. */
@Controller('admin/about-items')
@Roles('admin', 'editor')
class AdminAboutItemsController extends CrudController<AboutItem>({
  path: 'admin/about-items',
  entity: AboutItem,
  createDto: createAboutItemSchema,
  updateDto: updateAboutItemSchema,
  publishable: true,
  sortable: true,
  searchable: ['titleAr', 'titleEn'],
  extraPurgeTags: ['home'],
  label: (a) => a.titleAr,
}) {}

/** No public `GET about-items` route — vision/mission/goals/pillars/steps/requirements surface only through `GET /home`'s aggregate. */
@Module({
  imports: [TypeOrmModule.forFeature([AboutItem]), CacheModule],
  controllers: [AdminAboutItemsController],
})
export class AboutItemsModule {}
