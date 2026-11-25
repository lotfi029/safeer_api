import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { Role } from './role.entity.js';

export type UserStatus = 'active' | 'disabled' | 'invited';

/**
 * The three system role keys — the values the legacy `users.role` column
 * still holds (migration 024 keeps it for the rollback window; 025 drops it).
 */
export type UserRole = 'admin' | 'editor' | 'support';

@Entity('users')
@Unique('uq_users_email', ['email'])
@Index('ix_users_role', ['roleId'])
export class User {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 191 })
  email: string;

  /**
   * Argon2id. `select: false` keeps it out of every response and every
   * audit-log snapshot by default — the two call sites that genuinely need
   * it (login, change-password) opt back in with `.addSelect('u.passwordHash')`
   * on a query builder, the same way mail-settings.entity.ts does for its
   * own secret (`passwordEncrypted`). A plain `save()` or a `WHERE` on this
   * column is unaffected: TypeORM only omits `undefined` properties from
   * the generated UPDATE, and WHERE never needs the column selected.
   */
  @Column({ name: 'password_hash', type: 'varchar', length: 255, select: false })
  passwordHash: string;

  /**
   * PERM-1 (migration 024): the user's one role (src/auth/permissions.ts
   * says what each permission opens).
   */
  @Column({ name: 'role_id', type: 'bigint', unsigned: true })
  roleId: string;

  @ManyToOne(() => Role, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'role_id', foreignKeyConstraintName: 'fk_users_role' })
  role?: Role;

  /**
   * The pre-024 role enum, kept in step for the rollback window only (the
   * previous image reads it): the system role's key, or NULL for a custom
   * role. Nothing here reads it for access — PermissionsGuard uses the role
   * above. Migration 025 drops it.
   */
  @Column({ name: 'role', type: 'enum', enum: ['admin', 'editor', 'support'] as UserRole[], nullable: true })
  legacyRole: UserRole | null;

  /**
   * C3: the account's standing — set by an admin (`disabled`/`active`) or
   * by accepting an invitation (`invited` → `active`). Only `active` can
   * sign in or hold a session. Separate from the brute-force lock below.
   */
  @Column({ type: 'enum', enum: ['active', 'disabled', 'invited'] as UserStatus[], default: 'active' })
  status: UserStatus;

  /** Wrong passwords since the last good sign-in or the last lock (C12); back to 0 after 24 h without one (A3). */
  @Column({ name: 'failed_logins', type: 'smallint', unsigned: true, default: 0 })
  failedLogins: number;

  /** A3: when the last wrong password was entered — `failedLogins` decays 24 h after it. */
  @Column({ name: 'last_failed_login_at', type: 'datetime', precision: 3, nullable: true })
  lastFailedLoginAt: Date | null;

  /** C12: time-boxed brute-force lock — sign-in is refused until then. Never revokes sessions. */
  @Column({ name: 'locked_until', type: 'datetime', precision: 3, nullable: true })
  lockedUntil: Date | null;

  /**
   * C12: locks since the last good sign-in — the backoff exponent
   * (15 min × 2^lockCount, capped at 1 h). A3: back to 0 once 24 h pass
   * after the last lock.
   */
  @Column({ name: 'lock_count', type: 'smallint', unsigned: true, default: 0 })
  lockCount: number;

  @Column({ name: 'last_login_at', type: 'datetime', precision: 3, nullable: true })
  lastLoginAt: Date | null;

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
}
