import { Body, Controller, Param, Patch, Post as HttpPost, Req } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Redirect } from '../database/entities/redirect.entity.js';
import { CreateRedirectDto, UpdateRedirectDto, createRedirectSchema, updateRedirectSchema } from './dto/redirect.dto.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import type { RequestContext } from '../common/request-context.js';
import { Area } from '../auth/role-matrix.js';

/**
 * No `is_published` / `sort_order` columns (12-database.md) — plain CRUD
 * only, no publish/reorder routes.
 *
 * B4 (safeer-backend-fr-review.md): CrudController only ever applies
 * roles to its own generated `DELETE` (`deleteArea`, here the admin-only
 * `redirects.delete`) — read/create/update are open to any signed-in staff member
 * unless the subclass adds a class-level `@Roles` of its own, the same way
 * every other content controller (admin-news.controller.ts,
 * admin-partners.controller.ts, …) already does. Redirects were the one
 * collection that never did, so a reviewer or support account could
 * redirect any public path to an arbitrary URL.
 */
const BaseRedirectsController = CrudController<Redirect>({
  path: 'admin/redirects',
  deleteArea: 'redirects.delete',
  entity: Redirect,
  createDto: createRedirectSchema,
  updateDto: updateRedirectSchema,
  searchable: ['fromPath', 'toPath'],
  // 4.3: redirects-public.controller.ts's `@CacheTags('redirects')` is
  // served by this collection — an admin correcting or deleting a redirect
  // row must invalidate it the same way every other collection does.
  extraPurgeTags: ['redirects'],
  label: (r) => r.fromPath,
});

@Controller('admin/redirects')
@Area('content')
export class RedirectsController extends BaseRedirectsController {
  @HttpPost()
  override async create(@Body() dto: CreateRedirectDto, @Req() req: RequestContext): Promise<Redirect> {
    await this.assertNoChain(null, dto.fromPath, dto.toPath);
    return super.create(dto, req);
  }

  @Patch(':id')
  override async update(@Param('id') id: string, @Body() dto: UpdateRedirectDto, @Req() req: RequestContext): Promise<Redirect> {
    const current = await this.repo.findOne({ where: { id } });
    if (current) {
      const fromPath = dto.fromPath ?? current.fromPath;
      const toPath = dto.toPath ?? current.toPath;
      if (fromPath === toPath) {
        throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'fromPath and toPath must differ');
      }
      await this.assertNoChain(id, fromPath, toPath);
    }
    return super.update(id, dto, req);
  }

  /**
   * C10: a redirect must land on a real page in one hop. Refused: a target
   * that is itself redirected (a → b while b → c exists), a source that
   * another redirect already points at (x → a while adding a → b), and a
   * second rule for the same source.
   */
  private async assertNoChain(selfId: string | null, fromPath: string, toPath: string): Promise<void> {
    const others = (await this.repo.find({ where: [{ fromPath: toPath }, { toPath: fromPath }, { fromPath }] })).filter(
      (r) => r.id !== selfId,
    );
    if (others.some((r) => r.fromPath === fromPath)) {
      throw new ProblemException(409, ErrorCode.REDIRECT_CHAIN, `A redirect from ${fromPath} already exists`);
    }
    if (others.length > 0) {
      throw new ProblemException(409, ErrorCode.REDIRECT_CHAIN, 'Redirects must not chain — point the redirect at the final page');
    }
  }
}
