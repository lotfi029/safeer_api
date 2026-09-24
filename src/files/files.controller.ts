import { Controller, Get, Inject, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { MediaService } from '../media/media.service.js';
import { Public } from '../auth/decorators/public.decorator.js';
import type { RequestContext } from '../common/request-context.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';

/**
 * Nothing is ever served from a public bucket URL (D-07): these two routes
 * stream from disk so content-type, caching and download counting stay
 * under our control. Public ids are UUIDs, not sequential — not
 * enumerable. That is not, by itself, an authorisation control (see H5
 * below) — it only means the URL can't be guessed, not that possessing it
 * should grant permanent access regardless of the owning row's publish
 * state.
 *
 * B1-1: the global 100/min throttle used to apply here too. A single
 * 24-cover library page is 24+ of these requests; two or three page views
 * in a minute started returning 429 for images. These are read-only asset
 * fetches with no per-caller cost worth rate-limiting the way login/contact
 * are.
 *
 * 26-backend-code-review.md H5: an asset attached only to unpublished rows
 * (or referenced by no row at all) is now served only to a signed-in
 * caller, with `Cache-Control: private, no-store` instead of the
 * year-long immutable header — anyone else gets 404, indistinguishable
 * from a genuinely missing asset. `SessionGuard`'s optional resolution on
 * `@Public()` routes (see its own comment) is what makes `req.user` still
 * available here without requiring a session for the common case (a
 * published asset, fetched anonymously).
 */
@Controller('files')
@SkipThrottle()
export class FilesController {
  constructor(
    private readonly mediaService: MediaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Get(':publicId')
  async streamOriginal(@Param('publicId') publicId: string, @Req() req: RequestContext, @Res() res: Response): Promise<void> {
    const asset = await this.mediaService.findByPublicId(publicId);
    if (!asset) throw new NotFoundException();

    const isPrivate = await this.gatePublication(asset.id, req);
    if (isPrivate === 'deny') throw new NotFoundException();

    // B1-3: only PDFs (`documents` rows) have a download_count to bump —
    // this used to run, awaited, on every image request too: a blocking
    // write matching nothing, on the hottest read route in the API. Now
    // scoped to the kind that can actually match, and fired without
    // awaiting it so a slow write never delays the response.
    if (asset.kind === 'pdf') {
      void this.mediaService.incrementDownloadCount(publicId);
    }

    this.sendFile(res, asset.storageKey, asset.mimeType, asset.kind === 'pdf', isPrivate === 'allow-private');
  }

  @Public()
  @Get(':publicId/:variant')
  async streamVariant(
    @Param('publicId') publicId: string,
    @Param('variant') variant: string,
    @Req() req: RequestContext,
    @Res() res: Response,
  ): Promise<void> {
    const asset = await this.mediaService.findByPublicId(publicId);
    if (!asset) throw new NotFoundException();

    const isPrivate = await this.gatePublication(asset.id, req);
    if (isPrivate === 'deny') throw new NotFoundException();

    const found = await this.mediaService.findVariant(asset.id, variant);
    if (!found) throw new NotFoundException();

    this.sendFile(res, found.storageKey, 'image/webp', false, isPrivate === 'allow-private');
  }

  /**
   * `'allow-public'` — the asset is publicly readable, serve with the
   * normal immutable cache header. `'allow-private'` — not publicly
   * readable, but the caller is signed in, so serve it anyway with
   * `no-store` (an editor previewing an unpublished attachment, or an
   * admin who has the link from the dashboard). `'deny'` — not publicly
   * readable and no session: 404, indistinguishable from a missing asset.
   */
  private async gatePublication(assetId: string, req: RequestContext): Promise<'allow-public' | 'allow-private' | 'deny'> {
    if (await this.mediaService.isPubliclyReadable(assetId)) return 'allow-public';
    if (req.user) return 'allow-private';
    return 'deny';
  }

  private sendFile(res: Response, storageKey: string, mimeType: string, asAttachment: boolean, isPrivate: boolean): void {
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', isPrivate ? 'private, no-store' : 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (asAttachment) {
      res.setHeader('Content-Disposition', 'attachment');
    }
    const stream = createReadStream(path.join(this.env.STORAGE_ROOT, storageKey));
    stream.on('error', () => {
      if (!res.headersSent) res.status(404);
      res.end();
    });
    stream.pipe(res);
  }
}
