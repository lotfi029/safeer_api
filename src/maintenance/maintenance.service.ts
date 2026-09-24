import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Session } from '../database/entities/session.entity.js';
import { AuthToken } from '../database/entities/auth-token.entity.js';
import { MailLog } from '../database/entities/mail-log.entity.js';

const MAIL_LOG_RETENTION_DAYS = 90;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * The nightly retention sweep, kept as several small private steps, each
 * independently try/caught, so one failing step (a locked table, ...)
 * never stops the others from running the same night.
 *
 * TODO(phase 4+/6+): african_api's equivalent also purges old
 * contact_messages rows (24-month retention) and runs a nightly
 * library-link availability check via oEmbed. Add the contact_messages
 * purge back once the Contact module and its entity land; Safeer has no
 * library-style external-link content, so that check is not being ported
 * at all.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);
  private running = false;

  constructor(
    @InjectRepository(Session) private readonly sessionRepo: Repository<Session>,
    @InjectRepository(AuthToken) private readonly authTokenRepo: Repository<AuthToken>,
    @InjectRepository(MailLog) private readonly mailLogRepo: Repository<MailLog>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runNightlyJob(): Promise<void> {
    // Overlap guard, same shape as mail.service.ts's sweepRetries.
    if (this.running) {
      this.logger.warn('Nightly job still running from a previous trigger — skipping this run');
      return;
    }
    this.running = true;
    try {
      await this.purgeExpiredSessions();
      await this.purgeSpentAuthTokens();
      await this.purgeOldMailLog();
    } finally {
      this.running = false;
    }
  }

  private async purgeExpiredSessions(): Promise<void> {
    try {
      // A session is safely purgeable once it can never validate again —
      // either past its absolute expiry, or explicitly revoked (a logout,
      // a password change, an admin lock) — regardless of which happened.
      const result = await this.sessionRepo
        .createQueryBuilder()
        .delete()
        .where('expires_at < :now', { now: new Date() })
        .orWhere('revoked_at IS NOT NULL')
        .execute();
      this.logger.log(`Purged ${result.affected ?? 0} dead session(s)`);
    } catch (err) {
      this.logger.error('Failed to purge expired sessions', err instanceof Error ? err.stack : String(err));
    }
  }

  private async purgeSpentAuthTokens(): Promise<void> {
    try {
      const result = await this.authTokenRepo
        .createQueryBuilder()
        .delete()
        .where('used_at IS NOT NULL')
        .orWhere('expires_at < :now', { now: new Date() })
        .execute();
      this.logger.log(`Purged ${result.affected ?? 0} spent/expired auth token(s)`);
    } catch (err) {
      this.logger.error('Failed to purge spent auth tokens', err instanceof Error ? err.stack : String(err));
    }
  }

  /** mail_log is purged after 90 days. */
  private async purgeOldMailLog(): Promise<void> {
    try {
      const result = await this.mailLogRepo.delete({ createdAt: LessThan(daysAgo(MAIL_LOG_RETENTION_DAYS)) });
      this.logger.log(`Purged ${result.affected ?? 0} mail_log row(s) older than ${MAIL_LOG_RETENTION_DAYS} days`);
    } catch (err) {
      this.logger.error('Failed to purge old mail_log rows', err instanceof Error ? err.stack : String(err));
    }
  }
}
