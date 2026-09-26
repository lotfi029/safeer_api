import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
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
  ) {}

  /** Runs the nightly maintenance job now — the Jest retention specs (C27) use this. */
  @Post('maintenance/run')
  @HttpCode(200)
  async runMaintenance() {
    if (!this.otpPeek.isEnabled) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');
    }
    await this.maintenance.runNightlyJob();
    return { ok: true };
  }

  @Get('otp/:applicationId')
  peek(@Param('applicationId') applicationId: string) {
    const otp = this.otpPeek.isEnabled ? this.otpPeek.peek(applicationId) : undefined;
    if (!otp) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');
    }
    return otp;
  }
}
