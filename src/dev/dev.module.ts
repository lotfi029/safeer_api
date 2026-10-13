import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { isDevEnv, type Env } from '../config/env.js';
import { MaintenanceModule } from '../maintenance/maintenance.module.js';
import { DevController } from './dev.controller.js';

/** Development/test only: the __dev hooks (settle, run maintenance). */
@Module({
  imports: [ConfigModule, MaintenanceModule],
  controllers: [DevController],
})
export class DevModule {}

/** Staging/production: no __dev routes at all. */
@Module({})
export class DisabledDevModule {}

/**
 * A8 (safeer-delivery-review.md): the dev routes are never registered
 * outside development/test. `nodeEnv` is read when AppModule is defined;
 * ConfigModule has loaded .env into process.env by then.
 */
export function devModuleFor(nodeEnv: string | undefined): DynamicModule {
  const dev = isDevEnv({ NODE_ENV: nodeEnv as Env['NODE_ENV'] });
  return { module: dev ? DevModule : DisabledDevModule };
}
