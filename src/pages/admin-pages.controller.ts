import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Page } from '../database/entities/page.entity.js';
import { createPageSchema, updatePageSchema } from './dto/page.dto.js';

/** No `sortOrder` column on `pages` (it's a flat, slug-keyed list, not a reorderable one) — `sortable` is intentionally omitted. */
@Controller('admin/pages')
@Roles('admin', 'editor')
export class AdminPagesController extends CrudController<Page>({
  path: 'admin/pages',
  deleteRoles: ['admin', 'editor'],
  entity: Page,
  createDto: createPageSchema,
  updateDto: updatePageSchema,
  publishable: true,
  searchable: ['slug', 'titleAr', 'titleEn'],
  extraPurgeTags: ['pages', 'home'],
  label: (p) => p.titleAr,
}) {}
