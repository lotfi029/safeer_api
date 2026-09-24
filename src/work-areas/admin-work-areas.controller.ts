import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkArea } from '../database/entities/work-area.entity.js';
import { createWorkAreaSchema, updateWorkAreaSchema } from './dto/work-area.dto.js';

@Controller('admin/work-areas')
@Roles('admin', 'editor')
export class AdminWorkAreasController extends CrudController<WorkArea>({
  path: 'admin/work-areas',
  entity: WorkArea,
  createDto: createWorkAreaSchema,
  updateDto: updateWorkAreaSchema,
  publishable: true,
  sortable: true,
  searchable: ['titleAr', 'titleEn'],
  extraPurgeTags: ['work_areas', 'home'],
  label: (a) => a.titleAr,
}) {}
