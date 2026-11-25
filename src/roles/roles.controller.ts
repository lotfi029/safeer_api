import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import { Permission } from '../auth/decorators/permission.decorator.js';
import { permissionCatalog, type PermissionCatalog } from '../auth/permissions.js';
import type { RequestContext } from '../common/request-context.js';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto.js';
import { RolesService } from './roles.service.js';

/**
 * PERM-4: `GET admin/permissions` — the catalog the role editor draws its
 * grid from (groups → modules → actions, ar/en labels). Open to any signed-in
 * staff member (scripts/lib/check-permissions.mjs's allow-list): it says
 * what exists, not who holds what.
 */
@ApiCookieAuth()
@Controller('admin/permissions')
export class PermissionsController {
  @Get()
  get(): PermissionCatalog {
    return permissionCatalog();
  }
}

/**
 * PERM-4: `admin/roles` — role list (with `userCount`) and CRUD. Each write
 * hands AuditInterceptor a `roles` audit row with before/after permission
 * lists (rule 6); the rules themselves are in RolesService.
 */
@ApiCookieAuth()
@Controller('admin/roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Permission('roles.view')
  @Get()
  list() {
    return this.roles.list();
  }

  @Permission('roles.view')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.roles.get(id);
  }

  @Permission('roles.manage')
  @Post()
  async create(@Body() dto: CreateRoleDto, @Req() req: RequestContext) {
    const created = await this.roles.create(req.user!, dto);
    const { userCount: _ignored, ...after } = created;
    req.auditContext = { action: 'create', entityType: 'roles', entityId: created.id, entityLabel: created.nameAr, after };
    return created;
  }

  @Permission('roles.manage')
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateRoleDto, @Req() req: RequestContext) {
    const { before, after } = await this.roles.update(req.user!, id, dto);
    req.auditContext = { action: 'update', entityType: 'roles', entityId: id, entityLabel: after.nameAr, before, after };
    return this.roles.get(id);
  }

  @Permission('roles.delete')
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: RequestContext) {
    const before = await this.roles.remove(req.user!, id);
    req.auditContext = { action: 'delete', entityType: 'roles', entityId: id, entityLabel: before.nameAr, before };
    return { deleted: true };
  }
}
