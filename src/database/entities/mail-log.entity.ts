import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type MailLocale = 'ar' | 'en';
export type MailLogStatus = 'queued' | 'sent' | 'failed' | 'skipped';

@Entity('mail_log')
@Index('ix_mail_recent', ['status', 'createdAt'])
@Index('ix_mail_retry', ['status', 'nextRetryAt'])
@Index('ix_mail_entity', ['entityType', 'entityId'])
@Index('ix_mail_template', ['templateKey', 'createdAt'])
export class MailLog {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  /** not a FK: the log outlives template deletion */
  @Column({ name: 'template_key', type: 'varchar', length: 64 })
  templateKey: string;

  @Column({ type: 'enum', enum: ['ar', 'en'] as MailLocale[], default: 'ar' })
  locale: MailLocale;

  @Column({ name: 'to_email', type: 'varchar', length: 191 })
  toEmail: string;

  /** as actually rendered */
  @Column({ type: 'varchar', length: 255 })
  subject: string;

  @Column({ type: 'enum', enum: ['queued', 'sent', 'failed', 'skipped'] as MailLogStatus[], default: 'queued' })
  status: MailLogStatus;

  @Column({ type: 'tinyint', unsigned: true, default: 0 })
  attempts: number;

  /** the provider's own message */
  @Column({ type: 'varchar', length: 1000, nullable: true })
  error: string | null;

  /**
   * I-6: the rendered subject/html/text, so a retry survives a process
   * restart instead of depending solely on MailService's in-process
   * `pending` map. Nulled the moment `status` reaches `sent` or terminal
   * `failed` — a password-reset link then sits in the database only for the
   * ≤21-minute retry window, not the log's full 90-day life.
   */
  @Column({ type: 'json', nullable: true })
  payload: { subject: string; html: string; text: string } | null;

  /** what triggered it: contact_messages, users … */
  @Column({ name: 'entity_type', type: 'varchar', length: 64, nullable: true })
  entityType: string | null;

  @Column({ name: 'entity_id', type: 'bigint', unsigned: true, nullable: true })
  entityId: string | null;

  @Column({ name: 'next_retry_at', type: 'datetime', precision: 3, nullable: true })
  nextRetryAt: Date | null;

  @Column({ name: 'sent_at', type: 'datetime', precision: 3, nullable: true })
  sentAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;
}
