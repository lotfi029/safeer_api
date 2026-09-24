import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkAreaItem } from '../database/entities/work-area-item.entity.js';
import { createWorkAreaItemSchema, updateWorkAreaItemSchema } from './dto/work-area.dto.js';

/** `?workAreaId=` filters for free via the kernel's automatic exact-match query filter. */
@Controller('admin/work-area-items')
@Roles('admin', 'editor')
export class AdminWorkAreaItemsController extends CrudController<WorkAreaItem>({
  path: 'admin/work-area-items',
  entity: WorkAreaItem,
  createDto: createWorkAreaItemSchema,
  updateDto: updateWorkAreaItemSchema,
  sortable: true,
  searchable: ['textAr', 'textEn'],
  extraPurgeTags: ['work_areas', 'home'],
  label: (i) => i.textAr,
}) {}
