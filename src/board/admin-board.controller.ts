import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { BoardMember } from '../database/entities/board-member.entity.js';
import { createBoardMemberSchema, updateBoardMemberSchema } from './dto/board-member.dto.js';

@Controller('admin/board')
@Roles('admin', 'editor')
export class AdminBoardController extends CrudController<BoardMember>({
  path: 'admin/board',
  deleteRoles: ['admin', 'editor'],
  entity: BoardMember,
  createDto: createBoardMemberSchema,
  updateDto: updateBoardMemberSchema,
  publishable: true,
  sortable: true,
  searchable: ['nameAr', 'nameEn', 'roleAr', 'roleEn'],
  extraPurgeTags: ['board_members', 'home'],
  label: (m) => m.nameAr,
}) {}
