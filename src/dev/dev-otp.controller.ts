import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { BackgroundWork } from '../common/background/background-work.service.js';
import { OtpPeekService } from './otp-peek.service.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';

/**
 * C1 dev/test hook — see OtpPeekService. Excluded from the OpenAPI document
 * (it is not part of the contract) and a plain 404 outside
 * development/test, indistinguishable from a route that doesn't exist.
 */
@ApiExcludeController()
@Controller('__dev')
@Public()
@SkipThrottle()
export class DevOtpController {
  constructor(
    private readonly otpPeek: OtpPeekService,
    private readonly maintenance: MaintenanceService,
    private readonly background: BackgroundWork,
  ) {}

  /** Runs the nightly maintenance job now — the Jest retention specs (C27) use this. */
  @Post('maintenance/run')
  @HttpCode(200)
  async runMaintenance() {
    this.assertEnabled();
    await this.maintenance.runNightlyJob();
    return { ok: true };
  }

  /**
   * A4: waits until the work public routes hand to BackgroundWork (the
   * request-otp lookup, row and send) is done — for specs and smoke checks
   * that read rows or logs right after such a request.
   */
  @Post('settle')
  @HttpCode(200)
  async settle() {
    this.assertEnabled();
    await this.background.settled();
    return { ok: true };
  }

  /** The last code issued for an application. A4: waits for sends still in flight first. */
  @Get('otp/:applicationId')
  async peek(@Param('applicationId') applicationId: string) {
    this.assertEnabled();
    await this.background.settled();
    const otp = this.otpPeek.peek(applicationId);
    if (!otp) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');
    }
    return otp;
  }

  private assertEnabled(): void {
    if (!this.otpPeek.isEnabled) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');
    }
  }
}
