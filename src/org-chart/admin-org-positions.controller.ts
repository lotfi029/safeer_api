import { Body, Controller, Delete, Param, Patch, Post, Req } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { CrudController } from '../common/crud/crud.factory.js';
import { CacheService } from '../cache/cache.service.js';
import { Area } from '../auth/role-matrix.js';
import { OrgPosition } from '../database/entities/org-position.entity.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { RequestContext } from '../common/request-context.js';
import { checkParent, ORG_MAX_DEPTH, type TreeGuardError } from './tree-guard.js';
import { CreateOrgPositionDto, UpdateOrgPositionDto, createOrgPositionSchema, updateOrgPositionSchema } from './dto/org-position.dto.js';

const BaseOrgPositionsController = CrudController<OrgPosition>({
  path: 'admin/org-positions',
  deleteArea: 'content',
  entity: OrgPosition,
  createDto: createOrgPositionSchema,
  updateDto: updateOrgPositionSchema,
  publishable: true,
  sortable: true,
  searchable: ['nameAr', 'nameEn'],
  // `org_chart`: GET /org-chart, the only public read of this table.
  extraPurgeTags: ['org_chart'],
  label: (p) => p.nameAr,
});

const GUARD_MESSAGES: Record<TreeGuardError, string> = {
  SELF_PARENT: 'A position cannot report to itself',
  PARENT_NOT_FOUND: 'The parent position does not exist',
  CYCLE: 'A position cannot report to one of its own sub-positions',
  TOO_DEEP: `The chart is limited to ${ORG_MAX_DEPTH} levels`,
};

/**
 * Admin CRUD for the org chart's positions (023), the kernel plus ta3lom's
 * tree rules:
 *
 * 1. `parentId` is checked on create and update (tree-guard.ts) — no
 *    self-parent, no missing parent, no cycle, at most 5 levels — as a 400
 *    naming `parentId`. The check runs inside a transaction that first
 *    locks every position row (`FOR UPDATE`), so two concurrent moves can't
 *    build a cycle between them.
 * 2. a new position, or one moved to another parent, goes to the end of its
 *    siblings unless the request sets `sortOrder`;
 * 3. delete is refused with 409 RESOURCE_IN_USE and the list of what still
 *    points at it (sub-positions, members) — not a bare foreign-key error.
 */
@Controller('admin/org-positions')
@Area('content')
export class AdminOrgPositionsController extends BaseOrgPositionsController {
  constructor(
    @InjectRepository(OrgPosition) repo: Repository<OrgPosition>,
    cache: CacheService,
    @InjectDataSource() dataSource: DataSource,
  ) {
    super(repo, cache, dataSource);
  }

  @Post()
  override async create(@Body() dto: CreateOrgPositionDto, @Req() req: RequestContext): Promise<OrgPosition> {
    const saved = await this.dataSource.transaction(async (manager) => {
      const rows = await lockTree(manager);
      const parentId = dto.parentId ?? null;
      assertParent(rows, null, parentId);
      const draft = manager.create(OrgPosition, { ...dto, parentId } as Partial<OrgPosition>);
      if (dto.sortOrder === undefined) draft.sortOrder = await nextSortOrder(manager, parentId);
      return manager.save(OrgPosition, draft);
    });

    this.purge();
    req.auditContext = { action: 'create', entityType: this.entityType, entityId: saved.id, entityLabel: saved.nameAr, after: saved };
    return saved;
  }

  @Patch(':id')
  override async update(@Param('id') id: string, @Body() dto: UpdateOrgPositionDto, @Req() req: RequestContext): Promise<OrgPosition> {
    const { saved, before } = await this.dataSource.transaction(async (manager) => {
      const rows = await lockTree(manager);
      const current = await manager.findOne(OrgPosition, { where: { id } });
      if (!current) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');
      const before = { ...current };
      const moving = dto.parentId !== undefined && (dto.parentId ?? null) !== current.parentId;
      Object.assign(current, dto);
      if (dto.parentId !== undefined) current.parentId = dto.parentId ?? null;
      if (moving) {
        assertParent(rows, id, current.parentId);
        if (dto.sortOrder === undefined) current.sortOrder = await nextSortOrder(manager, current.parentId);
      }
      const saved = await manager.save(OrgPosition, current);
      return { saved, before };
    });

    this.purge();
    req.auditContext = {
      action: before.isPublished === saved.isPublished ? 'update' : saved.isPublished ? 'publish' : 'unpublish',
      entityType: this.entityType,
      entityId: id,
      entityLabel: saved.nameAr,
      before,
      after: saved,
    };
    return saved;
  }

  // Overriding `remove` drops the kernel's decorators — both re-applied here
  // (crud.factory.ts, B0-4).
  @Area('content')
  @Delete(':id')
  override async remove(@Param('id') id: string, @Req() req: RequestContext): Promise<{ deleted: true }> {
    const snapshot = await this.dataSource.transaction(async (manager) => {
      const current = await manager.findOne(OrgPosition, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!current) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');
      const usages = await manager.query<{ entity: string; id: string; label: string }[]>(
        `SELECT 'org_positions' AS entity, id, name_ar AS label FROM org_positions WHERE parent_id = ?
         UNION ALL SELECT 'board_members', id, name_ar FROM board_members WHERE org_position_id = ?`,
        [id, id],
      );
      if (usages.length > 0) {
        throw new ProblemException(409, ErrorCode.RESOURCE_IN_USE, `"${current.nameAr}" still has sub-positions or members`, { usages });
      }
      const snapshot = { ...current };
      await manager.remove(OrgPosition, current);
      return snapshot;
    });

    this.purge();
    req.auditContext = { action: 'delete', entityType: this.entityType, entityId: id, entityLabel: snapshot.nameAr, before: snapshot };
    return { deleted: true };
  }
}

/**
 * Locks every position row and returns the (id, parent) pairs. The table is
 * a few dozen rows at most; locking all of it serialises tree writes, which
 * is what keeps two concurrent moves from forming a cycle together.
 */
async function lockTree(manager: EntityManager): Promise<{ id: string; parentId: string | null }[]> {
  const rows = await manager.query<{ id: string | number; parent_id: string | number | null }[]>(
    'SELECT id, parent_id FROM org_positions ORDER BY id FOR UPDATE',
  );
  return rows.map((r) => ({ id: String(r.id), parentId: r.parent_id === null ? null : String(r.parent_id) }));
}

function assertParent(rows: { id: string; parentId: string | null }[], id: string | null, parentId: string | null): void {
  const error = checkParent(rows, id, parentId);
  if (error) {
    throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, GUARD_MESSAGES[error], { field: 'parentId', reason: error });
  }
}

async function nextSortOrder(manager: EntityManager, parentId: string | null): Promise<number> {
  const [row] = await manager.query<{ next: string | number | null }[]>(
    parentId === null
      ? 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM org_positions WHERE parent_id IS NULL'
      : 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM org_positions WHERE parent_id = ?',
    parentId === null ? [] : [parentId],
  );
  return Number(row?.next ?? 0);
}
