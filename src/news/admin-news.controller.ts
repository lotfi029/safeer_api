import { Body, Controller, Delete, Param, Patch, Post as HttpPost, Req } from '@nestjs/common';
import { CrudController } from '../common/crud/crud.factory.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Post } from '../database/entities/post.entity.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { generateUniqueSlug } from '../common/text/slugify.js';
import { RESERVED_POST_SLUGS } from '../common/validation/slug.js';
import type { RequestContext } from '../common/request-context.js';
import { CreatePostDto, UpdatePostDto, createPostSchema, updatePostSchema } from './dto/post.dto.js';

const BaseAdminNewsController = CrudController<Post>({
  path: 'admin/news',
  deleteRoles: ['admin', 'editor'],
  entity: Post,
  createDto: createPostSchema,
  updateDto: updatePostSchema,
  publishable: true,
  sortable: false, // the feed orders by published_on, not a sort_order column
  searchable: ['titleAr', 'titleEn', 'excerptAr', 'excerptEn'],
  extraPurgeTags: ['home', 'news'],
  label: (p) => p.titleAr,
  // Matches news.controller.ts's public `GET news/:slug`.
  redirectFrom: (p) => (p.slug ? `/news/${p.slug}` : null),
  // C13: the spec keeps images as labelled placeholders until real photos
  // arrive, so a missing cover is a warning on the response, not a block.
  publishWarnings: (p) => (p.coverAssetId ? [] : ['COVER_MISSING']),
  // C13: a post published without a date goes out dated today (UTC), not last in the feed.
  onPublish: (p) => {
    if (!p.publishedOn) p.publishedOn = new Date().toISOString().slice(0, 10);
  },
});

@Controller('admin/news')
@Roles('admin', 'editor')
export class AdminNewsController extends BaseAdminNewsController {
  @HttpPost()
  override async create(@Body() dto: CreatePostDto, @Req() req: RequestContext): Promise<Post> {
    const slug = await generateUniqueSlug(this.repo, dto.titleEn, dto.titleAr, `post-${Date.now()}`, RESERVED_POST_SLUGS);
    return super.create({ ...dto, slug, createdBy: req.user!.id } as unknown as CreatePostDto, req);
  }

  @Patch(':id')
  override async update(@Param('id') id: string, @Body() dto: UpdatePostDto, @Req() req: RequestContext): Promise<Post> {
    if (dto.slug) {
      const existing = await this.repo.findOne({ where: { slug: dto.slug } });
      if (existing && existing.id !== id) {
        throw new ProblemException(409, ErrorCode.SLUG_TAKEN, 'That slug is already in use');
      }
    }
    return super.update(id, dto, req);
  }

  /**
   * Own method, declared directly on the subclass rather than overriding
   * `remove` — MetadataScanner visits a subclass's own properties (in
   * declaration order) before walking up to the base class, so this route
   * registers ahead of the inherited `DELETE admin/news/:id`
   * (crud.factory.ts's comment above `reorderBodySchema` documents the same
   * effect for a different pair of routes). Without that ordering, a
   * `DELETE /admin/news/legacy` request would match `:id` first with
   * `id: 'legacy'`, a 404, before ever reaching this handler.
   */
  @Delete('legacy')
  async deleteLegacy(@Req() req: RequestContext): Promise<{ deleted: number }> {
    const legacyRows = await this.repo.find({ where: { isLegacy: true } });
    if (legacyRows.length === 0) return { deleted: 0 };

    await this.repo.remove(legacyRows);
    this.purge();
    req.auditContext = {
      action: 'delete',
      entityType: this.entityType,
      entityLabel: `bulk-delete legacy posts (${legacyRows.length})`,
      before: legacyRows.map((r) => ({ id: r.id, slug: r.slug, titleAr: r.titleAr })),
    };
    return { deleted: legacyRows.length };
  }
}
