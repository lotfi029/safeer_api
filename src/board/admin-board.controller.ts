import { Body, Controller, Param, Patch, Post, Req } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Area } from '../auth/role-matrix.js';
import { BoardMember } from '../database/entities/board-member.entity.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { RequestContext } from '../common/request-context.js';
import { CreateBoardMemberDto, UpdateBoardMemberDto, createBoardMemberSchema, updateBoardMemberSchema } from './dto/board-member.dto.js';

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
  // 023: `org_chart` — GET /org-chart shows members' names under their position.
  extraPurgeTags: ['board_members', 'home', 'org_chart'],
  label: (m) => m.nameAr,
}) {
  // Overriding drops the kernel's route decorators — re-applied here (crud.factory.ts).
  @Post()
  override async create(@Body() dto: CreateBoardMemberDto, @Req() req: RequestContext): Promise<BoardMember> {
    await this.validatePosition(dto.orgPositionId);
    return super.create(dto, req);
  }

  @Patch(':id')
  override async update(@Param('id') id: string, @Body() dto: UpdateBoardMemberDto, @Req() req: RequestContext): Promise<BoardMember> {
    await this.validatePosition(dto.orgPositionId);
    return super.update(id, dto, req);
  }

  /** 023: a bad org-chart position is a 400 naming the field, not a foreign-key 500. */
  private async validatePosition(orgPositionId: string | null | undefined): Promise<void> {
    if (!orgPositionId) return;
    const rows: unknown[] = await this.dataSource.query('SELECT 1 FROM org_positions WHERE id = ? LIMIT 1', [orgPositionId]);
    if (rows.length === 0) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'The org-chart position does not exist', { field: 'orgPositionId' });
    }
  }
}
