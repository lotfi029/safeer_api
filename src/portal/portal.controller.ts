import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { PortalApplicationService } from './portal-application.service.js';
import { ApplicantRoute } from '../auth/decorators/applicant-route.decorator.js';
import { computeCsrfToken } from '../auth/csrf.util.js';
import { readPageLimit } from '../common/query/list-params.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import type { RequestContext } from '../common/request-context.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

@Controller('portal')
@ApplicantRoute()
export class PortalController {
  constructor(
    private readonly portalApplicationService: PortalApplicationService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * B16: carries the session's CSRF token, computed exactly as `GET admin/me`
   * does, so the portal can recover it after a page reload (it only lives
   * in the verify-otp / POST applications response otherwise, and the
   * session cookie itself is httpOnly).
   */
  @Get('me')
  async me(@Req() req: RequestContext) {
    const me = await this.portalApplicationService.getMe(req.applicant!.applicationId);
    return { ...me, csrfToken: computeCsrfToken(this.env.APP_ENCRYPTION_KEY, req.sessionTokenHash!) };
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
