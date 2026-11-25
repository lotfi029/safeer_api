import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { NewsCategory } from '../database/entities/news-category.entity.js';
import { createNewsCategorySchema, updateNewsCategorySchema } from './dto/news-category.dto.js';

@Controller('admin/news-categories')
export class AdminNewsCategoriesController extends CrudController<NewsCategory>({
  path: 'admin/news-categories',
  module: 'news',
  entity: NewsCategory,
  createDto: createNewsCategorySchema,
  updateDto: updateNewsCategorySchema,
  sortable: true,
  searchable: ['slug', 'nameAr', 'nameEn'],
  extraPurgeTags: ['news', 'home'],
  label: (c) => c.nameAr,
}) {}
