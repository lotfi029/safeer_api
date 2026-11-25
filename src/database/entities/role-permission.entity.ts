import { Entity, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import type { Role } from './role.entity.js';

/** PERM-1 (migration 024): one permission key held by a role (`*` only for `admin`). */
@Entity('role_permissions')
export class RolePermission {
  @PrimaryColumn({ name: 'role_id', type: 'bigint', unsigned: true })
  roleId: string;

  @PrimaryColumn({ type: 'varchar', length: 64 })
  permission: string;

  // By name: role.entity.ts imports this file (an ESM cycle).
  @ManyToOne('Role', 'permissions', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id', foreignKeyConstraintName: 'fk_role_permissions_role' })
  role?: Relation<Role>;
}
