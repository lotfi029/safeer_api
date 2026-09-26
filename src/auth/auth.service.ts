import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type EntityManager } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import { User, type UserRole } from '../database/entities/user.entity.js';
import { Session } from '../database/entities/session.entity.js';
import { AuthToken, type AuthTokenPurpose } from '../database/entities/auth-token.entity.js';
import { AuditLog } from '../database/entities/audit-log.entity.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { PasswordService } from './password.service.js';
import { generateSessionToken, hashToken } from './session-token.util.js';
import { computeCsrfToken } from './csrf.util.js';
import { MAIL_SERVICE, type MailServiceInterface } from '../mail/mail.service.interface.js';
import { UsersService, UNUSABLE_PASSWORD_HASH } from '../users/users.service.js';
import { isBruteForceLocked, toPublicUser, type PublicUser } from '../users/public-user.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { RequestContext } from '../common/request-context.js';
import { frontendUrl } from '../common/links/frontend-url.js';
import { roleLabel } from '../common/labels.js';

const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_ATTEMPT_WINDOW_MS = 60_000;
/**
 * B1-7: this counter used to live in the shared response CacheService — a
 * flood of junk query keys against a cached public route (`/home?x=1…600`)
 * could evict it early, silently resetting the limit, and raising
 * CACHE_TTL_SECONDS for unrelated performance reasons would have silently
 * lengthened every login lockout too. Its own bounded LRU, sized well
 * beyond anything this API's real login traffic could produce, closes both.
 */
const LOGIN_ATTEMPT_MAX_TRACKED = 10_000;
const INVITE_TOKEN_HOURS = 48;
/** C12: wrong passwords before a time-boxed lock, and the first lock's length (doubling each time after). */
const LOCK_THRESHOLD = 10;
const LOCK_BASE_MINUTES = 15;
const RESET_TOKEN_MINUTES = 60;

export interface LoginResult {
  token: string;
  user: PublicUser;
  csrfToken: string;
}

export interface SessionSummary {
  id: string;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  isCurrent: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private readonly loginAttempts = new LRUCache<string, number>({
    max: LOGIN_ATTEMPT_MAX_TRACKED,
    ttl: LOGIN_ATTEMPT_WINDOW_MS,
  });

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Session) private readonly sessionRepo: Repository<Session>,
    @InjectRepository(AuthToken) private readonly authTokenRepo: Repository<AuthToken>,
    @InjectRepository(AuditLog) private readonly auditRepo: Repository<AuditLog>,
    private readonly passwordService: PasswordService,
    private readonly usersService: UsersService,
    @Inject(MAIL_SERVICE) private readonly mailService: MailServiceInterface,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // -------------------------------------------------------------------
  // Login / logout
  // -------------------------------------------------------------------

  /**
   * Login writes its own audit rows directly rather than through
   * AuditInterceptor's req.auditContext mechanism: a failed login always
   * ends in a thrown 401, and the interceptor only fires on a successful
   * (next-channel) response (13-backend-build-plan.md P5) — the exact
   * opposite of when `login_failed` needs to be written.
   */
  async login(email: string, password: string, req: RequestContext): Promise<LoginResult> {
    this.checkEmailRateLimit(email);

    // passwordHash is `select: false` on the entity — opt back in explicitly,
    // the same pattern mail-transport.service.ts uses for its own secret.
    const user = await this.userRepo
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.email = :email', { email })
      .getOne();

    // C3/C12: only an `active` account that isn't inside a brute-force lock
    // can sign in. Every refusal below looks the same from outside.
    const usable = user !== null && user.status === 'active' && !isBruteForceLocked(user);

    // B1 (timing oracle): verify against a real hash unconditionally,
    // before either branch below can return early. UNUSABLE_PASSWORD_HASH
    // is guaranteed to fail verification (users.service.ts) but has the
    // same Argon2id shape and cost as a real one, so every path takes the
    // same time regardless of which branch is about to be taken.
    const ok = await this.passwordService.verify(usable ? user.passwordHash : UNUSABLE_PASSWORD_HASH, password);

    if (!user || !usable) {
      await this.writeAudit(user?.id ?? null, 'login_failed', user?.id ?? null, user?.name ?? null, req.ipHash);
      throw new ProblemException(401, ErrorCode.UNAUTHENTICATED, 'Invalid email or password');
    }

    if (!ok) {
      await this.registerFailedAttempt(user.id);
      await this.writeAudit(user.id, 'login_failed', user.id, user.name, req.ipHash);
      throw new ProblemException(401, ErrorCode.UNAUTHENTICATED, 'Invalid email or password');
    }

    // C4: a targeted UPDATE, never save(user) — a full save would write back
    // this request's stale copy of password_hash/status, so a login racing a
    // password reset or an admin disable could undo it. Guarded on the
    // account still being active: a disable that committed after the SELECT
    // above wins.
    const signedIn = await this.userRepo
      .createQueryBuilder()
      .update(User)
      .set({ failedLogins: 0, lockCount: 0, lastLoginAt: () => 'CURRENT_TIMESTAMP(3)' })
      .where('id = :id', { id: user.id })
      .andWhere("status = 'active'")
      .execute();
    if (!signedIn.affected) {
      await this.writeAudit(user.id, 'login_failed', user.id, user.name, req.ipHash);
      throw new ProblemException(401, ErrorCode.UNAUTHENTICATED, 'Invalid email or password');
    }
    user.failedLogins = 0;
    user.lockCount = 0;
    user.lastLoginAt = new Date();
    this.resetEmailRateLimit(email);

    const token = generateSessionToken();
    const tokenHash = hashToken(token);
    const now = Date.now();
    const session = this.sessionRepo.create({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(now + this.env.SESSION_ABSOLUTE_DAYS * 24 * 60 * 60 * 1000),
      lastSeenAt: new Date(now),
      userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 255) ?? null,
      ipHash: req.ipHash ?? null,
    });
    await this.sessionRepo.save(session);

    await this.writeAudit(user.id, 'login', user.id, user.name, req.ipHash);

    return {
      token,
      user: toPublicUser(user),
      csrfToken: computeCsrfToken(this.env.APP_ENCRYPTION_KEY, tokenHash),
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessionRepo.update(sessionId, { revokedAt: new Date() });
  }

  // -------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------

  async listSessions(userId: string, currentSessionId: string): Promise<SessionSummary[]> {
    const sessions = await this.sessionRepo.find({
      where: { userId },
      order: { lastSeenAt: 'DESC' },
    });
    return sessions
      .filter((s) => !s.revokedAt && s.expiresAt > new Date())
      .map((s) => ({
        id: s.id,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        isCurrent: s.id === currentSessionId,
      }));
  }

  /** A user ends their own session; an admin may end any user's (FR-A-08). */
  async endSession(actorId: string, actorRole: string, targetSessionId: string): Promise<void> {
    const session = await this.sessionRepo.findOne({ where: { id: targetSessionId } });
    if (!session) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Session not found');
    if (session.userId !== actorId && actorRole !== 'admin') {
      throw new ProblemException(403, ErrorCode.FORBIDDEN, 'You can only end your own sessions');
    }
    session.revokedAt = new Date();
    await this.sessionRepo.save(session);
  }

  async endOtherSessions(userId: string, currentSessionId: string): Promise<number> {
    const result = await this.sessionRepo
      .createQueryBuilder()
      .update(Session)
      .set({ revokedAt: () => 'CURRENT_TIMESTAMP(3)' })
      .where('user_id = :userId', { userId })
      .andWhere('id != :currentSessionId', { currentSessionId })
      .andWhere('revoked_at IS NULL')
      .execute();
    return result.affected ?? 0;
  }

  // -------------------------------------------------------------------
  // Password
  // -------------------------------------------------------------------

  /** Changing a password ends every session but the current one (FR-A-08). */
  async changePassword(userId: string, currentPassword: string, newPassword: string, currentSessionId: string): Promise<void> {
    // passwordHash is `select: false` — opt back in, same as login().
    const user = await this.userRepo
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.id = :id', { id: userId })
      .getOne();
    if (!user) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'User not found');

    const ok = await this.passwordService.verify(user.passwordHash, currentPassword);
    if (!ok) {
      throw new ProblemException(401, ErrorCode.UNAUTHENTICATED, 'Current password is incorrect');
    }

    // C4: write only the hash.
    await this.userRepo.update(userId, { passwordHash: await this.passwordService.hash(newPassword) });
    await this.endOtherSessions(userId, currentSessionId);
  }

  // -------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------

  async invite(inviter: PublicUser, email: string, name: string, role: UserRole): Promise<PublicUser> {
    const user = await this.usersService.createInvitedUser(email, name, role);

    const rawToken = randomBytes(32).toString('base64url');
    await this.authTokenRepo.save(
      this.authTokenRepo.create({
        userId: user.id,
        purpose: 'invite',
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + INVITE_TOKEN_HOURS * 60 * 60 * 1000),
      }),
    );

    const link = frontendUrl(this.env, 'ar', `admin/accept/${rawToken}`);
    await this.mailService.send({
      key: 'user_invite',
      to: user.email,
      // C23: the template names the role — a label, in the mail's language.
      vars: { name: user.name, inviter: inviter.name, role: roleLabel(role, 'ar'), link },
      locale: 'ar',
      entity: { type: 'users', id: user.id },
    });

    return toPublicUser(user);
  }

  /**
   * C3: only an account still `invited` can accept (a disabled one can't
   * reactivate itself through an old link). Accepting sets the password and
   * `status = 'active'` in the same transaction that spends the token.
   */
  async acceptInvite(rawToken: string, newPassword: string): Promise<PublicUser> {
    const passwordHash = await this.passwordService.hash(newPassword);
    return this.consumeToken(rawToken, 'invite', ['invited'], async (manager, user) => {
      await manager.update(User, { id: user.id }, { passwordHash, status: 'active', failedLogins: 0, lockedUntil: null, lockCount: 0 });
      user.status = 'active';
      user.failedLogins = 0;
      user.lockedUntil = null;
      user.lockCount = 0;
    });
  }

  // -------------------------------------------------------------------
  // Forgot / reset
  // -------------------------------------------------------------------

  /** The response is identical whether or not the email exists (FR-A-10) — never used to enumerate staff. */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.userRepo.findOne({ where: { email } });
    // C3: nothing for a disabled account, nor for a pending invitation (that
    // one completes through its own invite link) — same response either way.
    if (!user || user.status !== 'active') return;

    const rawToken = randomBytes(32).toString('base64url');
    await this.authTokenRepo.save(
      this.authTokenRepo.create({
        userId: user.id,
        purpose: 'reset',
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000),
      }),
    );

    const link = frontendUrl(this.env, 'ar', `admin/reset/${rawToken}`);
    await this.mailService.send({
      key: 'password_reset',
      to: user.email,
      vars: { name: user.name, link },
      locale: 'ar',
      entity: { type: 'users', id: user.id },
    });
  }

  /**
   * C3: only for an `active` account — a reset never re-enables a disabled
   * one. Completing it proves mailbox control, so it also clears a running
   * brute-force lock (C12), and it ends every session.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<PublicUser> {
    const passwordHash = await this.passwordService.hash(newPassword);
    return this.consumeToken(rawToken, 'reset', ['active'], async (manager, user) => {
      await manager.update(User, { id: user.id }, { passwordHash, failedLogins: 0, lockedUntil: null, lockCount: 0 });
      await manager
        .createQueryBuilder()
        .update(Session)
        .set({ revokedAt: () => 'CURRENT_TIMESTAMP(3)' })
        .where('user_id = :userId', { userId: user.id })
        .andWhere('revoked_at IS NULL')
        .execute();
      user.failedLogins = 0;
      user.lockedUntil = null;
      user.lockCount = 0;
    });
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Single-use, and (C33) the token's consumption and the account write
   * (`apply`) land in one transaction. C3: the account must be in one of
   * `allowedStatuses`, and using a token deletes every other outstanding
   * token of that user — an older reset link can't be replayed after a
   * newer one was used.
   */
  private async consumeToken(
    rawToken: string,
    purpose: AuthTokenPurpose,
    allowedStatuses: User['status'][],
    apply: (manager: EntityManager, user: User) => Promise<void>,
  ): Promise<PublicUser> {
    const tokenHash = hashToken(rawToken);
    const invalid = () => new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'This link is invalid or has expired');
    return this.authTokenRepo.manager.transaction(async (manager) => {
      const authToken = await manager
        .createQueryBuilder(AuthToken, 't')
        .setLock('pessimistic_write')
        .where('t.token_hash = :tokenHash', { tokenHash })
        .andWhere('t.purpose = :purpose', { purpose })
        .andWhere('t.used_at IS NULL')
        .andWhere('t.expires_at > NOW()')
        .getOne();
      if (!authToken) throw invalid();

      const user = await manager
        .createQueryBuilder(User, 'u')
        .setLock('pessimistic_write')
        .where('u.id = :id', { id: authToken.userId })
        .getOne();
      if (!user || !allowedStatuses.includes(user.status)) throw invalid();

      authToken.usedAt = new Date();
      await manager.save(authToken);
      await manager
        .createQueryBuilder()
        .delete()
        .from(AuthToken)
        .where('user_id = :userId', { userId: user.id })
        .andWhere('used_at IS NULL')
        .execute();

      await apply(manager, user);
      return toPublicUser(user);
    });
  }

  /**
   * C4 + C12: one atomic UPDATE (MySQL evaluates SET left to right, each
   * assignment seeing the previous ones): count the failure; at
   * LOCK_THRESHOLD failures start a lock of 15 min × 2^lock_count (capped at
   * 2^6), bump lock_count and restart the count. A brute-force lock never
   * revokes sessions — someone hammering the login form must not be able to
   * sign an admin out.
   */
  private async registerFailedAttempt(userId: string): Promise<void> {
    await this.userRepo.query(
      `UPDATE users
          SET failed_logins = failed_logins + 1,
              locked_until = IF(failed_logins >= ?, UTC_TIMESTAMP(3) + INTERVAL (? * POW(2, LEAST(lock_count, 6))) MINUTE, locked_until),
              lock_count = IF(failed_logins >= ?, lock_count + 1, lock_count),
              failed_logins = IF(failed_logins >= ?, 0, failed_logins)
        WHERE id = ?`,
      [LOCK_THRESHOLD, LOCK_BASE_MINUTES, LOCK_THRESHOLD, LOCK_THRESHOLD, userId],
    );
  }

  private async writeAudit(
    actorId: string | null,
    action: 'login' | 'login_failed',
    entityId: string | null,
    entityLabel: string | null,
    ipHash?: string | null,
  ): Promise<void> {
    try {
      await this.auditRepo.insert({
        actorId,
        action,
        entityType: 'users',
        entityId,
        entityLabel,
        diff: null,
        ipHash: ipHash ?? null,
      });
    } catch (err) {
      this.logger.error('Failed to write login audit row', err instanceof Error ? err.stack : String(err));
    }
  }

  /** 5/min per email (throttled per-IP separately, via @Throttle on the route). */
  private checkEmailRateLimit(email: string): void {
    const key = email.toLowerCase();
    const attempts = this.loginAttempts.get(key) ?? 0;
    if (attempts >= LOGIN_ATTEMPT_LIMIT) {
      throw new ProblemException(429, ErrorCode.RATE_LIMITED, 'Too many login attempts for this account — try again shortly');
    }
    this.loginAttempts.set(key, attempts + 1);
  }

  /**
   * Called unconditionally at the top of `login()`, before the password is
   * even checked (so the limiter itself can't be used to brute-force
   * timing) — which means a *successful* sign-in had already incremented
   * this counter with no way to bring it back down. Five correct
   * sign-ins in a row used to be indistinguishable from five guesses.
   */
  private resetEmailRateLimit(email: string): void {
    this.loginAttempts.delete(email.toLowerCase());
  }
}
