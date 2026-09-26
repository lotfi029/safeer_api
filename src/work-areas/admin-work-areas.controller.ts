import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Area } from '../auth/role-matrix.js';
import { WorkArea } from '../database/entities/work-area.entity.js';
import { createWorkAreaSchema, updateWorkAreaSchema } from './dto/work-area.dto.js';

@Controller('admin/work-areas')
@Area('content')
export class AdminWorkAreasController extends CrudController<WorkArea>({
  path: 'admin/work-areas',
  deleteArea: 'content',
  entity: WorkArea,
  createDto: createWorkAreaSchema,
  updateDto: updateWorkAreaSchema,
  publishable: true,
  sortable: true,
  searchable: ['titleAr', 'titleEn'],
  extraPurgeTags: ['work_areas', 'home'],
  label: (a) => a.titleAr,
}) {}
