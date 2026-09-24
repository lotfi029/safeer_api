import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { loadEnv } from './env.js';
import { ENV } from './env.tokens.js';

/**
 * Loads and validates process.env once (via loadEnv, which exits the process
 * on a bad value) and exposes the typed result under the ENV token so any
 * provider can `@Inject(ENV) env: Env` instead of the untyped ConfigService.
 */
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => loadEnv(config),
    }),
  ],
  providers: [
    {
      provide: ENV,
      useFactory: () => loadEnv(),
    },
  ],
  exports: [ENV],
})
export class ConfigModule {}
