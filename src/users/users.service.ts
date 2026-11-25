import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository, type EntityManager } from 'typeorm';
import { User, type UserRole } from '../database/entities/user.entity.js';
import { Role } from '../database/entities/role.entity.js';
import { Session } from '../database/entities/session.entity.js';
import { AuthToken } from '../database/entities/auth-token.entity.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { AuthenticatedUser } from '../common/request-context.js';
import { isSubset } from '../auth/permissions.js';
import { ADMIN_ROLE_KEY, permissionList } from '../roles/public-role.js';
import { toPublicUser, type PublicUser } from './public-user.js';

/**
 * An unusable Argon2id-shaped hash. Real Argon2id verification against it
 * always fails (PasswordService.verify catches the parse error and returns
 * false) — this is not a security-by-obscurity placeholder, the account
 * genuinely cannot be signed into until /auth/accept/:token sets a real one
 * (FR-A-09: admins never type another user's password).
 *
 * It is a marker, not a timing shield: its cost is m=1,t=1, far cheaper than
 * a real hash. Login's refusal paths verify against PasswordService's dummy
 * hash instead (A2). Keep this exact value — BootstrapService and migration
 * 008 recognise invited users by it.
 */
export const UNUSABLE_PASSWORD_HASH =
  '$argon2id$v=19$m=1,t=1,p=1$AAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface UpdateUserInput {
  name?: string;
  email?: string;
  roleId?: string;
  status?: 'active' | 'disabled';
  unlock?: true;
}

/** A user as an audit row records it: the public shape plus the role's permission list (rule 6). */
export type UserSnapshot = PublicUser & { permissions: string[] };

const SYSTEM_ROLE_KEYS: readonly string[] = ['admin', 'editor', 'support'];

/** The pre-024 enum value kept in step for the rollback window (migration 024): the system key, or NULL. */
export function legacyRoleFor(role: Pick<Role, 'key'>): UserRole | null {
  return SYSTEM_ROLE_KEYS.includes(role.key) ? (role.key as UserRole) : null;
}

export function userSnapshot(user: User): UserSnapshot {
  return { ...toPublicUser(user), permissions: permissionList(user.role!) };
}

const WITH_ROLE = { role: { permissions: true } } as const;

/** Every admin-role row plus the target, locked for the rest of the transaction (B1-9). */
const ADMIN_SET_SQL = 'u.role_id IN (SELECT r.id FROM roles r WHERE r.role_key = :adminKey)';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Session) private readonly sessionRepo: Repository<Session>,
  ) {}

  async findAll(): Promise<PublicUser[]> {
    const users = await this.userRepo.find({ relations: { role: true }, order: { createdAt: 'ASC' } });
    return users.map(toPublicUser);
  }

  /** With the role and its permissions loaded. */
  async findById(id: string): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id }, relations: WITH_ROLE });
    if (!user) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'User not found');
    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { email } });
  }

  /**
   * PERM-4 rule 3: the role `actor` wants to hand out — it must exist (400
   * otherwise) and hold nothing the actor lacks (403). Loaded with its
   * permissions.
   */
  async assignableRole(actor: AuthenticatedUser, roleId: string, manager: EntityManager = this.userRepo.manager): Promise<Role> {
    const role = await manager.findOne(Role, { where: { id: roleId }, relations: { permissions: true } });
    if (!role) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'Unknown role', { errors: [{ path: 'roleId', message: 'No role with that id' }] });
    }
    if (!isSubset(actor.permissions, permissionList(role))) {
      throw new ProblemException(403, ErrorCode.FORBIDDEN, 'You cannot assign a role with permissions you do not hold');
    }
    return role;
  }

  /** Row creation only — no password. Used by AuthService.invite() (FR-A-09: admins never type another user's password). `role` comes from assignableRole(). */
  async createInvitedUser(email: string, name: string, role: Role): Promise<User> {
    const existing = await this.findByEmail(email);
    if (existing) {
      throw new ProblemException(409, ErrorCode.VALIDATION_FAILED, 'A user with that email already exists');
    }
    const user = this.userRepo.create({
      email,
      name,
      roleId: role.id,
      legacyRole: legacyRoleFor(role),
      passwordHash: UNUSABLE_PASSWORD_HASH,
      status: 'invited',
      failedLogins: 0,
    });
    const saved = await this.userRepo.save(user);
    saved.role = role;
    return saved;
  }

  /**
   * B1-9: how many *usable* admins would remain besides `excludeId` — a
   * locked admin cannot sign in and cannot unlock anyone, so it must not
   * count as cover. "Admin" is the `admin` role (PERM-4 rule 4).
   */
  private async usableAdminsBesides(manager: EntityManager, excludeId: string): Promise<number> {
    return manager.count(User, { where: { role: { key: ADMIN_ROLE_KEY }, status: 'active', id: Not(excludeId) } });
  }

  private async lockAdminsAndTarget(manager: EntityManager, targetId: string): Promise<void> {
    await manager
      .createQueryBuilder(User, 'u')
      .setLock('pessimistic_write')
      .where(ADMIN_SET_SQL, { adminKey: ADMIN_ROLE_KEY })
      .orWhere('u.id = :id', { id: targetId })
      .getMany();
  }

  /** PERM-4 rule 3: nobody manages an account whose role holds permissions they don't (a users manager can't disable an admin). */
  private assertCoversUser(actor: AuthenticatedUser, target: User): void {
    if (!isSubset(actor.permissions, permissionList(target.role!))) {
      throw new ProblemException(403, ErrorCode.FORBIDDEN, 'This user has permissions you do not hold');
    }
  }

  /**
   * FR-A-03 + PERM-4: a user cannot change their own role; a role can only
   * be assigned by someone holding all of its permissions, to a user whose
   * current role they also cover; the last remaining *usable* (active) admin
   * cannot be demoted, disabled or deleted; disabling cascades to revoke
   * every active session for that user immediately (so SessionGuard's own
   * `revoked_at IS NULL` check is what actually kills a locked account's
   * live session on the next request — this is the primary mechanism, the
   * guard's `status = 'active'` join is the defence-in-depth layer).
   *
   * B1-9: wrapped in a transaction that takes a pessimistic write lock on
   * the whole admin set (plus the target row) in one statement before any
   * check runs, so two concurrent requests against the two remaining admins
   * can't both observe "not the last admin" and both succeed.
   * `wouldRemoveAdminCover` is computed once, off the pre-mutation row.
   */
  async update(actor: AuthenticatedUser, targetId: string, input: UpdateUserInput): Promise<{ before: UserSnapshot; after: UserSnapshot }> {
    return this.userRepo.manager.transaction(async (manager) => {
      await this.lockAdminsAndTarget(manager, targetId);

      const target = await manager.findOne(User, { where: { id: targetId }, relations: WITH_ROLE });
      if (!target) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'User not found');
      this.assertCoversUser(actor, target);
      const before = userSnapshot(target);
      const wouldRemoveAdminCover = target.role!.key === ADMIN_ROLE_KEY && target.status === 'active';

      if (input.roleId !== undefined && input.roleId !== target.roleId) {
        if (targetId === actor.id) {
          throw new ProblemException(403, ErrorCode.FORBIDDEN, 'You cannot change your own role');
        }
        const role = await this.assignableRole(actor, input.roleId, manager);
        if (wouldRemoveAdminCover && role.key !== ADMIN_ROLE_KEY && (await this.usableAdminsBesides(manager, targetId)) === 0) {
          throw new ProblemException(409, ErrorCode.LAST_ADMIN, 'The last remaining admin cannot be demoted');
        }
        target.roleId = role.id;
        target.role = role;
        target.legacyRole = legacyRoleFor(role);
      }

      if (input.name !== undefined) target.name = input.name;
      const emailChanged = input.email !== undefined && input.email !== target.email;
      if (input.email !== undefined) target.email = input.email;

      const disabling = input.status === 'disabled' && target.status !== 'disabled';
      if (disabling && wouldRemoveAdminCover && (await this.usableAdminsBesides(manager, targetId)) === 0) {
        throw new ProblemException(409, ErrorCode.LAST_ADMIN, 'The last remaining admin cannot be disabled');
      }
      if (input.status !== undefined) {
        if (input.status === 'active' && target.status === 'invited') {
          throw new ProblemException(409, ErrorCode.VALIDATION_FAILED, 'An invited user becomes active by accepting the invitation');
        }
        target.status = input.status;
      }
      if (input.unlock) {
        // C12: an admin unlock clears the lock *and* the counter, so the next
        // single typo doesn't lock the account straight back up.
        target.lockedUntil = null;
        target.failedLogins = 0;
        target.lockCount = 0;
      }

      const { role: _role, ...columns } = target;
      await manager.save(User, columns);

      if (disabling) {
        await manager
          .createQueryBuilder()
          .update(Session)
          .set({ revokedAt: () => 'CURRENT_TIMESTAMP(3)' })
          .where('user_id = :userId', { userId: targetId })
          .andWhere('revoked_at IS NULL')
          .execute();
      }
      // C3: an outstanding invitation or reset link must not outlive a
      // disable or an address change (it was sent to the old address).
      if (disabling || emailChanged) {
        await manager.delete(AuthToken, { userId: targetId, usedAt: IsNull() });
      }

      const saved = await manager.findOne(User, { where: { id: targetId }, relations: WITH_ROLE });
      return { before, after: userSnapshot(saved!) };
    });
  }

  /**
   * FR-A-03: a user cannot delete their own account; the last remaining
   * *usable* admin cannot be deleted; PERM-4: nor can someone whose role
   * the caller doesn't cover. Same transaction/lock shape as `update` (B1-9).
   */
  async remove(actor: AuthenticatedUser, targetId: string): Promise<UserSnapshot> {
    return this.userRepo.manager.transaction(async (manager) => {
      await this.lockAdminsAndTarget(manager, targetId);

      const target = await manager.findOne(User, { where: { id: targetId }, relations: WITH_ROLE });
      if (!target) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'User not found');

      if (targetId === actor.id) {
        throw new ProblemException(403, ErrorCode.FORBIDDEN, 'You cannot delete your own account');
      }
      this.assertCoversUser(actor, target);
      const wouldRemoveAdminCover = target.role!.key === ADMIN_ROLE_KEY && target.status === 'active';
      if (wouldRemoveAdminCover && (await this.usableAdminsBesides(manager, targetId)) === 0) {
        throw new ProblemException(409, ErrorCode.LAST_ADMIN, 'The last remaining admin cannot be deleted');
      }

      const snapshot = userSnapshot(target);
      await manager.delete(User, { id: targetId });
      return snapshot;
    });
  }
}
