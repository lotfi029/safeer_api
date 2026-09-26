import { applyDecorators, SetMetadata } from '@nestjs/common';
import type { UserRole } from '../database/entities/user.entity.js';
import { Roles } from './decorators/roles.decorator.js';

/**
 * B17: the one source of truth for who can do what in the dashboard. Every
 * role-gated admin route is tagged with an area through `@Area()`, which
 * applies exactly `AREA_ROLES[area]` as its `@Roles()`; `GET admin/roles`
 * returns the same constants, and scripts/lib/check-admin-roles.mjs
 * (run by CI and by Jest) fails on any admin route whose roles don't match
 * its area, so the published matrix and the enforced one can't drift.
 *
 * Routes open to any signed-in staff member (admin/me, admin/auth/*,
 * admin/overview, admin/preview-token, admin/roles) carry no area; they're
 * the checker's explicit allow-list.
 */
export const ROLES = ['admin', 'reviewer', 'editor', 'support'] as const satisfies readonly UserRole[];

export const AREA_ROLES = {
  /** Applications, their documents/notes, interview slots, CSV export. */
  applications: ['admin', 'reviewer'],
  /** DELETE admin/applications/:id (anonymise). */
  'applications.delete': ['admin'],
  /** Pages/sections, news and categories, work areas, board, stats, about items, partners, documents, media, redirects. */
  content: ['admin', 'editor'],
  /** Deleting a redirect (it can break links already shared). */
  'redirects.delete': ['admin'],
  /** Contact messages, testimonials and their themes, newsletter subscribers. */
  inbox: ['admin', 'support'],
  /** Deleting a contact message or a newsletter subscriber. */
  'inbox.delete': ['admin'],
  /** Staff accounts and invitations. */
  users: ['admin'],
  /** Site settings, mail and SMS settings/templates/logs, cache. */
  settings: ['admin'],
  audit: ['admin'],
} as const satisfies Record<string, readonly UserRole[]>;

export type Area = keyof typeof AREA_ROLES;

export const AREA_KEY = 'area';

/** Tags a controller or handler with its area and gates it on that area's roles. */
export const Area = (area: Area) => applyDecorators(SetMetadata(AREA_KEY, area), Roles(...AREA_ROLES[area]));

export interface RoleMatrix {
  roles: UserRole[];
  matrix: Record<Area, UserRole[]>;
}

export function roleMatrix(): RoleMatrix {
  return {
    roles: [...ROLES],
    matrix: Object.fromEntries(Object.entries(AREA_ROLES).map(([area, roles]) => [area, [...roles]])) as Record<Area, UserRole[]>,
  };
}
