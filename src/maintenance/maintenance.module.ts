import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from '../database/entities/session.entity.js';
import { AuthToken } from '../database/entities/auth-token.entity.js';
import { MailLog } from '../database/entities/mail-log.entity.js';
import { MaintenanceService } from './maintenance.service.js';
import { CacheModule } from '../cache/cache.module.js';

/**
 * The nightly retention sweep. No controller — @Cron is picked up by the
 * globally-registered ScheduleModule (app.module.ts) regardless of which
 * module declares the provider, the same way mail.service.ts's @Interval
 * already works.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Session, AuthToken, MailLog]), CacheModule],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
