import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, Unique, UpdateDateColumn, type Relation } from 'typeorm';
import type { RolePermission } from './role-permission.entity.js';

/**
 * PERM-1 (migration 024): a named set of permissions (src/auth/permissions.ts).
 * Three system roles are seeded: `admin` (the wildcard `*`, never editable),
 * `editor` and `support` (editable, never deletable). Every other role is a
 * custom one, created from the dashboard.
 */
@Entity('roles')
@Unique('uq_roles_key', ['key'])
export class Role {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'role_key', type: 'varchar', length: 64 })
  key: string;

  @Column({ name: 'name_ar', type: 'varchar', length: 120 })
  nameAr: string;

  @Column({ name: 'name_en', type: 'varchar', length: 120, nullable: true })
  nameEn: string | null;

  @Column({ name: 'description_ar', type: 'varchar', length: 500, nullable: true })
  descriptionAr: string | null;

  @Column({ name: 'description_en', type: 'varchar', length: 500, nullable: true })
  descriptionEn: string | null;

  @Column({ name: 'is_system', type: 'boolean', default: false })
  isSystem: boolean;

  @OneToMany('RolePermission', 'role')
  permissions?: Relation<RolePermission>[];

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
