import { Controller, Get } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import { roleMatrix, type RoleMatrix } from './role-matrix.js';

/**
 * B17: `GET admin/roles` — the role list and the area → roles matrix, for
 * any signed-in staff member (the dashboard builds its navigation from it).
 * Served from the same constants `@Area()` applies, so it is always what
 * RolesGuard actually enforces.
 */
@ApiCookieAuth()
@Controller('admin/roles')
export class RolesController {
  @Get()
  get(): RoleMatrix {
    return roleMatrix();
  }
}
