import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Area } from '../auth/role-matrix.js';
import { BoardMember } from '../database/entities/board-member.entity.js';
import { createBoardMemberSchema, updateBoardMemberSchema } from './dto/board-member.dto.js';

@Controller('admin/board')
@Area('content')
export class AdminBoardController extends CrudController<BoardMember>({
  path: 'admin/board',
  deleteArea: 'content',
  entity: BoardMember,
  createDto: createBoardMemberSchema,
  updateDto: updateBoardMemberSchema,
  publishable: true,
  sortable: true,
  searchable: ['nameAr', 'nameEn', 'roleAr', 'roleEn'],
  extraPurgeTags: ['board_members', 'home'],
  label: (m) => m.nameAr,
}) {}
