import { Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { BackgroundWork } from '../common/background/background-work.service.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';
import { ENV } from '../config/env.tokens.js';
import { DEV_ENVS, type Env } from '../config/env.js';

/**
 * Development/test hooks for the Jest specs and the smoke suite. Excluded
 * from the OpenAPI document (not part of the contract), and never
 * registered outside development/test (A8, dev.module.ts). The handlers
 * still check NODE_ENV themselves, as a second fence.
 */
@ApiExcludeController()
@Controller('__dev')
@Public()
@SkipThrottle()
export class DevController {
  private readonly enabled: boolean;

  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly background: BackgroundWork,
    @Inject(ENV) env: Env,
  ) {
    this.enabled = DEV_ENVS.includes(env.NODE_ENV);
  }

  /** Runs the nightly maintenance job now — the Jest retention specs (C27) use this. */
  @Post('maintenance/run')
  @HttpCode(200)
  async runMaintenance() {
    this.assertEnabled();
    await this.maintenance.runNightlyJob();
    return { ok: true };
  }

  /**
   * A4: waits until the work routes hand to BackgroundWork is done — for
   * specs and smoke checks that read rows or logs right after a request.
   */
  @Post('settle')
  @HttpCode(200)
  async settle() {
    this.assertEnabled();
    await this.background.settled();
    return { ok: true };
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');
    }
  }
}
