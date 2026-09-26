import { Controller } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { CrudController } from '../common/crud/crud.factory.js';
import { Area } from '../auth/role-matrix.js';
import { Page } from '../database/entities/page.entity.js';
import { PageSection } from '../database/entities/page-section.entity.js';
import { createPageSchema, updatePageSchema } from './dto/page.dto.js';

/**
 * B10 (safeer-backend-fr-review.md): each listed page carries
 * `sectionsCount` (`updatedAt` is a plain entity column). One grouped count
 * for exactly the page ids being returned.
 */
async function withSectionsCount(pages: Page[], dataSource: DataSource): Promise<Page[]> {
  const counts = await dataSource
    .getRepository(PageSection)
    .createQueryBuilder('s')
    .select('s.pageId', 'pageId')
    .addSelect('COUNT(*)', 'count')
    .where('s.pageId IN (:...ids)', { ids: pages.map((p) => p.id) })
    .groupBy('s.pageId')
    .getRawMany<{ pageId: string; count: string }>();
  const byPageId = new Map(counts.map((c) => [String(c.pageId), Number(c.count)]));
  return pages.map((p) => Object.assign(p, { sectionsCount: byPageId.get(p.id) ?? 0 }));
}

/**
 * No `sortOrder` column on `pages` (a flat, slug-keyed list, not a
 * reorderable one), so `sortable` is intentionally omitted.
 */
@Controller('admin/pages')
@Area('content')
export class AdminPagesController extends CrudController<Page>({
  path: 'admin/pages',
  deleteArea: 'content',
  entity: Page,
  createDto: createPageSchema,
  updateDto: updatePageSchema,
  publishable: true,
  searchable: ['slug', 'titleAr', 'titleEn'],
  extraPurgeTags: ['pages', 'home'],
  label: (p) => p.titleAr,
  listEnrich: withSectionsCount,
}) {}
