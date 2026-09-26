import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { MailLog, type MailLogStatus } from '../database/entities/mail-log.entity.js';
import { MailSettings } from '../database/entities/mail-settings.entity.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { MailServiceInterface, SendMailParams } from './mail.service.interface.js';
import { MailTemplatesService, type RenderedMail } from './mail-templates.service.js';
import { MailTransportService } from './mail-transport.service.js';
import { maskVars } from '../common/sensitive-vars.js';

// FR-E-09: "retried three times with increasing delay" — read as 3 retries
// after the first try, i.e. 4 attempts total, with the gap before each of
// the 3 retries drawn from this list.
const RETRY_DELAYS_MINUTES = [1, 5, 15];
const MAX_ATTEMPTS = 1 + RETRY_DELAYS_MINUTES.length;

const MAX_PENDING = 500;
/** A4: the longest `send({ awaitDelivery: true })` waits for its SMTP attempt. */
const AWAIT_DELIVERY_MAX_MS = 8_000;

interface PendingDelivery {
  rendered: RenderedMail;
  nextRetryAt: number | null; // epoch ms; null = not scheduled (due now, or terminal)
  terminal: boolean;
}

/**
 * The real, queue-backed MailService (13-backend-build-plan.md P10 step 4),
 * replacing the P6 no-op binding — see mail.module.ts.
 *
 * I-6: `mail_log.payload` holds the rendered subject/html/text, so a retry
 * survives a process restart — the database, not the in-process `pending`
 * map, is the source of truth for what's still deliverable. This matters
 * for `user_invite` / `password_reset` specifically: the link contains a
 * one-time token, and `auth_tokens` stores only `token_hash`
 * (session-token pattern), so the plaintext link is unrecoverable any other
 * way once `send()` returns. `pending` is now just a read-through cache —
 * still consulted first so a normal retry within the same process doesn't
 * pay for a round-trip it doesn't need — and `payload` is nulled the moment
 * a row reaches `sent` or terminal `failed`, so a reset link doesn't sit in
 * the database for the log's full 90-day life, only the ≤21-minute retry
 * window (1 + 5 + 15).
 */
@Injectable()
export class MailService implements MailServiceInterface {
  private readonly logger = new Logger(MailService.name);
  private readonly pending = new Map<string, PendingDelivery>();
  private sweeping = false;

  constructor(
    @InjectRepository(MailLog) private readonly logRepo: Repository<MailLog>,
    @InjectRepository(MailSettings) private readonly settingsRepo: Repository<MailSettings>,
    private readonly templates: MailTemplatesService,
    private readonly transport: MailTransportService,
  ) {}

  /**
   * Writes a `mail_log` row and returns — never awaits delivery (unless the
   * caller asks with `awaitDelivery`, A4), never throws into the caller (trap 13). `is_enabled = 0` (globally, or the
   * specific template disabled) writes the row `skipped` and sends nothing
   * (FR-E-04).
   *
   * 30-backend-finishing-prompt.md §2.4 (task 4): an empty `params.to` is
   * its own `skipped` cause, distinct from mail being disabled or the
   * template failing to render, with `error` naming *why* there was no
   * recipient — otherwise this row would be indistinguishable from any
   * other `skipped` row once written. Written generically (`!params.to`)
   * rather than by template key: the only caller that can reach this today
   * is `contact.service.ts`'s `contact_notify` with
   * `mail_settings.notify_email` unset, but the gap this closes is "a
   * caller forgot to check its own recipient", which isn't specific to
   * that one template.
   */
  async send(params: SendMailParams): Promise<void> {
    try {
      const settings = await this.settingsRepo.findOne({ where: { id: '1' } });
      const rendered = await this.templates.render(params.key, params.vars, params.locale);
      const sensitive = Boolean(params.sensitiveVars?.length);
      const loggable = sensitive
        ? await this.templates.render(params.key, maskVars(params.vars, params.sensitiveVars), params.locale)
        : rendered;
      const missingRecipient = !params.to;
      const status: MailLogStatus = missingRecipient || !settings?.isEnabled || !rendered ? 'skipped' : 'queued';

      const saved = await this.logRepo.save(
        this.logRepo.create({
          templateKey: params.key,
          locale: params.locale,
          toEmail: params.to,
          subject: loggable?.subject ?? params.key,
          status,
          error: missingRecipient
            ? 'No recipient email address was configured (e.g. mail_settings.notify_email is unset for contact_notify)'
            : null,
          entityType: params.entity?.type ?? null,
          entityId: params.entity?.id ?? null,
          // C1: never persist a rendering that carries a sensitive value.
          payload: status === 'queued' && rendered && !sensitive ? rendered : null,
        }),
      );

      if (status === 'queued' && rendered) {
        this.evictIfAtCapacity();
        this.pending.set(saved.id, { rendered, nextRetryAt: null, terminal: false });
        if (params.awaitDelivery) {
          // Bounded: SMTP has no timeout of its own short of minutes. Past
          // this, the attempt carries on unawaited, as for any other mail.
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([
            this.attemptDelivery(saved.id),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, AWAIT_DELIVERY_MAX_MS);
            }),
          ]);
          clearTimeout(timer);
        } else {
          void this.attemptDelivery(saved.id);
        }
      }
    } catch (err) {
      this.logger.error('MailService.send failed', err instanceof Error ? err.stack : String(err));
    }
  }

  /**
   * One delivery attempt for `logId` — called immediately on queue, and
   * again by the 30 s retry sweep, both without an `await` on this method's
   * return (fire-and-forget from `send()`; `sweepRetries` awaits it inside a
   * loop with no per-iteration catch). I-3: the whole body is guarded, not
   * just the `sendMail` call — `getTransporter()` decrypts `APP_ENCRYPTION_KEY`
   * (trap 10) and can throw on a bad key or corrupted ciphertext, which must
   * log and stop this delivery, not crash the process.
   */
  private async attemptDelivery(logId: string): Promise<void> {
    try {
      const row = await this.logRepo.findOne({ where: { id: logId } });
      if (!row || row.status === 'sent') {
        this.pending.delete(logId);
        return;
      }

      // I-6: prefer the in-process cache (avoids re-parsing JSON on the hot
      // path), fall back to `row.payload` — the case that matters is this
      // process never had a `pending` entry for this row at all, because it
      // started after `send()` ran in a previous process.
      const rendered: RenderedMail | null = this.pending.get(logId)?.rendered ?? row.payload;
      if (!rendered) {
        // Nothing left to send with: already terminal and payload cleared,
        // never queued in the first place, or (C1) a sensitive mail whose
        // content was only ever held in a previous process's memory. Make a
        // non-terminal row terminal so the retry sweep stops picking it up.
        if (row.status === 'queued' || (row.status === 'failed' && row.nextRetryAt)) {
          await this.logRepo.update(logId, {
            status: 'failed',
            nextRetryAt: null,
            error: 'Content no longer available to retry (not stored for sensitive mail); re-trigger the original action',
          });
        }
        return;
      }
      if (!this.pending.has(logId)) {
        // Recovered from `row.payload` after a restart — re-seed the cache
        // so `recordFailure` below (and any later retry within this
        // process) doesn't have to round-trip to the database again.
        this.evictIfAtCapacity();
        this.pending.set(logId, { rendered, nextRetryAt: null, terminal: false });
      }

      const { transporter, settings } = await this.transport.getTransporter();
      const attempts = row.attempts + 1;

      if (!transporter) {
        await this.recordFailure(logId, attempts, 'SMTP is not configured', true);
        return;
      }

      try {
        await transporter.sendMail({
          from: this.transport.fromHeader(settings, row.locale),
          to: row.toEmail,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });
        await this.logRepo.update(logId, {
          status: 'sent',
          attempts,
          sentAt: new Date(),
          error: null,
          nextRetryAt: null,
          payload: null,
        });
        this.pending.delete(logId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.recordFailure(logId, attempts, message, false);
      }
    } catch (err) {
      this.logger.error(
        `attemptDelivery(${logId}) failed outside the send path`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  private async recordFailure(logId: string, attempts: number, error: string, forceTerminal: boolean): Promise<void> {
    const terminal = forceTerminal || attempts >= MAX_ATTEMPTS;
    const nextRetryAt = terminal ? null : new Date(Date.now() + RETRY_DELAYS_MINUTES[attempts - 1] * 60_000);

    // I-6: `payload` is nulled the moment the row goes terminal, same as on
    // a successful send — a permanently-failed row is no longer within the
    // ≤21-minute automatic retry window, and the whole point is to not let
    // a password-reset link's plaintext sit in the database indefinitely
    // waiting for an admin to notice and fix the SMTP config. The in-process
    // `pending` map (this process only) still keeps its copy regardless, so
    // `POST /admin/mail/log/:id/retry` keeps working for as long as this
    // process is alive; past a restart its own error message already tells
    // the admin the right move: re-trigger the original action.
    await this.logRepo.update(logId, {
      status: 'failed',
      attempts,
      error: error.slice(0, 1000),
      nextRetryAt,
      ...(terminal ? { payload: null } : {}),
    });

    const pending = this.pending.get(logId);
    if (pending) {
      pending.nextRetryAt = nextRetryAt?.getTime() ?? null;
      pending.terminal = terminal;
    }
  }

  /**
   * I-6: queries `mail_log` directly rather than only the in-process
   * `pending` map — a row that went `failed` in a previous process (one
   * that restarted before its retry window closed) has no `pending` entry
   * here at all, but does still have a non-null `payload` and a due
   * `next_retry_at`, and `attemptDelivery` now knows how to recover from
   * that.
   */
  @Interval(30_000)
  private async sweepRetries(): Promise<void> {
    if (this.sweeping) return; // a slow SMTP provider must not overlap sweeps
    this.sweeping = true;
    try {
      const due = await this.logRepo.find({
        where: { status: 'failed', nextRetryAt: LessThanOrEqual(new Date()) },
      });
      for (const row of due) {
        await this.attemptDelivery(row.id);
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** `POST /admin/mail/log/:id/retry` — re-attempts immediately, outside the normal backoff schedule. */
  async retryNow(logId: string): Promise<MailLog> {
    const row = await this.logRepo.findOne({ where: { id: logId } });
    if (!row) {
      throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Not found');
    }
    if (row.status === 'sent') {
      return row;
    }
    // I-6: durable across a restart within this process's own copy of
    // `pending`, or via `row.payload` if it isn't — the two failure modes
    // that leave neither are: evicted under memory pressure (MAX_PENDING)
    // in a still-running process, or a restart after the row already went
    // terminal (payload nulled the moment that happened — see recordFailure).
    if (!this.pending.has(logId) && !row.payload) {
      throw new ProblemException(
        400,
        ErrorCode.VALIDATION_FAILED,
        'This message can no longer be retried: its rendered content is gone (evicted under load, or the process restarted after this failure went terminal). Re-trigger the original action (resend the invite, resubmit the form, …) instead.',
      );
    }
    await this.attemptDelivery(logId);
    return (await this.logRepo.findOne({ where: { id: logId } }))!;
  }

  /** Bounded so a long-running process with many permanent failures can't grow this map forever. */
  private evictIfAtCapacity(): void {
    if (this.pending.size < MAX_PENDING) return;
    for (const [id, entry] of this.pending) {
      if (entry.terminal) {
        this.pending.delete(id);
        return;
      }
    }
  }
}
