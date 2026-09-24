import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../database/entities/user.entity.js';

export const ROLES_KEY = 'roles';

/** `@Roles('admin')` on users, settings and other destructive endpoints (11-architecture.md §3). */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
