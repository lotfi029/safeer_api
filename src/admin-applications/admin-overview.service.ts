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
import { User } from '../database/entities/user.entity.js';

const RECENT_AUDIT_LIMIT = 20;
const SERIES_MONTHS = 6;
const LATEST_APPLICATIONS_LIMIT = 4;

interface MonthBucket {
  month: string; // 'YYYY-MM'
  start: Date;
  end: Date; // exclusive
}

/** UTC calendar months (C9: every stored timestamp is UTC, so the buckets are too). */
function lastNMonths(n: number): MonthBucket[] {
  const now = new Date();
  const buckets: MonthBucket[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    buckets.push({ month: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`, start, end });
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
 * - B6/C20: `recentAuditLog` is admin-only, and never carries `diff` or IP hashes —
 *   every other role gets an empty array. The feed includes application
 *   references, status changes, and reviewer/user actions across every
 *   collection, which is more than editor/reviewer/support's own areas
 *   should see, and `GET admin/audit` (the full log) is already
 *   admin-only, so the overview's own summary matches that.
 * Content alerts are never role-filtered.
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
    // C20: application figures and applicant names only for the roles that
    // own the applications area (the same matrix @Roles applies to it).
    const includeApplications = role === 'admin' || role === 'reviewer';
    const includeMessages = role !== 'reviewer';

    const [applicationsBlock, messagesBlock, contentAlerts, recentAuditLog] = await Promise.all([
      includeApplications ? this.applicationsBlock() : null,
      includeMessages ? this.messages.countUnread() : null,
      this.contentAlerts(),
      role === 'admin' ? this.recentAuditLog() : Promise.resolve([]),
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

  /**
   * C20: admin-only (see get()), and a summary, not the raw rows: no
   * before/after `diff` (it can hold personal data) and no IP hash — the
   * full row stays in `GET admin/audit`.
   */
  private async recentAuditLog(): Promise<RecentAuditEntry[]> {
    const rows = await this.auditRepo
      .createQueryBuilder('l')
      .leftJoin(User, 'u', 'u.id = l.actor_id')
      .select(['l.id AS id', 'l.action AS action', 'l.entity_type AS entityType', 'l.entity_id AS entityId', 'l.entity_label AS entityLabel', 'l.created_at AS createdAt'])
      .addSelect('l.actor_id', 'actorId')
      .addSelect('u.name', 'actorName')
      .orderBy('l.created_at', 'DESC')
      .addOrderBy('l.id', 'DESC')
      .limit(RECENT_AUDIT_LIMIT)
      .getRawMany<RecentAuditEntry>();
    return rows.map((r) => ({ ...r, id: String(r.id), actorId: r.actorId === null ? null : String(r.actorId), entityId: r.entityId === null ? null : String(r.entityId) }));
  }
}

export interface RecentAuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  actorId: string | null;
  actorName: string | null;
  createdAt: Date;
}
