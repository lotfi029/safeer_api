import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
import { toPublicUser, type PublicUser } from '../users/public-user.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { RequestContext } from '../common/request-context.js';

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

    // B1 (timing oracle): verify against a real hash unconditionally,
    // before either branch below can return early. An unknown or locked
    // account used to skip Argon2 entirely and return in the time a single
    // indexed SELECT takes, while a known account with a wrong password
    // paid Argon2's deliberately-expensive cost — an easily measurable,
    // reliable signal for enumerating valid emails. UNUSABLE_PASSWORD_HASH
    // is guaranteed to fail verification (users.service.ts) but has the
    // same Argon2id shape and cost as a real one, so both paths now take
    // the same time regardless of which branch is about to be taken.
    const ok = await this.passwordService.verify(user && !user.isLocked ? user.passwordHash : UNUSABLE_PASSWORD_HASH, password);

    if (!user || user.isLocked) {
      await this.writeAudit(user?.id ?? null, 'login_failed', user?.id ?? null, user?.name ?? email, req.ipHash);
      throw new ProblemException(401, ErrorCode.UNAUTHENTICATED, 'Invalid email or password');
    }

    if (!ok) {
      await this.registerFailedAttempt(user);
      await this.writeAudit(user.id, 'login_failed', user.id, user.name, req.ipHash);
      throw new ProblemException(401, ErrorCode.UNAUTHENTICATED, 'Invalid email or password');
    }

    user.failedLogins = 0;
    user.lastLoginAt = new Date();
    await this.userRepo.save(user);
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

    user.passwordHash = await this.passwordService.hash(newPassword);
    await this.userRepo.save(user);
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

    const link = `${this.env.PUBLIC_BASE_URL}/admin/accept/${rawToken}`;
    await this.mailService.send({
      key: 'user_invite',
      to: user.email,
      vars: { name: user.name, inviter: inviter.name, link },
      locale: 'ar',
      entity: { type: 'users', id: user.id },
    });

    return toPublicUser(user);
  }

  async acceptInvite(rawToken: string, newPassword: string): Promise<PublicUser> {
    const user = await this.consumeToken(rawToken, 'invite');
    user.passwordHash = await this.passwordService.hash(newPassword);
    user.isLocked = false;
    await this.userRepo.save(user);
    return toPublicUser(user);
  }

  // -------------------------------------------------------------------
  // Forgot / reset
  // -------------------------------------------------------------------

  /** The response is identical whether or not the email exists (FR-A-10) — never used to enumerate staff. */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.userRepo.findOne({ where: { email } });
    if (!user) return;

    const rawToken = randomBytes(32).toString('base64url');
    await this.authTokenRepo.save(
      this.authTokenRepo.create({
        userId: user.id,
        purpose: 'reset',
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000),
      }),
    );

    const link = `${this.env.PUBLIC_BASE_URL}/admin/reset/${rawToken}`;
    await this.mailService.send({
      key: 'password_reset',
      to: user.email,
      vars: { name: user.name, link },
      locale: 'ar',
      entity: { type: 'users', id: user.id },
    });
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<PublicUser> {
    const user = await this.consumeToken(rawToken, 'reset');
    user.passwordHash = await this.passwordService.hash(newPassword);
    // M1: acceptInvite already clears isLocked (:244); this path didn't,
    // and never cleared failedLogins either. A user who mistypes their way
    // to a lock, then completes an emailed reset, proved mailbox control —
    // exactly the evidence the lock was waiting for — but previously still
    // got the generic "Invalid email or password" from login() (:103-106
    // deliberately lumps locked and unknown together), with unlock being
    // admin-only. For the sole admin that is unrecoverable through the API.
    user.isLocked = false;
    user.failedLogins = 0;
    await this.userRepo.save(user);
    await this.sessionRepo
      .createQueryBuilder()
      .update(Session)
      .set({ revokedAt: () => 'CURRENT_TIMESTAMP(3)' })
      .where('user_id = :userId', { userId: user.id })
      .andWhere('revoked_at IS NULL')
      .execute();
    return toPublicUser(user);
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /** Single-use: the password write and `used_at` land in the same transaction. */
  private async consumeToken(rawToken: string, purpose: AuthTokenPurpose): Promise<User> {
    const tokenHash = hashToken(rawToken);
    return this.authTokenRepo.manager.transaction(async (manager) => {
      const authToken = await manager
        .createQueryBuilder(AuthToken, 't')
        .setLock('pessimistic_write')
        .where('t.token_hash = :tokenHash', { tokenHash })
        .andWhere('t.purpose = :purpose', { purpose })
        .andWhere('t.used_at IS NULL')
        .andWhere('t.expires_at > NOW()')
        .getOne();

      if (!authToken) {
        throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'This link is invalid or has expired');
      }

      const user = await manager.findOne(User, { where: { id: authToken.userId } });
      if (!user) {
        throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'This link is invalid or has expired');
      }

      authToken.usedAt = new Date();
      await manager.save(authToken);

      return user;
    });
  }

  private async registerFailedAttempt(user: User): Promise<void> {
    user.failedLogins += 1;
    if (user.failedLogins >= 10) {
      user.isLocked = true;
    }
    await this.userRepo.save(user);

    if (user.isLocked) {
      await this.sessionRepo
        .createQueryBuilder()
        .update(Session)
        .set({ revokedAt: () => 'CURRENT_TIMESTAMP(3)' })
        .where('user_id = :userId', { userId: user.id })
        .andWhere('revoked_at IS NULL')
        .execute();
    }
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
