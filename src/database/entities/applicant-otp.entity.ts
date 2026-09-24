import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Application } from './application.entity.js';

export type ApplicantOtpChannel = 'sms' | 'email';

@Entity('applicant_otps')
@Index('ix_otp_application', ['applicationId', 'consumedAt', 'expiresAt'])
export class ApplicantOtp {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'application_id', type: 'bigint', unsigned: true })
  applicationId: string;

  @ManyToOne(() => Application, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id', foreignKeyConstraintName: 'fk_otp_application' })
  application?: Application;

  /** SHA-256 of the one-time code; the plaintext is never stored */
  @Column({ name: 'code_hash', type: 'char', length: 64 })
  codeHash: string;

  @Column({ type: 'enum', enum: ['sms', 'email'] as ApplicantOtpChannel[] })
  channel: ApplicantOtpChannel;

  /** created_at + 10 minutes */
  @Column({ name: 'expires_at', type: 'datetime', precision: 3 })
  expiresAt: Date;

  /** capped at 5 */
  @Column({ type: 'tinyint', unsigned: true, default: 0 })
  attempts: number;

  @Column({ name: 'consumed_at', type: 'datetime', precision: 3, nullable: true })
  consumedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;
}
