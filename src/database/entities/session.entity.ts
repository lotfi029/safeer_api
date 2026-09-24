import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { User } from './user.entity.js';

/**
 * Session semantics (decision D-06): the cookie holds 32 random bytes; only
 * the SHA-256 lands here. Valid when
 *   revoked_at IS NULL AND expires_at > NOW() AND last_seen_at > NOW() - INTERVAL 8 HOUR
 * `last_seen_at` is written at most once a minute (trap 11), not on every
 * request.
 */
@Entity('sessions')
@Unique('uq_session_hash', ['tokenHash'])
@Index('ix_session_user', ['userId', 'revokedAt', 'expiresAt'])
export class Session {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'fk_session_user' })
  user?: User;

  /** SHA-256 of the 32-byte cookie value */
  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  /** absolute: created_at + 30 days */
  @Column({ name: 'expires_at', type: 'datetime', precision: 3 })
  expiresAt: Date;

  /** idle timeout measured from here (8 h) */
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
