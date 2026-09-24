import type { User, UserRole } from '../database/entities/user.entity.js';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isLocked: boolean;
  failedLogins: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Never include passwordHash in an API response or an audit-log snapshot. */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isLocked: user.isLocked,
    failedLogins: user.failedLogins,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
