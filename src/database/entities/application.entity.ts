import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity.js';
import type { Locale } from '../../common/request-context.js';
import { normalizePhone } from '../../common/phone.js';
import { encryptedString } from '../encrypted-column.js';

export type ApplicationStatus = 'draft' | 'new' | 'under_review' | 'docs_missing' | 'interview' | 'accepted' | 'rejected';
export type ApplicationGender = 'male' | 'female';
export type ApplicationDegreeLevel = 'bachelor' | 'master' | 'phd';

/**
 * Every status except the two terminal decisions (B2, safeer-backend-fr-review.md):
 * `PortalOtpService.findApplication` prefers the most recent one of these
 * over an older terminal application, and `ApplicationsService.create`
 * blocks a second `POST applications` while one already exists.
 */
export const NON_TERMINAL_APPLICATION_STATUSES: ApplicationStatus[] = [
  'draft',
  'new',
  'under_review',
  'docs_missing',
  'interview',
];

@Entity('applications')
@Unique('uq_applications_reference', ['reference'])
@Index('ix_applications_status', ['status', 'submittedAt'])
@Index('ix_applications_email', ['email'])
@Index('ix_applications_phone_e164', ['phoneE164'])
@Index('ix_applications_email_status', ['email', 'status'])
@Index('ix_applications_created', ['createdAt'])
export class Application {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  /** e.g. SA-2026-00184, minted from `counters` on creation */
  @Column({ type: 'varchar', length: 30 })
  reference: string;

  @Column({
    type: 'enum',
    enum: ['draft', 'new', 'under_review', 'docs_missing', 'interview', 'accepted', 'rejected'] as ApplicationStatus[],
    default: 'draft',
  })
  status: ApplicationStatus;

  @Column({ name: 'current_step', type: 'tinyint', unsigned: true, default: 1 })
  currentStep: number;

  // personal
  @Column({ name: 'first_name', type: 'varchar', length: 120, nullable: true })
  firstName: string | null;

  @Column({ name: 'middle_name', type: 'varchar', length: 120, nullable: true })
  middleName: string | null;

  @Column({ name: 'last_name', type: 'varchar', length: 120, nullable: true })
  lastName: string | null;

  @Column({ name: 'birth_date', type: 'date', nullable: true })
  birthDate: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phone: string | null;

  /**
   * `phone` normalised to E.164 (B2, safeer-backend-fr-review.md) — kept in
   * sync automatically from `phone` by the `@BeforeInsert`/`@BeforeUpdate`
   * hooks below on every `save()`. Used to match an identifier to at most
   * one application (`PortalOtpService.findApplication`) and to detect a
   * duplicate active application (`ApplicationsService.create`) — never
   * hand-written elsewhere.
   */
  @Column({ name: 'phone_e164', type: 'varchar', length: 16, nullable: true })
  phoneE164: string | null;

  /** ISO2 */
  @Column({ type: 'char', length: 2, nullable: true })
  nationality: string | null;

  /** C28: stored encrypted (id_number_encrypted); read and written as plain text through the transformer. */
  @Column({ name: 'id_number_encrypted', type: 'varbinary', length: 255, nullable: true, transformer: encryptedString })
  idNumber: string | null;

  @Column({ type: 'varchar', length: 191, nullable: true })
  email: string | null;

  @Column({ name: 'current_job', type: 'varchar', length: 191, nullable: true })
  currentJob: string | null;

  @Column({ type: 'enum', enum: ['male', 'female'] as ApplicationGender[], nullable: true })
  gender: ApplicationGender | null;

  // study
  @Column({ type: 'varchar', length: 191, nullable: true })
  university: string | null;

  @Column({ type: 'varchar', length: 191, nullable: true })
  major: string | null;

  @Column({ name: 'degree_level', type: 'enum', enum: ['bachelor', 'master', 'phd'] as ApplicationDegreeLevel[], nullable: true })
  degreeLevel: ApplicationDegreeLevel | null;

  @Column({ name: 'scholarship_note', type: 'text', nullable: true })
  scholarshipNote: string | null;

  // dates
  @Column({ name: 'consent_at', type: 'datetime', precision: 3, nullable: true })
  consentAt: Date | null;

  /**
   * C22: the daily (UTC) count of wrong OTP codes, written only by
   * PortalOtpService with atomic UPDATEs. `select: false` — internal
   * bookkeeping, never part of any response.
   */
  @Column({ name: 'otp_fail_date', type: 'date', nullable: true, select: false })
  otpFailDate?: string | null;

  @Column({ name: 'otp_fail_count', type: 'smallint', unsigned: true, default: 0, select: false })
  otpFailCount?: number;

  @Column({ name: 'submitted_at', type: 'datetime', precision: 3, nullable: true })
  submittedAt: Date | null;

  @Column({ name: 'decided_at', type: 'datetime', precision: 3, nullable: true })
  decidedAt: Date | null;

  /** C27: set when an admin anonymised the application (personal data cleared, files deleted). */
  @Column({ name: 'anonymized_at', type: 'datetime', precision: 3, nullable: true })
  anonymizedAt: Date | null;

  @Column({ name: 'assigned_reviewer_id', type: 'bigint', unsigned: true, nullable: true })
  assignedReviewerId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'assigned_reviewer_id', foreignKeyConstraintName: 'fk_applications_reviewer' })
  assignedReviewer?: User | null;

  @Column({ type: 'enum', enum: ['ar', 'en'] as Locale[], default: 'ar' })
  locale: Locale;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt: Date;

  @BeforeInsert()
  @BeforeUpdate()
  syncPhoneE164(): void {
    this.phoneE164 = normalizePhone(this.phone);
  }
}
