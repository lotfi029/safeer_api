import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, QueryFailedError, type EntityManager } from 'typeorm';
import { Role } from '../database/entities/role.entity.js';
import { RolePermission } from '../database/entities/role-permission.entity.js';
import { User } from '../database/entities/user.entity.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { AuthenticatedUser } from '../common/request-context.js';
import { isSubset, normalisePermissions } from '../auth/permissions.js';
import { RESERVED_ROLE_KEYS, type CreateRoleDto, type UpdateRoleDto } from './dto/role.dto.js';
import { ADMIN_ROLE_KEY, permissionList, toPublicRole, toRoleRef, type PublicRole, type RoleRef } from './public-role.js';

/** What an audit row records for a role: the public shape minus the volatile user count. */
export type RoleSnapshot = Omit<PublicRole, 'userCount'>;

const snapshot = (role: PublicRole): RoleSnapshot => {
  const { userCount: _ignored, ...rest } = role;
  return rest;
};

/**
 * PERM-4: roles CRUD with the plan's safety rules (A3):
 *  1. Only `roles.manage` creates or edits roles (the route permission), and
 *     a caller can grant only permissions they hold (no escalation). A role
 *     whose current set the caller doesn't hold is out of their reach too.
 *  2. Nobody edits or deletes their own role.
 *  5. A role still assigned to users can't be deleted (409 ROLE_IN_USE, with
 *     the count).
 *  6. Every write returns before/after snapshots (with permission lists) for
 *     the audit row the controller hands AuditInterceptor.
 * Rules 3 and 4 (assigning roles, the last usable admin) live in
 * UsersService and AuthService.invite.
 */
@Injectable()
export class RolesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(): Promise<PublicRole[]> {
    const roles = await this.dataSource.getRepository(Role).find({ relations: { permissions: true }, order: { isSystem: 'DESC', id: 'ASC' } });
    const counts = await this.userCounts(this.dataSource.manager);
    return roles.map((r) => toPublicRole(r, counts.get(r.id) ?? 0));
  }

  async get(id: string): Promise<PublicRole> {
    const role = await this.load(this.dataSource.manager, id);
    return toPublicRole(role, await this.userCount(this.dataSource.manager, id));
  }

  /** The roles `actor` may hand out (invite or user edit, rule 3): every role whose permissions they hold. */
  async assignable(actor: AuthenticatedUser): Promise<RoleRef[]> {
    const roles = await this.dataSource.getRepository(Role).find({ relations: { permissions: true }, order: { isSystem: 'DESC', id: 'ASC' } });
    return roles.filter((r) => isSubset(actor.permissions, permissionList(r))).map(toRoleRef);
  }

  async create(actor: AuthenticatedUser, dto: CreateRoleDto): Promise<PublicRole> {
    const key = dto.key ?? `custom-${randomBytes(3).toString('hex')}`;
    if (RESERVED_ROLE_KEYS.includes(key)) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, `The role key "${key}" is reserved`, {
        errors: [{ path: 'key', message: `Reserved: ${RESERVED_ROLE_KEYS.join(', ')}` }],
      });
    }
    const permissions = normalisePermissions(dto.permissions);
    this.assertCanGrant(actor, permissions);

    try {
      const id = await this.dataSource.transaction(async (manager) => {
        const saved = await manager.save(
          manager.create(Role, {
            key,
            nameAr: dto.nameAr,
            nameEn: dto.nameEn ?? null,
            descriptionAr: dto.descriptionAr ?? null,
            descriptionEn: dto.descriptionEn ?? null,
            isSystem: false,
          }),
        );
        await this.writePermissions(manager, saved.id, permissions);
        return saved.id;
      });
      return this.get(id);
    } catch (err) {
      if (isDuplicateKey(err)) throw new ProblemException(409, ErrorCode.ROLE_KEY_TAKEN, `A role with the key "${key}" already exists`);
      throw err;
    }
  }

  async update(actor: AuthenticatedUser, id: string, dto: UpdateRoleDto): Promise<{ before: RoleSnapshot; after: RoleSnapshot }> {
    const before = await this.dataSource.transaction(async (manager) => {
      const role = await this.lockAndLoad(manager, id);
      if (role.key === ADMIN_ROLE_KEY) {
        throw new ProblemException(409, ErrorCode.ROLE_IMMUTABLE, 'The admin role cannot be changed');
      }
      this.assertNotOwnRole(actor, role, 'edit');
      this.assertCovers(actor, role);
      const beforeRole = toPublicRole(role, 0);

      if (dto.permissions !== undefined) {
        const permissions = normalisePermissions(dto.permissions);
        this.assertCanGrant(actor, permissions);
        await manager.delete(RolePermission, { roleId: role.id });
        await this.writePermissions(manager, role.id, permissions);
      }
      // updated_at moves on a permissions-only edit too.
      await manager.update(
        Role,
        { id: role.id },
        {
          ...(dto.nameAr !== undefined && { nameAr: dto.nameAr }),
          ...(dto.nameEn !== undefined && { nameEn: dto.nameEn }),
          ...(dto.descriptionAr !== undefined && { descriptionAr: dto.descriptionAr }),
          ...(dto.descriptionEn !== undefined && { descriptionEn: dto.descriptionEn }),
          updatedAt: () => 'CURRENT_TIMESTAMP(3)',
        },
      );
      return beforeRole;
    });
    return { before: snapshot(before), after: snapshot(await this.get(id)) };
  }

  async remove(actor: AuthenticatedUser, id: string): Promise<RoleSnapshot> {
    return this.dataSource.transaction(async (manager) => {
      const role = await this.lockAndLoad(manager, id);
      if (role.isSystem) {
        throw new ProblemException(409, ErrorCode.ROLE_IMMUTABLE, 'A system role cannot be deleted');
      }
      this.assertNotOwnRole(actor, role, 'delete');
      this.assertCovers(actor, role);

      const userCount = await this.userCount(manager, role.id);
      if (userCount > 0) {
        throw new ProblemException(409, ErrorCode.ROLE_IN_USE, `This role is still assigned to ${userCount} user(s)`, { userCount });
      }
      const before = toPublicRole(role, 0);
      try {
        await manager.delete(Role, { id: role.id });
      } catch (err) {
        // A user assigned between the count and the delete: the FK refuses it.
        if (isForeignKeyRefusal(err)) {
          throw new ProblemException(409, ErrorCode.ROLE_IN_USE, 'This role is still assigned to users', { userCount: await this.userCount(manager, role.id) });
        }
        throw err;
      }
      return snapshot(before);
    });
  }

  // ---------------------------------------------------------------------

  private assertCanGrant(actor: AuthenticatedUser, permissions: readonly string[]): void {
    if (!isSubset(actor.permissions, permissions)) {
      throw new ProblemException(403, ErrorCode.FORBIDDEN, 'You can only grant permissions you hold yourself');
    }
  }

  private assertCovers(actor: AuthenticatedUser, role: Role): void {
    if (!isSubset(actor.permissions, permissionList(role))) {
      throw new ProblemException(403, ErrorCode.FORBIDDEN, 'This role holds permissions you do not have');
    }
  }

  private assertNotOwnRole(actor: AuthenticatedUser, role: Role, verb: 'edit' | 'delete'): void {
    if (role.id === actor.roleId) {
      throw new ProblemException(403, ErrorCode.FORBIDDEN, `You cannot ${verb} your own role`);
    }
  }

  private async load(manager: EntityManager, id: string): Promise<Role> {
    if (!/^\d+$/.test(id)) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Role not found');
    const role = await manager.findOne(Role, { where: { id }, relations: { permissions: true } });
    if (!role) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Role not found');
    return role;
  }

  /** Locks the role row for the rest of the transaction, then loads it with its permissions. */
  private async lockAndLoad(manager: EntityManager, id: string): Promise<Role> {
    if (!/^\d+$/.test(id)) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'Role not found');
    await manager.createQueryBuilder(Role, 'r').setLock('pessimistic_write').where('r.id = :id', { id }).getOne();
    return this.load(manager, id);
  }

  private async writePermissions(manager: EntityManager, roleId: string, permissions: readonly string[]): Promise<void> {
    if (permissions.length === 0) return;
    await manager.insert(
      RolePermission,
      permissions.map((permission) => ({ roleId, permission })),
    );
  }

  private async userCount(manager: EntityManager, roleId: string): Promise<number> {
    return manager.count(User, { where: { roleId } });
  }

  private async userCounts(manager: EntityManager): Promise<Map<string, number>> {
    const rows: { roleId: string; n: string }[] = await manager
      .createQueryBuilder(User, 'u')
      .select('u.role_id', 'roleId')
      .addSelect('COUNT(*)', 'n')
      .groupBy('u.role_id')
      .getRawMany();
    return new Map(rows.map((r) => [String(r.roleId), Number(r.n)]));
  }
}

function isDuplicateKey(err: unknown): boolean {
  return err instanceof QueryFailedError && (err.driverError as { code?: string } | undefined)?.code === 'ER_DUP_ENTRY';
}

function isForeignKeyRefusal(err: unknown): boolean {
  return err instanceof QueryFailedError && (err.driverError as { code?: string } | undefined)?.code === 'ER_ROW_IS_REFERENCED_2';
}
