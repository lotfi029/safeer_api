import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { Application } from '../database/entities/application.entity.js';
import { AuditLog } from '../database/entities/audit-log.entity.js';
import { Partner } from '../database/entities/partner.entity.js';
import { Post } from '../database/entities/post.entity.js';
import { Page } from '../database/entities/page.entity.js';
import { MessagesService } from '../messages/messages.service.js';
import type { UserRole } from '../database/entities/user.entity.js';

const RECENT_AUDIT_LIMIT = 20;
const SERIES_MONTHS = 6;
const LATEST_APPLICATIONS_LIMIT = 4;

interface MonthBucket {
  month: string; // 'YYYY-MM'
  start: Date;
  end: Date; // exclusive
}

function lastNMonths(n: number): MonthBucket[] {
  const now = new Date();
  const buckets: MonthBucket[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    buckets.push({ month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`, start, end });
  }
  return buckets;
}

/**
 * `GET admin/overview` (project plan "Admin overview"). Reachable by any
 * staff role — `AdminOverviewController` carries no `@Roles()` — but the
 * response shape itself narrows by `req.user.role`:
 * - applications-related blocks (the 3 application stat cards, the 6-month
 *   series, the latest-applications list, the applications sidebar badge)
 *   are omitted for `editor`.
 * - messages-related blocks (the unread-messages stat card and sidebar
 *   badge) are omitted for `reviewer`.
 * Every other role sees everything; content alerts and the audit feed are
 * never role-filtered.
 */
@Injectable()
export class AdminOverviewService {
  constructor(
    @InjectRepository(Application) private readonly applicationRepo: Repository<Application>,
    @InjectRepository(AuditLog) private readonly auditRepo: Repository<AuditLog>,
    @InjectRepository(Partner) private readonly partnerRepo: Repository<Partner>,
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    @InjectRepository(Page) private readonly pageRepo: Repository<Page>,
    private readonly messages: MessagesService,
  ) {}

  async get(role: UserRole) {
    const includeApplications = role !== 'editor';
    const includeMessages = role !== 'reviewer';

    const [applicationsBlock, messagesBlock, contentAlerts, recentAuditLog] = await Promise.all([
      includeApplications ? this.applicationsBlock() : null,
      includeMessages ? this.messages.countUnread() : null,
      this.contentAlerts(),
      this.recentAuditLog(),
    ]);

    const statCards: Record<string, number> = {};
    const badges: Record<string, number> = {};
    if (applicationsBlock) {
      statCards.newApplications = applicationsBlock.newCount;
      statCards.underReview = applicationsBlock.underReviewCount;
      statCards.acceptedThisMonth = applicationsBlock.acceptedThisMonthCount;
      badges.newApplications = applicationsBlock.newCount;
    }
    if (messagesBlock !== null) {
      statCards.unreadMessages = messagesBlock;
      badges.unreadMessages = messagesBlock;
    }

    return {
      statCards,
      ...(applicationsBlock ? { series: applicationsBlock.series, latestApplications: applicationsBlock.latestApplications } : {}),
      contentAlerts,
      badges,
      recentAuditLog,
    };
  }

  private async applicationsBlock() {
    const months = lastNMonths(SERIES_MONTHS);
    const currentMonth = months[months.length - 1];

    const [newCount, underReviewCount, series, latestApplications] = await Promise.all([
      this.applicationRepo.count({ where: { status: 'new' } }),
      this.applicationRepo.count({ where: { status: 'under_review' } }),
      Promise.all(
        months.map(async (bucket) => {
          const [received, accepted] = await Promise.all([
            this.countInRange('submittedAt', bucket.start, bucket.end),
            this.countInRange('decidedAt', bucket.start, bucket.end, 'accepted'),
          ]);
          return { month: bucket.month, received, accepted };
        }),
      ),
      this.applicationRepo.find({
        where: { submittedAt: Not(IsNull()) },
        order: { submittedAt: 'DESC' },
        take: LATEST_APPLICATIONS_LIMIT,
      }),
    ]);

    const acceptedThisMonthCount = await this.countInRange('decidedAt', currentMonth.start, currentMonth.end, 'accepted');

    return {
      newCount,
      underReviewCount,
      acceptedThisMonthCount,
      series,
      latestApplications: latestApplications.map((a) => ({
        id: a.id,
        reference: a.reference,
        name: [a.firstName, a.middleName, a.lastName].filter(Boolean).join(' '),
        status: a.status,
        submittedAt: a.submittedAt,
      })),
    };
  }

  private async countInRange(column: 'submittedAt' | 'decidedAt', start: Date, end: Date, status?: 'accepted'): Promise<number> {
    const qb = this.applicationRepo.createQueryBuilder('a').where(`a.${column} >= :start AND a.${column} < :end`, { start, end });
    if (status) qb.andWhere('a.status = :status', { status });
    return qb.getCount();
  }

  /**
   * `pages.needs_review` exists on the entity (phase 2's schema already
   * anticipated this alert), so it's a real signal, not a substitute — see
   * page.entity.ts.
   */
  private async contentAlerts() {
    const [publishedPartners, legacyPostsCount, pagesNeedingReviewCount] = await Promise.all([
      this.partnerRepo.count({ where: { isPublished: true } }),
      this.postRepo.count({ where: { isLegacy: true } }),
      this.pageRepo.count({ where: { needsReview: true } }),
    ]);

    return {
      noPublishedPartners: publishedPartners === 0,
      legacyPostsCount,
      pagesNeedingReviewCount,
    };
  }

  private async recentAuditLog(): Promise<Partial<AuditLog>[]> {
    return this.auditRepo.find({
      order: { createdAt: 'DESC' },
      take: RECENT_AUDIT_LIMIT,
    });
  }
}
