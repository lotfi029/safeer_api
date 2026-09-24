import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { User } from './user.entity.js';

export type SmsDriver = 'log' | 'http';

/**
 * Singleton (CHECK id = 1), mirroring mail_settings — Safeer infra change §4.
 * `token_encrypted` is AES-256-GCM under APP_ENCRYPTION_KEY, same as
 * mail_settings.passwordEncrypted; `select: false` and an explicit response
 * DTO keep it out of every serialiser.
 */
@Entity('sms_settings')
export class SmsSettings {
  @PrimaryColumn({ type: 'bigint', unsigned: true, default: 1 })
  id: string;

  @Column({ name: 'is_enabled', type: 'boolean', default: false })
  isEnabled: boolean;

  @Column({ type: 'enum', enum: ['log', 'http'] as SmsDriver[], default: 'log' })
  driver: SmsDriver;

  /** 'http' driver only — a generic endpoint; no real vendor is wired up. */
  @Column({ name: 'provider_url', type: 'varchar', length: 500, nullable: true })
  providerUrl: string | null;

  @Column({ name: 'token_encrypted', type: 'varbinary', length: 512, nullable: true, select: false })
  tokenEncrypted: Buffer | null;

  @Column({ name: 'sender_name', type: 'varchar', length: 120, nullable: true })
  senderName: string | null;

  @Column({ name: 'last_test_at', type: 'datetime', precision: 3, nullable: true })
  lastTestAt: Date | null;

  @Column({ name: 'last_test_ok', type: 'boolean', nullable: true })
  lastTestOk: boolean | null;

  @Column({ name: 'last_test_error', type: 'varchar', length: 500, nullable: true })
  lastTestError: string | null;

  @Column({ name: 'updated_by', type: 'bigint', unsigned: true, nullable: true })
  updatedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by', foreignKeyConstraintName: 'fk_sms_settings_user' })
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
