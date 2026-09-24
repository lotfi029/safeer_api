import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { PortalApplicationService } from './portal-application.service.js';
import { ApplicantRoute } from '../auth/decorators/applicant-route.decorator.js';
import { readPageLimit } from '../common/query/list-params.js';
import type { RequestContext } from '../common/request-context.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

@Controller('portal')
@ApplicantRoute()
export class PortalController {
  constructor(private readonly portalApplicationService: PortalApplicationService) {}

  @Get('me')
  me(@Req() req: RequestContext) {
    return this.portalApplicationService.getMe(req.applicant!.applicationId);
  }

  @ApiQuery({ name: 'page', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: String })
  @Get('notifications')
  async notifications(@Query() query: Record<string, unknown>, @Req() req: RequestContext) {
    const { page, limit, beyondMaxOffset } = readPageLimit(query, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });
    if (beyondMaxOffset) {
      const total = await this.portalApplicationService.countNotifications(req.applicant!.applicationId);
      return { data: [], total, page, limit };
    }
    return this.portalApplicationService.listNotifications(req.applicant!.applicationId, page, limit);
  }
}
