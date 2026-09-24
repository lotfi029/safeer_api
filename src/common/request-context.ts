import type { Request } from 'express';
import type { UserRole } from '../database/entities/user.entity.js';
import type { AuditAction } from '../database/entities/audit-log.entity.js';

export type Locale = 'ar' | 'en';

export interface AuditContext {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  /** Read inside the same transaction as the write; the whole row on delete. */
  before?: unknown;
  after?: unknown;
}

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
}

export interface AuthenticatedApplicant {
  applicationId: string;
}

/**
 * The request shape after the cross-cutting pieces have run:
 * - `locale` — set by LocaleInterceptor (P5)
 * - `id` — set by requestIdMiddleware (P1)
 * - `ipHash` — set by ipHashMiddleware (P5), SHA-256(IP + IP_HASH_SALT)
 * - `user` — set by SessionGuard (P6) on a staff route; absent on public
 *   routes and on `@ApplicantRoute()` routes
 * - `applicant` — set by SessionGuard (Safeer infra change §2) on an
 *   `@ApplicantRoute()` handler, resolved from the `sf_app_sid` cookie
 *   against `applicant_sessions` instead of the staff `sessions` table;
 *   `user` and `applicant` are never both set on the same request — the two
 *   cookies and the two guard code paths are kept completely separate
 * - `sessionId` / `sessionTokenHash` — set by SessionGuard (P6) for either
 *   kind of session; the latter is what CsrfGuard derives the expected
 *   token from, unchanged for both staff and applicant routes
 * - `auditContext` — set by a service/controller before returning, for
 *   AuditInterceptor (P5) to pick up after a successful write
 */
export interface RequestContext extends Request {
  id?: string;
  locale: Locale;
  ipHash?: string | null;
  user?: AuthenticatedUser;
  applicant?: AuthenticatedApplicant;
  sessionId?: string;
  sessionTokenHash?: string;
  auditContext?: AuditContext;
  /**
   * Set by a cached handler (cache.interceptor.ts) to say "don't cache
   * this particular response" — e.g. an empty page past `beyondMaxOffset`,
   * or a `?q=` search term, both of which mint one cache entry per distinct
   * caller input on an otherwise-bounded key (30-backend-finishing-
   * prompt.md §2.3/task 3). The read is still served from the request path
   * as normal; only the `cache.set()` after it is skipped.
   */
  skipCacheWrite?: boolean;
}

const ADMIN_PREFIX = /^\/api\/v1\/admin(\/|$)/;

export function isAdminRoute(path: string): boolean {
  return ADMIN_PREFIX.test(path);
}
