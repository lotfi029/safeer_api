import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomInt } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import { Application, NON_TERMINAL_APPLICATION_STATUSES } from '../database/entities/application.entity.js';
import { ApplicantOtp, type ApplicantOtpChannel } from '../database/entities/applicant-otp.entity.js';
import { MAIL_SERVICE, type MailServiceInterface } from '../mail/mail.service.interface.js';
import { SMS_SERVICE, type SmsServiceInterface } from '../sms/sms.service.interface.js';
import { hashToken } from '../auth/session-token.util.js';
import { ApplicantSessionService, type MintedApplicantSession } from '../auth/applicant-session.service.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { RequestContext } from '../common/request-context.js';
import { normalizePhone } from '../common/phone.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';

const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

/** `applications.reference` shape, e.g. `SA-2026-00185` (ApplicationsService.create). */
const REFERENCE_RE = /^[A-Z]{1,10}-\d{4}-\d{5}$/i;

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
export type RequestedOtpChannel = 'sms' | 'email' | undefined;

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
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * `POST portal/auth/request-otp` — always resolves `{ ok: true }` (mirrors
   * `AuthService.forgotPassword`'s non-enumeration pattern exactly: the
   * identifier's existence is never revealed). The per-identifier rate
   * limit is checked and incremented regardless of whether the identifier
   * matches anything — a bogus reference is just as capable of triggering a
   * 429 as a real one, which is itself non-enumerating (both a hit and a
   * miss consume the same counter the same way).
   *
   * B1 (safeer-backend-fr-review.md): `channelHint` in the response names
   * the channel the request *would* use — the caller's own `channel` if
   * given, otherwise the association-wide default — computed the same way
   * whether or not `identifier` matches an application, so it never
   * enumerates. It is not a guarantee: SMS silently falls back to email
   * per-application when the phone is missing or the send fails (see
   * `resolveChannel`/`deliver` below).
   */
  async requestOtp(identifier: string, channel?: RequestedOtpChannel): Promise<{ ok: true; channelHint: 'sms' | 'email' }> {
    this.checkRequestRateLimit(identifier);

    const channelHint = channel ?? (await this.defaultChannelHint());

    const application = await this.findApplication(identifier);
    if (!application) {
      return { ok: true, channelHint };
    }

    const code = String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
    const vars = { code, minutes: String(OTP_EXPIRY_MINUTES) };
    const entity = { type: 'applications', id: application.id };
    const usedChannel = await this.deliver(application, channel, vars, entity);

    await this.otpRepo.save(
      this.otpRepo.create({
        applicationId: application.id,
        codeHash: hashToken(code),
        channel: usedChannel,
        expiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
        attempts: 0,
      }),
    );

    return { ok: true, channelHint };
  }

  /**
   * Sends the code and returns the channel actually used, stored on the
   * `applicant_otps` row. SMS is only attempted when it's "usable" — a real
   * driver is configured, or the `log` driver outside production (so local
   * development/CI, which seed the `log` driver, still exercise the SMS
   * path) — and the application has a phone. Every other case, and any SMS
   * send that doesn't come back `sent`, falls back to email.
   */
  private async deliver(
    application: Application,
    requestedChannel: RequestedOtpChannel,
    vars: Record<string, string>,
    entity: { type: string; id: string },
  ): Promise<ApplicantOtpChannel> {
    if (requestedChannel !== 'email') {
      const smsUsable = (await this.smsUsable()) && Boolean(application.phone);
      if (smsUsable) {
        const result = await this.smsService.send({
          key: 'otp_code',
          to: application.phone ?? '',
          vars,
          locale: application.locale,
          entity,
        });
        if (result.status === 'sent') {
          return 'sms';
        }
        // Fall through to email — a chosen-but-failed SMS must still reach the applicant.
      }
    }

    await this.mailService.send({ key: 'otp_code', to: application.email ?? '', vars, locale: application.locale, entity });
    return 'email';
  }

  /** SMS is worth attempting: a real driver, or `log` outside production. */
  private async smsUsable(): Promise<boolean> {
    const availability = await this.smsService.availability();
    if (availability === 'real') return true;
    if (availability === 'log') return this.env.NODE_ENV !== 'production';
    return false;
  }

  /** The channel `channelHint` reports when the caller doesn't pick one — depends only on settings, never on the identifier. */
  private async defaultChannelHint(): Promise<'sms' | 'email'> {
    return (await this.smsService.availability()) === 'real' ? 'sms' : 'email';
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

  /**
   * B2 (safeer-backend-fr-review.md): a reference (`SA-2026-00185`), an
   * email, or a phone number (normalised to E.164, `+966` default country
   * code) — each resolves to *at most one* application. For email/phone,
   * several applications can share the same contact detail (nothing
   * prevents that beyond B2's own new-application check), so this always
   * prefers the most recent non-terminal one, falling back to the most
   * recent application overall when none is non-terminal — never an
   * arbitrary row.
   */
  private findApplication(identifier: string): Promise<Application | null> {
    const trimmed = identifier.trim();
    const qb = this.applicationRepo.createQueryBuilder('a');

    if (REFERENCE_RE.test(trimmed)) {
      qb.where('UPPER(a.reference) = UPPER(:identifier)', { identifier: trimmed });
    } else if (trimmed.includes('@')) {
      qb.where('LOWER(a.email) = LOWER(:identifier)', { identifier: trimmed });
    } else {
      const phone = normalizePhone(trimmed);
      if (!phone) {
        return Promise.resolve(null);
      }
      qb.where('a.phone_e164 = :phone', { phone });
    }

    return qb
      .addSelect(
        `CASE WHEN a.status IN (:...nonTerminal) THEN 0 ELSE 1 END`,
        'is_terminal',
      )
      .setParameter('nonTerminal', NON_TERMINAL_APPLICATION_STATUSES)
      .orderBy('is_terminal', 'ASC')
      .addOrderBy('a.created_at', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .getOne();
  }

  /**
   * The rate-limit key is normalised the same way `findApplication` resolves
   * an identifier, so `05XXXXXXXX` and `+9665XXXXXXXX` (the same phone,
   * differently formatted) share one counter instead of doubling the
   * effective limit.
   */
  private checkRequestRateLimit(identifier: string): void {
    const trimmed = identifier.trim();
    const key = (REFERENCE_RE.test(trimmed) || trimmed.includes('@') ? trimmed : normalizePhone(trimmed)) ?? trimmed;
    const normalizedKey = key.toLowerCase();
    const attempts = this.requestAttempts.get(normalizedKey) ?? 0;
    if (attempts >= OTP_REQUEST_LIMIT) {
      throw new ProblemException(429, ErrorCode.RATE_LIMITED, 'Too many verification code requests — try again shortly');
    }
    this.requestAttempts.set(normalizedKey, attempts + 1);
  }
}
