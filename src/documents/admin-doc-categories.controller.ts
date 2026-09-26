import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { DocCategory } from '../database/entities/doc-category.entity.js';
import { createDocCategorySchema, updateDocCategorySchema } from './dto/doc-category.dto.js';

@Controller('admin/doc-categories')
@Roles('admin', 'editor')
export class AdminDocCategoriesController extends CrudController<DocCategory>({
  path: 'admin/doc-categories',
  deleteRoles: ['admin', 'editor'],
  entity: DocCategory,
  createDto: createDocCategorySchema,
  updateDto: updateDocCategorySchema,
  sortable: true,
  searchable: ['slug', 'nameAr', 'nameEn'],
  extraPurgeTags: ['documents', 'home'],
  label: (c) => c.nameAr,
}) {}
