import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Session } from '../../database/entities/session.entity.js';
import { ENV } from '../../config/env.tokens.js';
import type { Env } from '../../config/env.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { hashToken } from '../session-token.util.js';
import { ProblemException } from '../../common/problem-details/problem.exception.js';
import { ErrorCode } from '../../common/problem-details/error-codes.js';
import type { RequestContext } from '../../common/request-context.js';

const LAST_SEEN_UPDATE_THROTTLE_MS = 60 * 1000; // trap 11

/**
 * Global guard (D-06): resolves the staff `sf_sid` cookie against
 * `sessions`, joined to `users`, and populates `req.user`. Sets
 * `req.sessionTokenHash`, which is all `CsrfGuard` reads.
 *
 * A session is valid when
 *   revoked_at IS NULL AND expires_at > NOW() AND last_seen_at > NOW() - INTERVAL <idle>
 * — one indexed lookup per table. `last_seen_at` is written at most once a
 * minute (trap 11), not on every request.
 *
 * 26-backend-code-review.md H5: a `@Public()` route used to return `true`
 * here immediately, before this guard ever looked at the request — so
 * `req.user` was *never* populated on a public route, even for a caller
 * presenting a perfectly valid session cookie. A `@Public()` route now gets
 * a *best-effort* resolution instead: if a session cookie is present and
 * valid, `req.user` is populated exactly as on an authenticated route; if it
 * is absent, expired, revoked or the account is locked, the request
 * proceeds anonymously rather than being rejected (e.g. `/files`'s
 * unpublished-asset gate).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly logger = new Logger(SessionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(Session) private readonly sessionRepo: Repository<Session>,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest<RequestContext>();
    return this.resolveStaffRoute(req, Boolean(isPublic));
  }

  /** The `sf_sid` cookie against `sessions`. */
  private async resolveStaffRoute(req: RequestContext, isPublic: boolean): Promise<boolean> {
    const cookieValue = req.cookies?.[this.env.SESSION_COOKIE_NAME] as string | undefined;

    if (isPublic) {
      if (cookieValue) {
        // Never throws: a missing, expired, revoked or locked-account
        // session on a public route just means "treat this caller as
        // anonymous", not an error.
        await this.resolveStaffSession(req, cookieValue);
      }
      return true;
    }

    if (!cookieValue) {
      throw new ProblemException(401, ErrorCode.UNAUTHENTICATED, 'Sign-in required');
    }

    const resolved = await this.resolveStaffSession(req, cookieValue);
    if (!resolved) {
      throw new ProblemException(401, ErrorCode.UNAUTHENTICATED, 'Session expired or revoked');
    }

    return true;
  }

  /** Looks up `cookieValue`, and if it resolves to a live session, populates `req.user`/`sessionId`/`sessionTokenHash` and bumps `lastSeenAt`. Returns whether it resolved. */
  private async resolveStaffSession(req: RequestContext, cookieValue: string): Promise<boolean> {
    const tokenHash = hashToken(cookieValue);

    const row = await this.sessionRepo
      .createQueryBuilder('s')
      .innerJoinAndSelect('s.user', 'u')
      .where('s.token_hash = :tokenHash', { tokenHash })
      .andWhere('s.revoked_at IS NULL')
      .andWhere('s.expires_at > NOW()')
      .andWhere('s.last_seen_at > (NOW() - INTERVAL :idleHours HOUR)', { idleHours: this.env.SESSION_IDLE_HOURS })
      // C3: only an active account holds a session (a disable also revokes
      // sessions — this is the defence in depth). A C12 brute-force lock
      // deliberately doesn't end sessions, so it isn't checked here.
      .andWhere("u.status = 'active'")
      .getOne();

    if (!row?.user) {
      return false;
    }

    req.user = { id: row.user.id, role: row.user.role };
    req.sessionId = row.id;
    req.sessionTokenHash = tokenHash;

    if (Date.now() - row.lastSeenAt.getTime() > LAST_SEEN_UPDATE_THROTTLE_MS) {
      // I-3: fire-and-forget, but not unhandled — a transient DB blip here
      // must not crash the process over a best-effort timestamp bump.
      void this.sessionRepo
        .createQueryBuilder()
        .update(Session)
        .set({ lastSeenAt: () => 'CURRENT_TIMESTAMP(3)' })
        .where('id = :id', { id: row.id })
        .execute()
        .catch((err: unknown) => {
          this.logger.error('last-seen update failed', err instanceof Error ? err.stack : String(err));
        });
    }

    return true;
  }
}
