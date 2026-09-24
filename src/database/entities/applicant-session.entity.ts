import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { Application } from './application.entity.js';

/**
 * The student-portal cookie's backing store — cookie `sf_app_sid`, kept
 * entirely separate from the staff `sessions` table (Safeer infra change
 * §2). Same token/hash utilities as staff sessions
 * (src/auth/session-token.util.ts) but a different idle/absolute lifetime:
 *   revoked_at IS NULL AND expires_at > NOW() AND last_seen_at > NOW() - INTERVAL 12 HOUR
 * expires_at is created_at + 7 days. `SessionGuard` resolves this table only
 * for `@ApplicantRoute()` handlers, and the `sessions` table only for
 * everything else — a staff cookie is never accepted here and vice versa.
 */
@Entity('applicant_sessions')
@Unique('uq_appsession_hash', ['tokenHash'])
@Index('ix_appsession_application', ['applicationId', 'revokedAt', 'expiresAt'])
export class ApplicantSession {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'application_id', type: 'bigint', unsigned: true })
  applicationId: string;

  @ManyToOne(() => Application, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id', foreignKeyConstraintName: 'fk_appsession_application' })
  application?: Application;

  /** SHA-256 of the 32-byte cookie value */
  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  /** absolute: created_at + 7 days */
  @Column({ name: 'expires_at', type: 'datetime', precision: 3 })
  expiresAt: Date;

  /** idle timeout measured from here (12 h) */
  @Column({ name: 'last_seen_at', type: 'datetime', precision: 3 })
  lastSeenAt: Date;

  @Column({ name: 'revoked_at', type: 'datetime', precision: 3, nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @Column({ name: 'ip_hash', type: 'char', length: 64, nullable: true })
  ipHash: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;
}
