import type { Role } from '../database/entities/role.entity.js';
import { ALL_PERMISSIONS, WILDCARD } from '../auth/permissions.js';

/** The admin role (`*`): never edited, never deleted (R10: ROLE_IMMUTABLE is always 409). */
export const ADMIN_ROLE_KEY = 'admin';

/** How a user's role is shown in user responses, `GET admin/me` and the assignable-roles picker. */
export interface RoleRef {
  id: string;
  key: string;
  nameAr: string;
  nameEn: string | null;
}

export interface PublicRole extends RoleRef {
  descriptionAr: string | null;
  descriptionEn: string | null;
  isSystem: boolean;
  /** Catalog keys in catalog order, or `["*"]` for admin. */
  permissions: string[];
  userCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export function toRoleRef(role: Pick<Role, 'id' | 'key' | 'nameAr' | 'nameEn'>): RoleRef {
  return { id: role.id, key: role.key, nameAr: role.nameAr, nameEn: role.nameEn };
}

/** A role's stored permission keys, sorted the catalog's way (`*` alone stays `["*"]`). */
export function permissionList(role: Pick<Role, 'permissions'>): string[] {
  const held = new Set((role.permissions ?? []).map((p) => p.permission));
  if (held.has(WILDCARD)) return [WILDCARD];
  return ALL_PERMISSIONS.filter((k) => held.has(k));
}

export function toPublicRole(role: Role, userCount: number): PublicRole {
  return {
    ...toRoleRef(role),
    descriptionAr: role.descriptionAr,
    descriptionEn: role.descriptionEn,
    isSystem: role.isSystem,
    permissions: permissionList(role),
    userCount,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}
