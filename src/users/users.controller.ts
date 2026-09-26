import { Body, Controller, Delete, Get, Param, Patch, Req } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import { UsersService } from './users.service.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { Area } from '../auth/role-matrix.js';
import type { RequestContext } from '../common/request-context.js';
import { toPublicUser } from './public-user.js';

/**
 * No POST here — account creation is exclusively through /auth/invite
 * (FR-A-09: admins never type another user's password). RolesGuard is
 * registered globally (AppModule); `@Area('users')` here just supplies the
 * metadata it reads.
 */
@Controller('admin/users')
@Area('users')
@ApiCookieAuth()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const user = await this.usersService.findById(id);
    return toPublicUser(user);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: RequestContext) {
    const { before, after } = await this.usersService.update(req.user!.id, id, dto);
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

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: RequestContext) {
    const snapshot = await this.usersService.remove(req.user!.id, id);
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
