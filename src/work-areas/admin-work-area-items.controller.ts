import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Area } from '../auth/role-matrix.js';
import { WorkAreaItem } from '../database/entities/work-area-item.entity.js';
import { createWorkAreaItemSchema, updateWorkAreaItemSchema } from './dto/work-area.dto.js';

/** `?workAreaId=` filters for free via the kernel's automatic exact-match query filter. */
@Controller('admin/work-area-items')
@Area('content')
export class AdminWorkAreaItemsController extends CrudController<WorkAreaItem>({
  path: 'admin/work-area-items',
  deleteArea: 'content',
  entity: WorkAreaItem,
  createDto: createWorkAreaItemSchema,
  updateDto: updateWorkAreaItemSchema,
  sortable: true,
  // B11 (safeer-backend-fr-review.md): adds PATCH /:id/publish, same as the parent work-areas collection.
  publishable: true,
  searchable: ['textAr', 'textEn'],
  extraPurgeTags: ['work_areas', 'home'],
  label: (i) => i.textAr,
}) {}
