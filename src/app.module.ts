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
import { PagesModule } from './pages/pages.module.js';
import { StatsModule } from './stats/stats.module.js';
import { AboutItemsModule } from './about-items/about-items.module.js';
import { WorkAreasModule } from './work-areas/work-areas.module.js';
import { BoardModule } from './board/board.module.js';
import { NewsModule } from './news/news.module.js';
import { TestimonialsModule } from './testimonials/testimonials.module.js';
import { PartnersModule } from './partners/partners.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { HomeModule } from './home/home.module.js';
import { SiteModule } from './site/site.module.js';
import { ContactModule } from './contact/contact.module.js';
import { MetaModule } from './meta/meta.module.js';
import { MessagesModule } from './messages/messages.module.js';
import { ApplicationsModule } from './applications/applications.module.js';
import { PortalModule } from './portal/portal.module.js';
import { AdminApplicationsModule } from './admin-applications/admin-applications.module.js';

// Phase 2 (done): the full schema (001_schema.sql) and entities for every
// table the project plan's "Data model" section lists, plus the infra
// changes it calls for — four-role permission matrix (phase 1), applicant
// sessions (SessionGuard + @ApplicantRoute(), src/auth), private document
// storage (StorageModule), the SMS module (SmsModule, mirroring MailModule)
// and the site-settings singleton (SiteSettingsModule, mirrored below).
// Phase 4 (done): content modules — pages/sections, stats, about-items,
// work-areas, board, news/news-categories, testimonials/testimonial-themes,
// partners, doc-categories/documents, contact/newsletter, meta, plus the
// home and site (chrome) public aggregates. PreviewModule now covers
// `posts` (see auth/preview-token.util.ts's PreviewCollection).
// Phase 5 (done): MessagesModule (contact inbox — reply, status, convert to
// testimonial, delete), hand-written and admin/support-gated per the plan.
// Phase 6 (done): ApplicationsModule (the public "start an application"
// step — mints the reference number and the first applicant_sessions row)
// and PortalModule (autosave/submit, OTP sign-in, private document
// upload/download via StorageModule's PrivateFileStore, interview-slot
// booking, notifications) — the plan's "Apply flow and portal" section.
// Phase 7 (done): AdminApplicationsModule — the staff half of the
// scholarship pipeline (list/counts/CSV export, single-application review,
// the status-transition map, document accept/reject, request-documents,
// internal notes, bulk actions, interview-slot management via
// CrudController) plus the role-filtered admin/overview aggregate. This was
// the last feature phase; phase 8 is docs/openapi/smoke only.
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
    PagesModule,
    StatsModule,
    AboutItemsModule,
    WorkAreasModule,
    BoardModule,
    NewsModule,
    TestimonialsModule,
    PartnersModule,
    DocumentsModule,
    HomeModule,
    SiteModule,
    ContactModule,
    MetaModule,
    MessagesModule,
    ApplicationsModule,
    PortalModule,
    AdminApplicationsModule,
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
