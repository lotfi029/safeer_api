import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository, type EntityManager } from 'typeorm';
import { User, type UserRole } from '../database/entities/user.entity.js';
import { Session } from '../database/entities/session.entity.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { toPublicUser, type PublicUser } from './public-user.js';

/**
 * An unusable Argon2id-shaped hash. Real Argon2id verification against it
 * always fails (PasswordService.verify catches the parse error and returns
 * false) — this is not a security-by-obscurity placeholder, the account
 * genuinely cannot be signed into until /auth/accept/:token sets a real one
 * (FR-A-09: admins never type another user's password).
 */
export const UNUSABLE_PASSWORD_HASH =
  '$argon2id$v=19$m=1,t=1,p=1$AAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface UpdateUserInput {
  name?: string;
  email?: string;
  role?: UserRole;
  isLocked?: boolean;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Session) private readonly sessionRepo: Repository<Session>,
  ) {}

  async findAll(): Promise<PublicUser[]> {
    const users = await this.userRepo.find({ order: { createdAt: 'ASC' } });
    return users.map(toPublicUser);
  }

  async findById(id: string): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'User not found');
    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { email } });
  }

  /** Row creation only — no password. Used by AuthService.invite() (FR-A-09: admins never type another user's password). */
  async createInvitedUser(email: string, name: string, role: UserRole): Promise<User> {
    const existing = await this.findByEmail(email);
    if (existing) {
      throw new ProblemException(409, ErrorCode.VALIDATION_FAILED, 'A user with that email already exists');
    }
    const user = this.userRepo.create({
      email,
      name,
      role,
      passwordHash: UNUSABLE_PASSWORD_HASH,
      isLocked: false,
      failedLogins: 0,
    });
    return this.userRepo.save(user);
  }

  /**
   * B1-9: how many *usable* admins would remain besides `excludeId` — a
   * locked admin cannot sign in and cannot unlock anyone (unlock is
   * @Roles('admin')), so it must not count as cover. The old `isLastAdmin`
   * counted every admin regardless of lock state, which meant demoting or
   * deleting the sole *active* admin could still pass "not the last admin"
   * as long as a second, already-locked admin row existed.
   */
  private async usableAdminsBesides(manager: EntityManager, excludeId: string): Promise<number> {
    return manager.count(User, { where: { role: 'admin', isLocked: false, id: Not(excludeId) } });
  }

  /**
   * FR-A-03, three rules: a user cannot change their own role; the last
   * remaining *usable* admin cannot be demoted, locked or deleted; locking
   * cascades to revoke every active session for that user immediately (so
   * SessionGuard's own `revoked_at IS NULL` check is what actually kills a
   * locked account's live session on the next request — this is the
   * primary mechanism, the guard's `is_locked` join is the defence-in-depth
   * layer).
   *
   * B1-9: wrapped in a transaction that takes a pessimistic write lock on
   * the whole admin set (plus the target row) in one statement before any
   * check runs — the old version read `isLastAdmin` and wrote outside any
   * lock, so two concurrent requests against the two remaining admins could
   * both observe "not the last admin" and both succeed, leaving zero.
   * `wouldRemoveAdminCover` is computed once, off the pre-mutation row, so
   * a request that both demotes *and* locks the same user checks both
   * against the same original state rather than a partially-applied one.
   */
  async update(actorId: string, targetId: string, input: UpdateUserInput): Promise<{ before: PublicUser; after: PublicUser }> {
    return this.userRepo.manager.transaction(async (manager) => {
      await manager
        .createQueryBuilder(User, 'u')
        .setLock('pessimistic_write')
        .where('u.role = :role', { role: 'admin' })
        .orWhere('u.id = :id', { id: targetId })
        .getMany();

      const target = await manager.findOne(User, { where: { id: targetId } });
      if (!target) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'User not found');
      const before = toPublicUser(target);
      const wouldRemoveAdminCover = target.role === 'admin' && !target.isLocked;

      if (input.role !== undefined && input.role !== target.role) {
        if (targetId === actorId) {
          throw new ProblemException(403, ErrorCode.FORBIDDEN, 'You cannot change your own role');
        }
        if (wouldRemoveAdminCover && (await this.usableAdminsBesides(manager, targetId)) === 0) {
          throw new ProblemException(409, ErrorCode.LAST_ADMIN, 'The last remaining admin cannot be demoted');
        }
        target.role = input.role;
      }

      if (input.name !== undefined) target.name = input.name;
      if (input.email !== undefined) target.email = input.email;

      const wasLocking = input.isLocked === true && !target.isLocked;
      if (wasLocking && wouldRemoveAdminCover && (await this.usableAdminsBesides(manager, targetId)) === 0) {
        throw new ProblemException(409, ErrorCode.LAST_ADMIN, 'The last remaining admin cannot be locked');
      }
      if (input.isLocked !== undefined) target.isLocked = input.isLocked;

      const saved = await manager.save(target);

      if (wasLocking) {
        await manager
          .createQueryBuilder()
          .update(Session)
          .set({ revokedAt: () => 'CURRENT_TIMESTAMP(3)' })
          .where('user_id = :userId', { userId: targetId })
          .andWhere('revoked_at IS NULL')
          .execute();
      }

      return { before, after: toPublicUser(saved) };
    });
  }

  /**
   * FR-A-03: a user cannot delete their own account; the last remaining
   * *usable* admin cannot be deleted. Same transaction/lock shape as
   * `update` and the same reasoning (B1-9).
   */
  async remove(actorId: string, targetId: string): Promise<PublicUser> {
    return this.userRepo.manager.transaction(async (manager) => {
      await manager
        .createQueryBuilder(User, 'u')
        .setLock('pessimistic_write')
        .where('u.role = :role', { role: 'admin' })
        .orWhere('u.id = :id', { id: targetId })
        .getMany();

      const target = await manager.findOne(User, { where: { id: targetId } });
      if (!target) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'User not found');

      if (targetId === actorId) {
        throw new ProblemException(403, ErrorCode.FORBIDDEN, 'You cannot delete your own account');
      }
      const wouldRemoveAdminCover = target.role === 'admin' && !target.isLocked;
      if (wouldRemoveAdminCover && (await this.usableAdminsBesides(manager, targetId)) === 0) {
        throw new ProblemException(409, ErrorCode.LAST_ADMIN, 'The last remaining admin cannot be deleted');
      }

      const snapshot = toPublicUser(target);
      await manager.remove(target);
      return snapshot;
    });
  }
}
