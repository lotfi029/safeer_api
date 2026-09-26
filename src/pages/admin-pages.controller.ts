import { Controller, Get, Query } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CrudController, type PagedResult } from '../common/crud/crud.factory.js';
import { CacheService } from '../cache/cache.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Page } from '../database/entities/page.entity.js';
import { PageSection } from '../database/entities/page-section.entity.js';
import { createPageSchema, updatePageSchema } from './dto/page.dto.js';

const BaseAdminPagesController = CrudController<Page>({
  path: 'admin/pages',
  deleteRoles: ['admin', 'editor'],
  entity: Page,
  createDto: createPageSchema,
  updateDto: updatePageSchema,
  publishable: true,
  searchable: ['slug', 'titleAr', 'titleEn'],
  extraPurgeTags: ['pages', 'home'],
  label: (p) => p.titleAr,
});

/**
 * No `sortOrder` column on `pages` (it's a flat, slug-keyed list, not a
 * reorderable one) — `sortable` is intentionally omitted.
 *
 * B10 (safeer-backend-fr-review.md): `GET admin/pages` also returns each
 * page's `sectionsCount` (`updatedAt` was already there — a plain entity
 * column `list()` never stripped). This TypeORM version has no
 * `loadRelationCountAndMap` (the review's own suggested API — checked
 * against `node_modules/typeorm`, it doesn't exist here), so this overrides
 * `list()` with the kernel's own paged result plus one grouped count query
 * for exactly the page ids on that page. C4/B0-4 (crud.factory.ts):
 * overriding `list()` replaces the generated method's function object, so
 * its `@Get()` has to be re-applied here.
 */
@Controller('admin/pages')
@Roles('admin', 'editor')
export class AdminPagesController extends BaseAdminPagesController {
  constructor(
    @InjectRepository(Page) pageRepo: Repository<Page>,
    cache: CacheService,
    @InjectDataSource() dataSource: DataSource,
    @InjectRepository(PageSection) private readonly sectionRepo: Repository<PageSection>,
  ) {
    super(pageRepo, cache, dataSource);
  }

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<PagedResult<Page & { sectionsCount: number }>> {
    const result = await super.list(query);
    if (result.data.length === 0) {
      return { ...result, data: [] };
    }

    const counts = await this.sectionRepo
      .createQueryBuilder('s')
      .select('s.pageId', 'pageId')
      .addSelect('COUNT(*)', 'count')
      .where('s.pageId IN (:...ids)', { ids: result.data.map((p) => p.id) })
      .groupBy('s.pageId')
      .getRawMany<{ pageId: string; count: string }>();
    const byPageId = new Map(counts.map((c) => [c.pageId, Number(c.count)]));

    return {
      ...result,
      data: result.data.map((p) => ({ ...p, sectionsCount: byPageId.get(p.id) ?? 0 })),
    };
  }
}
