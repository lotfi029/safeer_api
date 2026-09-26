import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Area } from '../auth/role-matrix.js';
import { Partner } from '../database/entities/partner.entity.js';
import { createPartnerSchema, updatePartnerSchema } from './dto/partner.dto.js';

@Controller('admin/partners')
@Area('content')
export class AdminPartnersController extends CrudController<Partner>({
  path: 'admin/partners',
  deleteArea: 'content',
  entity: Partner,
  createDto: createPartnerSchema,
  updateDto: updatePartnerSchema,
  publishable: true,
  sortable: true,
  searchable: ['nameAr', 'nameEn'],
  extraPurgeTags: ['partners', 'home'],
  label: (p) => p.nameAr,
}) {}
