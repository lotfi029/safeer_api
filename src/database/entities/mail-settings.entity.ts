import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { User } from './user.entity.js';

export type MailDriver = 'smtp' | 'log';
export type MailEncryption = 'none' | 'tls' | 'starttls';

/** Singleton (CHECK id = 1), like site_settings. */
@Entity('mail_settings')
export class MailSettings {
  @PrimaryColumn({ type: 'bigint', unsigned: true, default: 1 })
  id: string;

  @Column({ name: 'is_enabled', type: 'boolean', default: false })
  isEnabled: boolean;

  @Column({ type: 'enum', enum: ['smtp', 'log'] as MailDriver[], default: 'log' })
  driver: MailDriver;

  @Column({ type: 'varchar', length: 191, nullable: true })
  host: string | null;

  @Column({ type: 'smallint', unsigned: true, nullable: true })
  port: number | null;

  @Column({ type: 'enum', enum: ['none', 'tls', 'starttls'] as MailEncryption[], default: 'starttls' })
  encryption: MailEncryption;

  @Column({ type: 'varchar', length: 191, nullable: true })
  username: string | null;

  /**
   * AES-256-GCM under APP_ENCRYPTION_KEY (iv || authTag || ciphertext).
   * `select: false` **and** an explicit response DTO exclude it from every
   * serialiser (13-backend-build-plan.md P10 step 1) — never returned by the
   * API.
   */
  @Column({ name: 'password_encrypted', type: 'varbinary', length: 512, nullable: true, select: false })
  passwordEncrypted: Buffer | null;

  @Column({ name: 'from_name_ar', type: 'varchar', length: 120, nullable: true })
  fromNameAr: string | null;

  @Column({ name: 'from_name_en', type: 'varchar', length: 120, nullable: true })
  fromNameEn: string | null;

  @Column({ name: 'from_email', type: 'varchar', length: 191, nullable: true })
  fromEmail: string | null;

  @Column({ name: 'reply_to', type: 'varchar', length: 191, nullable: true })
  replyTo: string | null;

  /** receives contact notifications */
  @Column({ name: 'notify_email', type: 'varchar', length: 191, nullable: true })
  notifyEmail: string | null;

  @Column({ name: 'last_test_at', type: 'datetime', precision: 3, nullable: true })
  lastTestAt: Date | null;

  @Column({ name: 'last_test_ok', type: 'boolean', nullable: true })
  lastTestOk: boolean | null;

  @Column({ name: 'last_test_error', type: 'varchar', length: 500, nullable: true })
  lastTestError: string | null;

  @Column({ name: 'updated_by', type: 'bigint', unsigned: true, nullable: true })
  updatedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by', foreignKeyConstraintName: 'fk_mail_user' })
  updater?: User | null;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt: Date;
}
