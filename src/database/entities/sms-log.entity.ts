import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type SmsLocale = 'ar' | 'en';
export type SmsLogStatus = 'queued' | 'sent' | 'failed' | 'skipped';

/**
 * Same shape as mail_log (status/attempts/next_retry_at), for parity and to
 * leave room for a future retry queue — but SmsService (src/sms/sms.service.ts)
 * makes a single immediate attempt today and never schedules a retry: there
 * is no real SMS vendor wired up yet (only 'log' and a generic, untested
 * 'http' driver), so a retry sweep would have nothing meaningfully different
 * to retry against. `next_retry_at` stays NULL on every row this phase
 * writes.
 */
@Entity('sms_log')
@Index('ix_sms_recent', ['status', 'createdAt'])
@Index('ix_sms_retry', ['status', 'nextRetryAt'])
@Index('ix_sms_entity', ['entityType', 'entityId'])
@Index('ix_sms_template', ['templateKey', 'createdAt'])
@Index('ix_sms_log_created', ['createdAt'])
export class SmsLog {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  /** not a FK: the log outlives template deletion */
  @Column({ name: 'template_key', type: 'varchar', length: 64 })
  templateKey: string;

  @Column({ type: 'enum', enum: ['ar', 'en'] as SmsLocale[], default: 'ar' })
  locale: SmsLocale;

  @Column({ name: 'to_phone', type: 'varchar', length: 40 })
  toPhone: string;

  /** as actually rendered */
  @Column({ type: 'varchar', length: 500 })
  message: string;

  @Column({ type: 'enum', enum: ['queued', 'sent', 'failed', 'skipped'] as SmsLogStatus[], default: 'queued' })
  status: SmsLogStatus;

  @Column({ type: 'tinyint', unsigned: true, default: 0 })
  attempts: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  error: string | null;

  @Column({ type: 'json', nullable: true })
  payload: { message: string } | null;

  /** applications, applicant_otps … */
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
