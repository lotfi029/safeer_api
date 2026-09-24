import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service.js';
import { Public } from '../auth/decorators/public.decorator.js';

/**
 * Load balancers and monitoring can't authenticate — both routes are
 * @Public() so SessionGuard (a global guard, P6) never blocks them. Being
 * outside the api/v1 prefix (main.ts) only affects routing, not guards.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get()
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async readiness(@Res() res: Response): Promise<void> {
    const [database, storage] = await Promise.all([
      this.health.checkDatabase(),
      this.health.checkStorage(),
    ]);
    const allUp = database && storage;

    res.status(allUp ? 200 : 503).json({
      status: allUp ? 'ok' : 'degraded',
      checks: {
        database: database ? 'up' : 'down',
        storage: storage ? 'up' : 'down',
      },
    });
  }
}
