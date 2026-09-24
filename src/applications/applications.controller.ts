import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ApplicationsService } from './applications.service.js';
import { CreateApplicationDto } from './dto/create-application.dto.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { ApplicantSessionService } from '../auth/applicant-session.service.js';
import type { RequestContext } from '../common/request-context.js';

@Controller('applications')
export class ApplicationsController {
  constructor(
    private readonly applicationsService: ApplicationsService,
    private readonly applicantSessions: ApplicantSessionService,
  ) {}

  /**
   * Public — no applicant session exists yet. 5/hour/IP: this is the one
   * apply-flow route that also mints a fresh reference number, so it gets
   * the same order-of-magnitude ceiling as `contact`/`newsletter`'s
   * spam-throttles rather than a generous default.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post()
  async create(@Body() dto: CreateApplicationDto, @Req() req: RequestContext, @Res({ passthrough: true }) res: Response) {
    const result = await this.applicationsService.create(dto, req);
    this.applicantSessions.setCookie(res, result.token);
    return { reference: result.reference, csrfToken: result.csrfToken };
  }
}
