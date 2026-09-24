import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomInt } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import { Application } from '../database/entities/application.entity.js';
import { ApplicantOtp } from '../database/entities/applicant-otp.entity.js';
import { MAIL_SERVICE, type MailServiceInterface } from '../mail/mail.service.interface.js';
import { SMS_SERVICE, type SmsServiceInterface } from '../sms/sms.service.interface.js';
import { hashToken } from '../auth/session-token.util.js';
import { ApplicantSessionService, type MintedApplicantSession } from '../auth/applicant-session.service.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { RequestContext } from '../common/request-context.js';

const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

/**
 * Tighter than AuthService's login limiter (5/60s): a hit here triggers a
 * real SMS or email send, which costs money/provider quota, unlike a free
 * password re-check. 5 requests per 15 minutes per identifier — generous
 * enough for a genuine user who fat-fingered a request, tight enough that
 * flooding one reference/email is not a free way to run up an SMS bill.
 * Layered on top of (not instead of) the route's own 5/hour/IP `@Throttle`.
 */
const OTP_REQUEST_LIMIT = 5;
const OTP_REQUEST_WINDOW_MS = 15 * 60 * 1000;
const OTP_REQUEST_MAX_TRACKED = 10_000;

export type VerifyOtpResult = MintedApplicantSession;

function genericOtpError(): ProblemException {
  // FR-A-10-style non-enumeration (mirrors AuthService.login's B1 fix):
  // "no matching application", "no live OTP row", "expired", "too many
  // attempts" and "wrong code" must all be indistinguishable from outside.
  return new ProblemException(401, ErrorCode.OTP_INVALID, 'Invalid or expired verification code');
}

@Injectable()
export class PortalOtpService {
  private readonly requestAttempts = new LRUCache<string, number>({
    max: OTP_REQUEST_MAX_TRACKED,
    ttl: OTP_REQUEST_WINDOW_MS,
  });

  constructor(
    @InjectRepository(Application) private readonly applicationRepo: Repository<Application>,
    @InjectRepository(ApplicantOtp) private readonly otpRepo: Repository<ApplicantOtp>,
    @Inject(MAIL_SERVICE) private readonly mailService: MailServiceInterface,
    @Inject(SMS_SERVICE) private readonly smsService: SmsServiceInterface,
    private readonly applicantSessions: ApplicantSessionService,
  ) {}

  /**
   * `POST portal/auth/request-otp` — always resolves `{ ok: true }`
   * (mirrors `AuthService.forgotPassword`'s non-enumeration pattern
   * exactly: the identifier's existence is never revealed). The
   * per-identifier rate limit is checked and incremented regardless of
   * whether the identifier matches anything — a bogus reference is just as
   * capable of triggering a 429 as a real one, which is itself
   * non-enumerating (both a hit and a miss consume the same counter the
   * same way).
   */
  async requestOtp(identifier: string): Promise<{ ok: true }> {
    this.checkRequestRateLimit(identifier);

    const application = await this.findApplication(identifier);
    if (!application) {
      return { ok: true };
    }

    const code = String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
    const channel = application.phone ? 'sms' : 'email';

    await this.otpRepo.save(
      this.otpRepo.create({
        applicationId: application.id,
        codeHash: hashToken(code),
        channel,
        expiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
        attempts: 0,
      }),
    );

    const vars = { code, minutes: String(OTP_EXPIRY_MINUTES) };
    const entity = { type: 'applications', id: application.id };
    if (channel === 'sms') {
      await this.smsService.send({ key: 'otp_code', to: application.phone ?? '', vars, locale: application.locale, entity });
    } else {
      await this.mailService.send({ key: 'otp_code', to: application.email ?? '', vars, locale: application.locale, entity });
    }

    return { ok: true };
  }

  /**
   * `POST portal/auth/verify-otp` — one generic `OTP_INVALID` (401) for
   * every failure branch (no such application, no live OTP row, expired,
   * attempts already exhausted, wrong code). The attempt cap is enforced
   * *before* comparing the supplied code — once `attempts` reaches
   * `OTP_MAX_ATTEMPTS`, a 6th call is rejected even if it finally supplies
   * the right code, per the plan. The whole read-check-increment sequence
   * runs under `pessimistic_write` on the OTP row so two concurrent guesses
   * against the same code can't both slip in under the cap.
   */
  async verifyOtp(identifier: string, code: string, req: RequestContext): Promise<VerifyOtpResult> {
    const application = await this.findApplication(identifier);
    if (!application) {
      throw genericOtpError();
    }

    // The transaction's callback must never throw on a *wrong* code: a
    // thrown error rolls back everything the callback did, including the
    // `attempts` increment we specifically need to survive so the 5-guess
    // cap is real. So the callback always returns normally — a tagged
    // outcome — and only the caller, after the transaction has committed,
    // decides whether to throw `genericOtpError()`. An application that
    // doesn't exist at all, or has no live OTP row, never reaches the
    // transaction in the first place, so nothing needs recording for those.
    const outcome = await this.otpRepo.manager.transaction(async (manager) => {
      const otp = await manager
        .createQueryBuilder(ApplicantOtp, 'o')
        .setLock('pessimistic_write')
        .where('o.application_id = :id', { id: application.id })
        .andWhere('o.consumed_at IS NULL')
        .andWhere('o.expires_at > NOW()')
        .orderBy('o.created_at', 'DESC')
        .getOne();

      if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) {
        return { ok: false as const };
      }

      if (hashToken(code) !== otp.codeHash) {
        otp.attempts += 1;
        await manager.save(otp);
        return { ok: false as const };
      }

      otp.attempts += 1;
      otp.consumedAt = new Date();
      await manager.save(otp);

      const minted = await this.applicantSessions.mint(manager, application.id, req);
      return { ok: true as const, minted };
    });

    if (!outcome.ok) {
      throw genericOtpError();
    }
    return outcome.minted;
  }

  /** A reference (`SA-2026-00185`) or an email — either resolves to at most one application. */
  private findApplication(identifier: string): Promise<Application | null> {
    const trimmed = identifier.trim();
    return this.applicationRepo
      .createQueryBuilder('a')
      .where('UPPER(a.reference) = UPPER(:identifier)', { identifier: trimmed })
      .orWhere('LOWER(a.email) = LOWER(:identifier)', { identifier: trimmed })
      .getOne();
  }

  private checkRequestRateLimit(identifier: string): void {
    const key = identifier.trim().toLowerCase();
    const attempts = this.requestAttempts.get(key) ?? 0;
    if (attempts >= OTP_REQUEST_LIMIT) {
      throw new ProblemException(429, ErrorCode.RATE_LIMITED, 'Too many verification code requests — try again shortly');
    }
    this.requestAttempts.set(key, attempts + 1);
  }
}
