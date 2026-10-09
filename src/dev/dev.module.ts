import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { isDevEnv, type Env } from '../config/env.js';
import { MaintenanceModule } from '../maintenance/maintenance.module.js';
import { DevOtpController } from './dev-otp.controller.js';
import { DisabledOtpPeekService, OtpPeekService } from './otp-peek.service.js';

/** Development/test only: the __dev hooks (OTP peek, settle, run maintenance) and the real OTP peek store. */
@Global()
@Module({
  imports: [ConfigModule, MaintenanceModule],
  controllers: [DevOtpController],
  providers: [OtpPeekService],
  exports: [OtpPeekService],
})
export class DevModule {}

/** Staging/production: no __dev routes at all, and a no-op OtpPeekService for PortalOtpService (A8). */
@Global()
@Module({
  providers: [{ provide: OtpPeekService, useClass: DisabledOtpPeekService }],
  exports: [OtpPeekService],
})
export class DisabledDevModule {}

/**
 * A8 (safeer-delivery-review.md): the dev module used to be imported in
 * every environment, with only a NODE_ENV check inside each handler between
 * production and the OTP peek hook. Now its routes are never registered
 * outside development/test. `nodeEnv` is read when AppModule is defined;
 * ConfigModule has loaded .env into process.env by then.
 */
export function devModuleFor(nodeEnv: string | undefined): DynamicModule {
  const dev = isDevEnv({ NODE_ENV: nodeEnv as Env['NODE_ENV'] });
  return { module: dev ? DevModule : DisabledDevModule, global: true };
}
