import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../permissions.js';

export const PERMISSIONS_KEY = 'permissions';

/**
 * PERM-3: gates a route on catalog permissions (src/auth/permissions.ts) —
 * every key listed is required. The first is the route's own: its action
 * matches the HTTP method (GET → view, POST/PATCH/PUT → manage, DELETE →
 * delete), which scripts/lib/check-permissions.mjs enforces. Any extra keys
 * cover a route that also writes to another module (e.g. turning a message
 * into a testimonial).
 *
 * Put it on each handler, not on the class: a method decorator attaches to
 * that function object, so an override in a subclass must carry its own.
 */
export const Permission = (primary: PermissionKey, ...extra: PermissionKey[]) => SetMetadata(PERMISSIONS_KEY, [primary, ...extra]);
