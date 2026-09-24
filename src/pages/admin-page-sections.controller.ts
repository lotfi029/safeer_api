import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PageSection } from '../database/entities/page-section.entity.js';
import { createPageSectionSchema, updatePageSectionSchema } from './dto/page.dto.js';

/**
 * Flat route, filtered with `?pageId=` — the kernel's automatic exact-match
 * query filter (crud.factory.ts's `list()`) already covers "sections for
 * this page" without a nested route. `isPublished` here is the section
 * editor's "visible" toggle (`PATCH :id/publish`); `sortable` gives the
 * reorder drag-and-drop `POST reorder`.
 */
@Controller('admin/page-sections')
@Roles('admin', 'editor')
export class AdminPageSectionsController extends CrudController<PageSection>({
  path: 'admin/page-sections',
  entity: PageSection,
  createDto: createPageSectionSchema,
  updateDto: updatePageSectionSchema,
  publishable: true,
  sortable: true,
  searchable: ['headingAr', 'headingEn', 'labelAr', 'labelEn'],
  extraPurgeTags: ['pages', 'home'],
  label: (s) => s.sectionKey,
}) {}
