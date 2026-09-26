import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type EntityManager } from 'typeorm';
import type { Response } from 'express';
import { ApplicantSession } from '../database/entities/applicant-session.entity.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { clearSessionCookieOptions, sessionCookieOptions } from './cookie-options.js';
import { generateSessionToken, hashToken } from './session-token.util.js';
import { computeCsrfToken } from './csrf.util.js';
import type { RequestContext } from '../common/request-context.js';

export interface MintedApplicantSession {
  token: string;
  csrfToken: string;
  sessionId: string;
}

/**
 * Mints and revokes `applicant_sessions` rows / the `sf_app_sid` cookie —
 * the exact same token/hash/CSRF mechanics `AuthController`'s staff login
 * uses (session-token.util.ts, csrf.util.ts), just against the separate
 * applicant table and cookie name (Safeer infra change §2). Shared by
 * `ApplicationsService` (start-application) and the portal's OTP-verify
 * flow (phase 6) so both places that ever mint an applicant session do it
 * identically — including the cookie attributes, which must match the
 * staff cookie's (httpOnly, secure in prod, sameSite strict, path `/`)
 * exactly per the plan.
 *
 * `mint()` always takes the caller's transaction `EntityManager` rather
 * than an injected repository: both current callers mint a session as one
 * step of a larger transaction (create-application: counter + application
 * + session + event; verify-otp: lock the OTP row + consume it + mint the
 * session) and a session written outside that transaction could commit
 * even if a later step in the same flow rolled back.
 */
@Injectable()
export class ApplicantSessionService {
  constructor(
    @InjectRepository(ApplicantSession) private readonly repo: Repository<ApplicantSession>,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async mint(manager: EntityManager, applicationId: string, req: RequestContext): Promise<MintedApplicantSession> {
    const token = generateSessionToken();
    const tokenHash = hashToken(token);
    const now = Date.now();
    const session = manager.create(ApplicantSession, {
      applicationId,
      tokenHash,
      expiresAt: new Date(now + this.env.APPLICANT_SESSION_ABSOLUTE_DAYS * 24 * 60 * 60 * 1000),
      lastSeenAt: new Date(now),
      userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 255) ?? null,
      ipHash: req.ipHash ?? null,
    });
    const saved = await manager.save(session);
    return {
      token,
      csrfToken: computeCsrfToken(this.env.APP_ENCRYPTION_KEY, tokenHash),
      sessionId: saved.id,
    };
  }

  /** Non-transactional: logout has nothing else to coordinate with. */
  async revoke(sessionId: string): Promise<void> {
    await this.repo.update(sessionId, { revokedAt: new Date() });
  }

  setCookie(res: Response, token: string): void {
    res.cookie(this.env.APPLICANT_SESSION_COOKIE_NAME, token, sessionCookieOptions(this.env, this.env.APPLICANT_SESSION_ABSOLUTE_DAYS * 24 * 60 * 60 * 1000));
  }

  clearCookie(res: Response): void {
    res.clearCookie(this.env.APPLICANT_SESSION_COOKIE_NAME, clearSessionCookieOptions(this.env));
  }
}
