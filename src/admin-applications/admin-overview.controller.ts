import { Controller, Get, Req } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import type { RequestContext } from '../common/request-context.js';
import { AdminOverviewService } from './admin-overview.service.js';

/**
 * `admin/overview` — no `@Roles()`: RolesGuard is opt-in (crud.factory.ts's
 * `remove()` comment), so any authenticated staff role passes SessionGuard
 * alone, matching the plan ("accessible to ANY staff role"). The response
 * *shape* is what narrows by role — see AdminOverviewService.get().
 */
@Controller('admin/overview')
@ApiCookieAuth()
export class AdminOverviewController {
  constructor(private readonly overview: AdminOverviewService) {}

  @Get()
  async get(@Req() req: RequestContext) {
    return this.overview.get(req.user!.role);
  }
}
