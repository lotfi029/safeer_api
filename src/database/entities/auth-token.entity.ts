import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { User } from './user.entity.js';

export type AuthTokenPurpose = 'invite' | 'reset';

/** Invitations and password resets. */
@Entity('auth_tokens')
@Unique('uq_authtok_hash', ['tokenHash'])
@Index('ix_authtok_user', ['userId', 'purpose', 'usedAt'])
export class AuthToken {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'fk_authtok_user' })
  user?: User;

  @Column({ type: 'enum', enum: ['invite', 'reset'] as AuthTokenPurpose[] })
  purpose: AuthTokenPurpose;

  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  /** invite 48 h, reset 60 min */
  @Column({ name: 'expires_at', type: 'datetime', precision: 3 })
  expiresAt: Date;

  /** single use */
  @Column({ name: 'used_at', type: 'datetime', precision: 3, nullable: true })
  usedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;
}
