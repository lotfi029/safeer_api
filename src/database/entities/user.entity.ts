import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * Four roles (Safeer infra change §1, unlike african_api's two): admin has
 * full access; reviewer handles scholarship applications; editor manages
 * site content; support handles messages/testimonials/newsletter. See the
 * permission-matrix table in the project plan for which controllers each
 * role is `@Roles()`-gated on — later phases apply that table as those
 * controllers land.
 */
export type UserRole = 'admin' | 'reviewer' | 'editor' | 'support';

@Entity('users')
@Unique('uq_users_email', ['email'])
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

  @Column({ type: 'enum', enum: ['admin', 'reviewer', 'editor', 'support'] as UserRole[], default: 'editor' })
  role: UserRole;

  /** set after repeated failed sign-ins */
  @Column({ name: 'is_locked', type: 'boolean', default: false })
  isLocked: boolean;

  @Column({ name: 'failed_logins', type: 'smallint', unsigned: true, default: 0 })
  failedLogins: number;

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
