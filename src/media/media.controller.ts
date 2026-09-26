import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { MediaService } from './media.service.js';
import { SetAltTextDto } from './dto/set-alt-text.dto.js';
import { CacheService } from '../cache/cache.service.js';
import { declarePurger } from '../cache/cache-tag-registry.js';
import { readPageLimit } from '../common/query/list-params.js';
import type { RequestContext } from '../common/request-context.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';

// 20 MB outer guard (P7 step 1); MediaService enforces the real per-kind
// caps (images 5 MB, PDFs 10 MB) after magic-byte detection.
const MULTIPART_BODY_LIMIT = 20 * 1024 * 1024;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * B5 (safeer-backend-fr-review.md): the matrix gives media to admin/editor
 * only, but this hand-written controller (not CrudController-generated) had
 * no class-level `@Roles` at all — only `DELETE` was gated. Reviewer and
 * support accounts could list, upload and edit alt text on every asset.
 */
@Controller('admin/media')
@Roles('admin', 'editor')
@ApiCookieAuth()
export class MediaController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly cache: CacheService,
  ) {
    // Alt text can appear on any public surface that renders this asset —
    // image bytes are immutable by publicId (no purge needed there), but an
    // alt-text correction is an accessibility fix. TODO(phase 4+): extend
    // this list (and setAltText()'s loop below) with every public tag a
    // content module purges, as those modules land (news, pages, ...).
    declarePurger('home');
  }

  @ApiQuery({ name: 'page', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: String })
  @Get()
  async list(@Query() query: Record<string, unknown>) {
    const { page, limit, offset, beyondMaxOffset } = readPageLimit(query, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });
    // 30-backend-finishing-prompt.md §2.5 (task 5): report the real total
    // rather than 0 — see audit.controller.ts's identical comment. The
    // file library is explicitly "the collection that grows without
    // bound" (this method's own doc comment below), making it one of the
    // more likely places for a client to actually run past the last page.
    if (beyondMaxOffset) {
      const total = await this.mediaService.count();
      return { data: [], total, page, limit };
    }
    const { data, total } = await this.mediaService.list(offset, limit);
    return { data, total, page, limit };
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MULTIPART_BODY_LIMIT } }))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    // B1-10: `file` is undefined when the multipart body has no `file`
    // part (or a different field name) — `file.buffer` used to throw a raw
    // TypeError there, which the global filter maps to an opaque 500 for
    // what is really a 400. `?.length` also catches a zero-byte upload,
    // which would otherwise reach fileTypeFromBuffer and fail with the
    // less accurate "Unsupported file type".
    if (!file?.buffer?.length) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'A file is required — send it as the multipart field "file"');
    }
    const { asset, wasExisting } = await this.mediaService.upload(file.buffer, file.originalname, req.user!.id);
    if (wasExisting) {
      // A checksum collision returns the existing asset, not an error
      // (trap 4) — 200, not the default 201, since nothing was created.
      res.status(200);
    } else {
      req.auditContext = {
        action: 'upload',
        entityType: 'media_assets',
        entityId: asset.id,
        entityLabel: asset.originalName,
        after: { kind: asset.kind, sizeBytes: asset.sizeBytes },
      };
    }
    return asset;
  }

  @Patch(':id')
  async setAltText(@Param('id') id: string, @Body() dto: SetAltTextDto, @Req() req: RequestContext) {
    const asset = await this.mediaService.setAltText(id, dto.altAr, dto.altEn ?? null);
    for (const tag of ['home']) this.cache.purgeTag(tag);
    req.auditContext = {
      action: 'update',
      entityType: 'media_assets',
      entityId: id,
      entityLabel: asset.originalName,
      after: { altAr: asset.altAr, altEn: asset.altEn },
    };
    return asset;
  }

  // B0-4: admin-only, not class-level — editors must keep list/upload/
  // setAltText or they cannot attach images at all (the alt-text gate in
  // crud.factory.ts requires them to upload and set alt text first).
  @Roles('admin')
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: RequestContext) {
    const asset = await this.mediaService.remove(id);
    req.auditContext = {
      action: 'delete',
      entityType: 'media_assets',
      entityId: id,
      entityLabel: asset.originalName,
      before: { kind: asset.kind, originalName: asset.originalName },
    };
    return { deleted: true };
  }
}
