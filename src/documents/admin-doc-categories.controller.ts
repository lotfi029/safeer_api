import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Area } from '../auth/role-matrix.js';
import { DocCategory } from '../database/entities/doc-category.entity.js';
import { createDocCategorySchema, updateDocCategorySchema } from './dto/doc-category.dto.js';

@Controller('admin/doc-categories')
@Area('content')
export class AdminDocCategoriesController extends CrudController<DocCategory>({
  path: 'admin/doc-categories',
  deleteArea: 'content',
  entity: DocCategory,
  createDto: createDocCategorySchema,
  updateDto: updateDocCategorySchema,
  sortable: true,
  searchable: ['slug', 'nameAr', 'nameEn'],
  extraPurgeTags: ['documents', 'home'],
  label: (c) => c.nameAr,
}) {}
