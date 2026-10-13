import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity.js';
import { Partner } from '../database/entities/partner.entity.js';
import { Post } from '../database/entities/post.entity.js';
import { Page } from '../database/entities/page.entity.js';
import { MessagesService } from '../messages/messages.service.js';
import type { UserRole } from '../database/entities/user.entity.js';
import { User } from '../database/entities/user.entity.js';
import { AREA_ROLES, type Area } from '../auth/role-matrix.js';

const hasArea = (area: Area, role: UserRole): boolean => (AREA_ROLES[area] as readonly UserRole[]).includes(role);

const RECENT_AUDIT_LIMIT = 20;

/**
 * `GET admin/overview` (project plan "Admin overview"). Reachable by any
 * staff role — `AdminOverviewController` carries no `@Roles()` — but the
 * response shape itself narrows by `req.user.role`:
 * - messages-related blocks (the unread-messages stat card and sidebar
 *   badge) only for the inbox area's roles (admin, support — A5).
 * - B6/C20: `recentAuditLog` is admin-only, and never carries `diff` or IP
 *   hashes — every other role gets an empty array. `GET admin/audit` (the
 *   full log) is already admin-only, so the overview's own summary matches.
 * Content alerts are never role-filtered.
 *
 * The scholarship blocks (application stat cards, the 6-month series, the
 * latest applications and the applications badge) went with the
 * applications feature — see docs/backend/API-CHANGES.md.
 */
@Injectable()
export class AdminOverviewService {
  constructor(
    @InjectRepository(AuditLog) private readonly auditRepo: Repository<AuditLog>,
    @InjectRepository(Partner) private readonly partnerRepo: Repository<Partner>,
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    @InjectRepository(Page) private readonly pageRepo: Repository<Page>,
    private readonly messages: MessagesService,
  ) {}

  async get(role: UserRole) {
    // C20 + A5: each block only for the roles that own its area — the same
    // matrix @Area() applies to the routes behind it. Message figures are
    // the inbox area's (admin, support): editors don't see the inbox.
    const includeMessages = hasArea('inbox', role);

    const [messagesBlock, contentAlerts, recentAuditLog] = await Promise.all([
      includeMessages ? this.messages.countUnread() : null,
      this.contentAlerts(),
      role === 'admin' ? this.recentAuditLog() : Promise.resolve([]),
    ]);

    const statCards: Record<string, number> = {};
    const badges: Record<string, number> = {};
    if (messagesBlock !== null) {
      statCards.unreadMessages = messagesBlock;
      badges.unreadMessages = messagesBlock;
    }

    return { statCards, contentAlerts, badges, recentAuditLog };
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
