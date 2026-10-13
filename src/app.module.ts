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
import { LicencesModule } from './licences/licences.module.js';
import { OrgChartModule } from './org-chart/org-chart.module.js';
import { HomeModule } from './home/home.module.js';
import { SiteModule } from './site/site.module.js';
import { ContactModule } from './contact/contact.module.js';
import { MetaModule } from './meta/meta.module.js';
import { MessagesModule } from './messages/messages.module.js';
import { AdminOverviewModule } from './admin-overview/admin-overview.module.js';
import { SitemapModule } from './sitemap/sitemap.module.js';
import { TestAwareThrottlerGuard } from './common/guards/test-aware-throttler.guard.js';
import { devModuleFor } from './dev/dev.module.js';
import { BackgroundWorkModule } from './common/background/background-work.module.js';

// The modules below are the site's content, the contact inbox, auth, mail
// and media. The scholarship feature (apply flow, applicant portal, review,
// interviews) and SMS were removed by migration 021 (feat/governance-contact);
// docs/backend/API-CHANGES.md lists the removed routes.
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
    BackgroundWorkModule,
    HealthModule,
    CacheModule,
    AuditModule,
    MarkdownModule,
    AuthModule,
    UsersModule,
    MediaModule,
    FilesModule,
    MailModule,
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
    LicencesModule,
    OrgChartModule,
    HomeModule,
    SiteModule,
    ContactModule,
    MetaModule,
    MessagesModule,
    AdminOverviewModule,
    // A8: the __dev routes exist only in development/test.
    devModuleFor(process.env.NODE_ENV),
    SitemapModule,
  ],
  providers: [
    // Guards run before interceptors regardless of relative registration
    // order (Nest's fixed pipeline). SessionGuard, RolesGuard and CsrfGuard
    // are registered as APP_GUARD providers inside AuthModule instead of
    // here — see the comment there for why and for the ordering guarantee.
    // Phase 6: TestAwareThrottlerGuard delegates to this same ThrottlerGuard
    // everywhere except NODE_ENV=test (see its own comment) — kept as an
    // ordinary provider (not APP_GUARD) so TestAwareThrottlerGuard can
    // inject a normally-constructed instance of it.
    ThrottlerGuard,
    { provide: APP_GUARD, useClass: TestAwareThrottlerGuard },
    // Interceptors: Locale resolves first so every downstream piece —
    // including a per-route CacheInterceptor's key — can read req.locale.
    { provide: APP_INTERCEPTOR, useClass: LocaleInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
