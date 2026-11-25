import { Body, Controller, Delete, Get, Param, Patch, Req } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import { UsersService } from './users.service.js';
import { RolesService } from '../roles/roles.service.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { Permission } from '../auth/decorators/permission.decorator.js';
import type { RequestContext } from '../common/request-context.js';
import { toPublicUser } from './public-user.js';

/**
 * No POST here — account creation is exclusively through /auth/invite
 * (FR-A-09: admins never type another user's password). PermissionsGuard is
 * registered globally (AuthModule); each handler's `@Permission('users.*')`
 * supplies the metadata it reads.
 */
@Controller('admin/users')
@ApiCookieAuth()
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly roles: RolesService,
  ) {}

  @Permission('users.view')
  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  /**
   * PERM-4 (R8): the roles the caller may assign — the invite and edit
   * dialogs' picker. Every role whose permissions the caller holds, so it
   * needs no `roles.view`. Declared before `:id` so Express matches it first.
   */
  @Permission('users.view')
  @Get('assignable-roles')
  assignableRoles(@Req() req: RequestContext) {
    return this.roles.assignable(req.user!);
  }

  @Permission('users.view')
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const user = await this.usersService.findById(id);
    return toPublicUser(user);
  }

  @Permission('users.manage')
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: RequestContext) {
    const { before, after } = await this.usersService.update(req.user!, id, dto);
    req.auditContext = {
      action: 'update',
      entityType: 'users',
      entityId: id,
      entityLabel: after.name,
      before,
      after,
    };
    return after;
  }

  @Permission('users.delete')
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: RequestContext) {
    const snapshot = await this.usersService.remove(req.user!, id);
    req.auditContext = {
      action: 'delete',
      entityType: 'users',
      entityId: id,
      entityLabel: snapshot.name,
      before: snapshot,
    };
    return { deleted: true };
  }
}
