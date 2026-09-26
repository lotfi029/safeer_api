import type { User, UserRole, UserStatus } from '../database/entities/user.entity.js';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** C3: active | disabled | invited — only an admin changes it. */
  status: UserStatus;
  /** C12: true while a brute-force lock is running (`lockedUntil` in the future). */
  isLocked: boolean;
  lockedUntil: Date | null;
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
    status: user.status,
    isLocked: isBruteForceLocked(user),
    lockedUntil: user.lockedUntil,
    failedLogins: user.failedLogins,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** C12: a brute-force lock is in force until `lockedUntil`. */
export function isBruteForceLocked(user: Pick<User, 'lockedUntil'>, now: Date = new Date()): boolean {
  return user.lockedUntil !== null && user.lockedUntil > now;
}
