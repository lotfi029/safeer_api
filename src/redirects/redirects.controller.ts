import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Redirect } from '../database/entities/redirect.entity.js';
import { createRedirectSchema, updateRedirectSchema } from './dto/redirect.dto.js';

/** No `is_published` / `sort_order` columns (12-database.md) — plain CRUD only, no publish/reorder routes. */
@Controller('admin/redirects')
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
