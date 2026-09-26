import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Redirect } from '../database/entities/redirect.entity.js';
import { createRedirectSchema, updateRedirectSchema } from './dto/redirect.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

/**
 * No `is_published` / `sort_order` columns (12-database.md) — plain CRUD
 * only, no publish/reorder routes.
 *
 * B4 (safeer-backend-fr-review.md): CrudController only ever applies
 * `@Roles` to its own generated `DELETE` (`deleteRoles`, admin-only by
 * default) — read/create/update are open to any signed-in staff member
 * unless the subclass adds a class-level `@Roles` of its own, the same way
 * every other content controller (admin-news.controller.ts,
 * admin-partners.controller.ts, …) already does. Redirects were the one
 * collection that never did, so a reviewer or support account could
 * redirect any public path to an arbitrary URL.
 */
@Controller('admin/redirects')
@Roles('admin', 'editor')
export class RedirectsController extends CrudController<Redirect>({
  path: 'admin/redirects',
  entity: Redirect,
  createDto: createRedirectSchema,
  updateDto: updateRedirectSchema,
  searchable: ['fromPath', 'toPath'],
  // 4.3: redirects-public.controller.ts's `@CacheTags('redirects')` is
  // served by this collection — an admin correcting or deleting a redirect
  // row must invalidate it the same way every other collection does.
  extraPurgeTags: ['redirects'],
  label: (r) => r.fromPath,
}) {}
