import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Area } from '../auth/role-matrix.js';
import { NewsCategory } from '../database/entities/news-category.entity.js';
import { createNewsCategorySchema, updateNewsCategorySchema } from './dto/news-category.dto.js';

@Controller('admin/news-categories')
@Area('content')
export class AdminNewsCategoriesController extends CrudController<NewsCategory>({
  path: 'admin/news-categories',
  deleteArea: 'content',
  entity: NewsCategory,
  createDto: createNewsCategorySchema,
  updateDto: updateNewsCategorySchema,
  sortable: true,
  searchable: ['slug', 'nameAr', 'nameEn'],
  extraPurgeTags: ['news', 'home'],
  label: (c) => c.nameAr,
}) {}
