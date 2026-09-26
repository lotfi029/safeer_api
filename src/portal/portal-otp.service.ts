import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
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
import { OtpPeekService } from '../dev/otp-peek.service.js';
import { BackgroundWork } from '../common/background/background-work.service.js';

const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
/** A1: wrong codes inside a rolling hour before OTP sign-in locks for OTP_LOCK_MINUTES. */
const OTP_HOURLY_FAILURE_LIMIT = 10;
const OTP_LOCK_MINUTES = 60;
/** A1: wrong codes per application per UTC day before OTP sign-in locks until the next day. */
const OTP_DAILY_FAILURE_LIMIT = 30;

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

/** A4: the BackgroundWork queue every request-otp lookup runs on, in arrival order. */
const OTP_LOOKUP_QUEUE = 'otp:lookup';

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
    private readonly otpPeek: OtpPeekService,
    private readonly background: BackgroundWork,
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
   * `smsRecipient`/`deliver` below).
   *
   * A4 (safeer-delivery-review.md): the response goes out before the
   * identifier is even looked up. Only the per-identifier limiter (the same
   * for a hit and a miss) and the settings-only `channelHint` run first;
   * the lookup, the `applicant_otps` row and the send (up to 5 s for an SMS,
   * then the email fallback) run afterwards on BackgroundWork. Awaiting them
   * made a matching identifier measurably slower to answer than a miss.
   *
   * Ordering: every lookup runs on one queue (`otp:lookup`, a few ms each),
   * and each application's codes are then issued on their own queue
   * (`otp:<applicationId>`) — insert, send, record — one after another.
   * Two quick requests for one application are issued in the order they
   * arrived, and the last code delivered is always the live one.
   */
  async requestOtp(identifier: string, channel?: RequestedOtpChannel): Promise<{ ok: true; channelHint: 'sms' | 'email' }> {
    this.checkRequestRateLimit(identifier);

    const channelHint = channel ?? (await this.defaultChannelHint());

    this.background.run('otp lookup', () => this.queueIssue(identifier, channel), OTP_LOOKUP_QUEUE);
    return { ok: true, channelHint };
  }

  /** A4: resolves the identifier and, if a code should go out, queues it on the application's own queue. */
  private async queueIssue(identifier: string, channel: RequestedOtpChannel): Promise<void> {
    const application = await this.findApplication(identifier);
    // C22: every silent stop below is invisible to the caller (who already
    // has the same `{ ok: true }` a miss gets): no application, the
    // per-application request budget spent (whichever identifier named it),
    // or OTP sign-in locked after too many wrong codes (A1).
    if (!application || !this.takeApplicationRequestSlot(application.id) || (await this.isLocked(application.id))) {
      return;
    }
    this.background.run('otp send', () => this.issue(application, channel), `otp:${application.id}`);
  }

  /**
   * One code for one application. The row is written (and every older live
   * code invalidated — C22) and committed before anything is sent (B1), so
   * a code the applicant receives always exists to be verified.
   */
  private async issue(application: Application, channel: RequestedOtpChannel): Promise<void> {
    const code = String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
    const smsTo = await this.smsRecipient(application, channel);
    const plannedChannel: ApplicantOtpChannel = smsTo ? 'sms' : 'email';

    const otp = await this.otpRepo.manager.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .update(ApplicantOtp)
        .set({ consumedAt: () => 'CURRENT_TIMESTAMP(3)' })
        .where('application_id = :id', { id: application.id })
        .andWhere('consumed_at IS NULL')
        .execute();
      return manager.save(
        manager.create(ApplicantOtp, {
          applicationId: application.id,
          codeHash: hashToken(code),
          channel: plannedChannel,
          expiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
          attempts: 0,
        }),
      );
    });

    const usedChannel = await this.deliver(application, smsTo, code);
    if (usedChannel !== plannedChannel) {
      await this.otpRepo.update(otp.id, { channel: usedChannel });
    }
    this.otpPeek.record(application.id, code, usedChannel);
  }

  /**
   * The E.164 number to try by SMS first, or null to go straight to email:
   * SMS is only attempted when the caller didn't ask for email, SMS is
   * "usable" (a real driver, or the `log` driver outside production, so
   * local development/CI still exercise the SMS path) and the application
   * has a phone.
   */
  private async smsRecipient(application: Application, requestedChannel: RequestedOtpChannel): Promise<string | null> {
    if (requestedChannel === 'email') return null;
    const to = application.phoneE164 ?? normalizePhone(application.phone);
    if (!to || !(await this.smsUsable())) return null;
    return to;
  }

  /**
   * Sends the code and returns the channel actually used (stored on the
   * `applicant_otps` row). An SMS that doesn't come back `sent` — failed,
   * skipped, or timed out after 5 s — falls back to email (B1). The code is
   * a sensitive variable: masked in `sms_log` / `mail_log` (C1).
   */
  private async deliver(application: Application, smsTo: string | null, code: string): Promise<ApplicantOtpChannel> {
    const vars = { code, minutes: String(OTP_EXPIRY_MINUTES) };
    const entity = { type: 'applications', id: application.id };
    const sensitiveVars = ['code'];

    if (smsTo) {
      const result = await this.smsService.sendNow({
        key: 'otp_code',
        to: smsTo,
        vars,
        locale: application.locale,
        entity,
        sensitiveVars,
      });
      if (result.status === 'sent') {
        return 'sms';
      }
    }

    // A4: wait for the SMTP attempt itself, so this application's queue
    // (BackgroundWork) orders real deliveries and a shutdown drains them.
    await this.mailService.send({
      key: 'otp_code',
      to: application.email ?? '',
      vars,
      locale: application.locale,
      entity,
      sensitiveVars,
      awaitDelivery: true,
    });
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
    if (!application || (await this.isLocked(application.id))) {
      throw genericOtpError();
    }

    // The transaction's callback must never throw on a *wrong* code: a
    // thrown error rolls back everything the callback did, including the
    // `attempts` and daily-failure increments we specifically need to
    // survive so the caps are real. So the callback always returns normally
    // — a tagged outcome — and only the caller, after the transaction has
    // committed, decides whether to throw `genericOtpError()`.
    const outcome = await this.otpRepo.manager.transaction(async (manager) => {
      const otp = await manager
        .createQueryBuilder(ApplicantOtp, 'o')
        .setLock('pessimistic_write')
        .where('o.application_id = :id', { id: application.id })
        .andWhere('o.consumed_at IS NULL')
        .andWhere('o.expires_at > NOW()')
        .orderBy('o.created_at', 'DESC')
        .addOrderBy('o.id', 'DESC')
        .getOne();

      if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS || hashToken(code) !== otp.codeHash) {
        if (otp) {
          // A1: only a guess actually checked against a live code counts
          // toward the lock. No code issued, or one whose 5 attempts are
          // spent, is not a guess — counting those let anyone who knew a
          // reference lock that applicant out without ever seeing a code.
          const guessed = otp.attempts < OTP_MAX_ATTEMPTS;
          otp.attempts += 1;
          await manager.save(otp);
          if (guessed) await this.recordFailure(manager, application.id);
        }
        return { ok: false as const };
      }

      otp.attempts += 1;
      otp.consumedAt = new Date();
      await manager.save(otp);
      await manager.query(
        'UPDATE applications SET otp_fail_count = 0, otp_hour_count = 0, otp_hour_start = NULL, otp_locked_until = NULL WHERE id = ?',
        [application.id],
      );

      const minted = await this.applicantSessions.mint(manager, application.id, req);
      return { ok: true as const, minted };
    });

    if (!outcome.ok) {
      throw genericOtpError();
    }
    return outcome.minted;
  }

  /**
   * C22 + A1: one more wrong code. One atomic UPDATE; assignment order
   * matters — SET runs left to right, each assignment seeing the previous
   * ones (utc.ts keeps MariaDB's SIMULTANEOUS_ASSIGNMENT off):
   *
   * 1. The UTC-day count, computed against the *old* date before the date
   *    moves to today.
   * 2. The rolling-hour window: a new window (count 1, starting now) when
   *    there is none or it is over an hour old, otherwise one more.
   * 3. At OTP_HOURLY_FAILURE_LIMIT, lock for OTP_LOCK_MINUTES and close the
   *    window.
   */
  private async recordFailure(manager: EntityManager, applicationId: string): Promise<void> {
    await manager.query(
      `UPDATE applications
          SET otp_fail_count = IF(otp_fail_date = UTC_DATE(), otp_fail_count + 1, 1),
              otp_fail_date = UTC_DATE(),
              otp_hour_count = IF(otp_hour_start > UTC_TIMESTAMP(3) - INTERVAL 1 HOUR, otp_hour_count + 1, 1),
              otp_hour_start = IF(otp_hour_count = 1, UTC_TIMESTAMP(3), otp_hour_start),
              otp_locked_until = IF(otp_hour_count >= ?, UTC_TIMESTAMP(3) + INTERVAL ? MINUTE, otp_locked_until),
              otp_hour_start = IF(otp_hour_count >= ?, NULL, otp_hour_start),
              otp_hour_count = IF(otp_hour_count >= ?, 0, otp_hour_count)
        WHERE id = ?`,
      [OTP_HOURLY_FAILURE_LIMIT, OTP_LOCK_MINUTES, OTP_HOURLY_FAILURE_LIMIT, OTP_HOURLY_FAILURE_LIMIT, applicationId],
    );
  }

  /**
   * A1: OTP sign-in is locked for OTP_LOCK_MINUTES after
   * OTP_HOURLY_FAILURE_LIMIT wrong codes inside an hour, and for the rest of
   * the UTC day after OTP_DAILY_FAILURE_LIMIT.
   */
  private async isLocked(applicationId: string): Promise<boolean> {
    const rows: Array<{ locked: number | string | null }> = await this.applicationRepo.query(
      `SELECT (otp_locked_until > UTC_TIMESTAMP(3) OR (otp_fail_date = UTC_DATE() AND otp_fail_count >= ?)) AS locked
         FROM applications WHERE id = ?`,
      [OTP_DAILY_FAILURE_LIMIT, applicationId],
    );
    return Number(rows[0]?.locked) === 1;
  }

  /**
   * C22: the per-identifier limiter can't see that a reference, an email and
   * a phone all name the same application, so each application also gets
   * its own budget of OTP_REQUEST_LIMIT codes per window, whichever way it
   * was named. Returns false (send nothing) once it's spent.
   */
  private takeApplicationRequestSlot(applicationId: string): boolean {
    const key = `application:${applicationId}`;
    const count = this.requestAttempts.get(key) ?? 0;
    if (count >= OTP_REQUEST_LIMIT) return false;
    this.requestAttempts.set(key, count + 1);
    return true;
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

    // C43: plain `=` — the columns' utf8mb4_unicode_ci collation already
    // compares case-insensitively, and UPPER()/LOWER() would stop MySQL from
    // using uq reference / ix_applications_email_status on this public route.
    if (REFERENCE_RE.test(trimmed)) {
      qb.where('a.reference = :identifier', { identifier: trimmed });
    } else if (trimmed.includes('@')) {
      qb.where('a.email = :identifier', { identifier: trimmed });
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
