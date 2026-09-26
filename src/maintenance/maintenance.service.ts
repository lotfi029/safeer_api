import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';
import { PrivateFileStore } from '../storage/private-file-store.service.js';
import { Session } from '../database/entities/session.entity.js';
import { AuthToken } from '../database/entities/auth-token.entity.js';
import { MailLog } from '../database/entities/mail-log.entity.js';
import { ApplicantSession } from '../database/entities/applicant-session.entity.js';
import { ApplicantOtp } from '../database/entities/applicant-otp.entity.js';

const MAIL_LOG_RETENTION_DAYS = 90;
/** C27 retention policy (docs/backend/DEPLOYMENT-HOSTINGER.md, "Retention"). */
const SMS_LOG_RETENTION_DAYS = 90;
const CONTACT_MESSAGE_RETENTION_DAYS = 730; // 24 months
const IDLE_DRAFT_RETENTION_DAYS = 180;
const NEWSLETTER_INACTIVE_RETENTION_DAYS = 30;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * The nightly retention sweep, kept as several small private steps, each
 * independently try/caught, so one failing step (a locked table, ...)
 * never stops the others from running the same night.
 *
 * C27 retention: contact messages after 24 months, sms_log after 90 days
 * (mail_log already), drafts idle for 180 days together with their private
 * files, and newsletter rows unsubscribed — or never confirmed — for 30 days.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);
  private running = false;

  constructor(
    @InjectRepository(Session) private readonly sessionRepo: Repository<Session>,
    @InjectRepository(AuthToken) private readonly authTokenRepo: Repository<AuthToken>,
    @InjectRepository(MailLog) private readonly mailLogRepo: Repository<MailLog>,
    @InjectRepository(ApplicantSession) private readonly applicantSessionRepo: Repository<ApplicantSession>,
    @InjectRepository(ApplicantOtp) private readonly applicantOtpRepo: Repository<ApplicantOtp>,
    private readonly dataSource: DataSource,
    private readonly fileStore: PrivateFileStore,
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
      await this.keepReplyDeliveryStatus();
      await this.purgeOldMailLog();
      await this.purgeOldSmsLog();
      await this.purgeOldContactMessages();
      await this.purgeIdleDrafts();
      await this.purgeInactiveNewsletterRows();
      await this.purgeExpiredApplicantSessions();
      await this.purgeSpentApplicantOtps();
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

  /**
   * C46: the 90-day mail_log purge nulls `message_replies.mail_log_id`
   * (ON DELETE SET NULL), which lost a reply's delivery outcome. Copy it
   * onto the reply first, for every row the purge is about to remove.
   */
  private async keepReplyDeliveryStatus(): Promise<void> {
    await this.step('copy reply delivery status', () =>
      this.dataSource.query(
        `UPDATE message_replies r JOIN mail_log m ON m.id = r.mail_log_id
            SET r.delivery_status = m.status
          WHERE m.created_at < ?`,
        [daysAgo(MAIL_LOG_RETENTION_DAYS)],
      ),
    );
  }

  private async purgeOldSmsLog(): Promise<void> {
    await this.step(`purge sms_log older than ${SMS_LOG_RETENTION_DAYS} days`, () =>
      this.dataSource.query('DELETE FROM sms_log WHERE created_at < ?', [daysAgo(SMS_LOG_RETENTION_DAYS)]),
    );
  }

  /** Replies cascade with their message (fk_reply_message); a testimonial made from one keeps its text (SET NULL). */
  private async purgeOldContactMessages(): Promise<void> {
    await this.step('purge contact messages older than 24 months', () =>
      this.dataSource.query('DELETE FROM contact_messages WHERE created_at < ?', [daysAgo(CONTACT_MESSAGE_RETENTION_DAYS)]),
    );
  }

  /**
   * A draft nobody has touched for 180 days is abandoned: its private files
   * are deleted through the storage driver, then the row (documents,
   * events, sessions and OTPs cascade). Submitted applications are never
   * touched here — only an admin removes those (DELETE admin/applications/:id).
   */
  private async purgeIdleDrafts(): Promise<void> {
    await this.step('purge idle drafts', async () => {
      const drafts: Array<{ id: string }> = await this.dataSource.query(
        "SELECT id FROM applications WHERE status = 'draft' AND updated_at < ? LIMIT 500",
        [daysAgo(IDLE_DRAFT_RETENTION_DAYS)],
      );
      for (const { id } of drafts) {
        const files: Array<{ storage_key: string }> = await this.dataSource.query(
          'SELECT storage_key FROM application_documents WHERE application_id = ?',
          [id],
        );
        for (const file of files) await this.fileStore.remove(file.storage_key);
        await this.dataSource.query('UPDATE interview_slots SET application_id = NULL WHERE application_id = ?', [id]);
        await this.dataSource.query("DELETE FROM applications WHERE id = ? AND status = 'draft'", [id]);
      }
      return { affectedRows: drafts.length };
    });
  }

  private async purgeInactiveNewsletterRows(): Promise<void> {
    const cutoff = daysAgo(NEWSLETTER_INACTIVE_RETENTION_DAYS);
    await this.step('purge unsubscribed / unconfirmed newsletter rows', () =>
      this.dataSource.query(
        'DELETE FROM newsletter_subscribers WHERE unsubscribed_at < ? OR (confirmed_at IS NULL AND created_at < ?)',
        [cutoff, cutoff],
      ),
    );
  }

  /** Runs one retention step, logging its row count; a failure is logged and never stops the other steps. */
  private async step(name: string, run: () => Promise<{ affectedRows?: number } | unknown>): Promise<void> {
    try {
      const result = (await run()) as { affectedRows?: number } | undefined;
      this.logger.log(`${name}: ${result?.affectedRows ?? 0} row(s)`);
    } catch (err) {
      this.logger.error(`Failed to ${name}`, err instanceof Error ? err.stack : String(err));
    }
  }

  /** Same purgeable rule as staff sessions (Safeer infra change §2: "Maintenance purges expired rows"). */
  private async purgeExpiredApplicantSessions(): Promise<void> {
    try {
      const result = await this.applicantSessionRepo
        .createQueryBuilder()
        .delete()
        .where('expires_at < :now', { now: new Date() })
        .orWhere('revoked_at IS NOT NULL')
        .execute();
      this.logger.log(`Purged ${result.affected ?? 0} dead applicant session(s)`);
    } catch (err) {
      this.logger.error('Failed to purge expired applicant sessions', err instanceof Error ? err.stack : String(err));
    }
  }

  /** An OTP row is safely purgeable once it can never be verified again — spent (consumed) or past its 10-minute expiry. */
  private async purgeSpentApplicantOtps(): Promise<void> {
    try {
      const result = await this.applicantOtpRepo
        .createQueryBuilder()
        .delete()
        .where('consumed_at IS NOT NULL')
        .orWhere('expires_at < :now', { now: new Date() })
        .execute();
      this.logger.log(`Purged ${result.affected ?? 0} spent/expired applicant OTP(s)`);
    } catch (err) {
      this.logger.error('Failed to purge spent applicant OTPs', err instanceof Error ? err.stack : String(err));
    }
  }
}
