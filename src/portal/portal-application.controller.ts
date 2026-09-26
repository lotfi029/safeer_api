import { Body, Controller, Patch, Post, Req } from '@nestjs/common';
import { PortalApplicationService } from './portal-application.service.js';
import { UpdateApplicationDto } from './dto/update-application.dto.js';
import { SubmitApplicationDto } from './dto/submit-application.dto.js';
import { ApplicationCorrectionsDto } from './dto/corrections.dto.js';
import { ApplicantRoute } from '../auth/decorators/applicant-route.decorator.js';
import type { RequestContext } from '../common/request-context.js';

@Controller('portal/application')
@ApplicantRoute()
export class PortalApplicationController {
  constructor(private readonly portalApplicationService: PortalApplicationService) {}

  @Patch()
  patch(@Body() dto: UpdateApplicationDto, @Req() req: RequestContext) {
    return this.portalApplicationService.patch(req.applicant!.applicationId, dto);
  }

  /** C15: `docs_missing` only — see PortalApplicationService.correct. */
  @Patch('corrections')
  correct(@Body() dto: ApplicationCorrectionsDto, @Req() req: RequestContext) {
    return this.portalApplicationService.correct(req.applicant!.applicationId, dto);
  }

  @Post('submit')
  submit(@Body() dto: SubmitApplicationDto, @Req() req: RequestContext) {
    return this.portalApplicationService.submit(req.applicant!.applicationId, dto);
  }
}
