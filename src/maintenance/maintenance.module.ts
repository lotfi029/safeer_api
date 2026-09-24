import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from '../database/entities/session.entity.js';
import { AuthToken } from '../database/entities/auth-token.entity.js';
import { MailLog } from '../database/entities/mail-log.entity.js';
import { ApplicantSession } from '../database/entities/applicant-session.entity.js';
import { ApplicantOtp } from '../database/entities/applicant-otp.entity.js';
import { MaintenanceService } from './maintenance.service.js';
import { CacheModule } from '../cache/cache.module.js';

/**
 * The nightly retention sweep. No controller — @Cron is picked up by the
 * globally-registered ScheduleModule (app.module.ts) regardless of which
 * module declares the provider, the same way mail.service.ts's @Interval
 * already works.
 *
 * TODO(phase 4+/6+): african_api's equivalent also purges old
 * contact_messages rows and runs a library-link availability check —
 * add ContactMessage back to forFeature() and its purge step once the
 * Contact module lands; Safeer has no library-style oEmbed content, so
 * that check itself is not being ported.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Session, AuthToken, MailLog, ApplicantSession, ApplicantOtp]), CacheModule],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
