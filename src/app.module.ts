import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { CacheModule } from './cache/cache.module.js';
import { AuditModule } from './audit/audit.module.js';
import { MarkdownModule } from './common/markdown/markdown.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { MediaModule } from './media/media.module.js';
import { FilesModule } from './files/files.module.js';
import { MailModule } from './mail/mail.module.js';
import { SmsModule } from './sms/sms.module.js';
import { RedirectsModule } from './redirects/redirects.module.js';
import { MaintenanceModule } from './maintenance/maintenance.module.js';
import { PreviewModule } from './preview/preview.module.js';
import { StorageModule } from './storage/storage.module.js';
import { SiteSettingsModule } from './site-settings/site-settings.module.js';
import { LocaleInterceptor } from './common/interceptors/locale.interceptor.js';
import { AuditInterceptor } from './common/interceptors/audit.interceptor.js';

// Phase 2 (done): the full schema (001_schema.sql) and entities for every
// table the project plan's "Data model" section lists, plus the infra
// changes it calls for — four-role permission matrix (phase 1), applicant
// sessions (SessionGuard + @ApplicantRoute(), src/auth), private document
// storage (StorageModule), the SMS module (SmsModule, mirroring MailModule)
// and the site-settings singleton (SiteSettingsModule, mirrored below).
// TODO(phase 4): import content modules as they're built — pages/sections,
// stats, about-items, work-areas, board, news/news-categories,
// testimonials/testimonial-themes, partners, doc-categories/documents, plus
// the home and site (chrome) public aggregates.
// TODO(phase 5): import MessagesModule (contact inbox).
// TODO(phase 6): import ApplicationsModule (apply flow) and PortalModule
// (OTP student portal + private documents — wires StorageModule's
// PrivateFileStore into real upload/download endpoints for the first time).
// TODO(phase 7): admin applications module (list/counts/CSV/review/bulk/
// interview-slots) and the admin overview aggregate.
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    // A generous global default; specific routes (login, forgot, reset)
    // tighten it with their own @Throttle().
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    // MailService's 30 s retry sweep and MaintenanceService's nightly sweep
    // are both @Cron()/@Interval() handlers.
    ScheduleModule.forRoot(),
    HealthModule,
    CacheModule,
    AuditModule,
    MarkdownModule,
    AuthModule,
    UsersModule,
    MediaModule,
    FilesModule,
    MailModule,
    SmsModule,
    RedirectsModule,
    MaintenanceModule,
    PreviewModule,
    StorageModule,
    SiteSettingsModule,
  ],
  providers: [
    // Guards run before interceptors regardless of relative registration
    // order (Nest's fixed pipeline). SessionGuard, RolesGuard and CsrfGuard
    // are registered as APP_GUARD providers inside AuthModule instead of
    // here — see the comment there for why and for the ordering guarantee.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Interceptors: Locale resolves first so every downstream piece —
    // including a per-route CacheInterceptor's key — can read req.locale.
    { provide: APP_INTERCEPTOR, useClass: LocaleInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
