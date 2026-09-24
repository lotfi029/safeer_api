import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PortalOtpService } from './portal-otp.service.js';
import { RequestOtpDto, VerifyOtpDto } from './dto/otp.dto.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { ApplicantRoute } from '../auth/decorators/applicant-route.decorator.js';
import { ApplicantSessionService } from '../auth/applicant-session.service.js';
import type { RequestContext } from '../common/request-context.js';

@Controller('portal/auth')
export class PortalAuthController {
  constructor(
    private readonly otpService: PortalOtpService,
    private readonly applicantSessions: ApplicantSessionService,
  ) {}

  /** Public, non-enumerating (always `{ ok: true }`) — see PortalOtpService.requestOtp's own comment. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('request-otp')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.otpService.requestOtp(dto.identifier);
  }

  /** Public — the caller has no session yet; that's exactly what a successful verify mints. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @Post('verify-otp')
  async verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: RequestContext, @Res({ passthrough: true }) res: Response) {
    const result = await this.otpService.verifyOtp(dto.identifier, dto.code, req);
    this.applicantSessions.setCookie(res, result.token);
    return { csrfToken: result.csrfToken };
  }

  @ApplicantRoute()
  @Post('logout')
  async logout(@Req() req: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.applicantSessions.revoke(req.sessionId!);
    this.applicantSessions.clearCookie(res);
    return { ok: true };
  }
}
