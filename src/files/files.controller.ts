import { Controller, Get, Inject, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { MediaService } from '../media/media.service.js';
import { Public } from '../auth/decorators/public.decorator.js';
import type { RequestContext } from '../common/request-context.js';
import { contentDisposition } from '../common/http/filenames.js';
import { readString } from '../common/query/list-params.js';
import { verifyPreviewToken } from '../auth/preview-token.util.js';
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
/** C25: originals and PDFs — short-lived so an unpublish takes effect within minutes. */
const ORIGINAL_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=60';
const VARIANT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

@Controller('files')
@SkipThrottle()
export class FilesController {
  constructor(
    private readonly mediaService: MediaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @ApiQuery({ name: 'preview', required: false, type: String, description: 'C41: a post preview token (with `post`), for an asset that post shows.' })
  @ApiQuery({ name: 'post', required: false, type: String })
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

    await this.sendFile(
      res,
      asset.storageKey,
      asset.mimeType,
      asset.kind === 'pdf' ? asset.originalName : null,
      isPrivate === 'allow-private',
      ORIGINAL_CACHE_CONTROL,
    );
  }

  @ApiQuery({ name: 'preview', required: false, type: String, description: 'C41: a post preview token (with `post`), for an asset that post shows.' })
  @ApiQuery({ name: 'post', required: false, type: String })
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

    await this.sendFile(res, found.storageKey, 'image/webp', null, isPrivate === 'allow-private', VARIANT_CACHE_CONTROL);
  }

  /**
   * `'allow-public'` — the asset is publicly readable, serve with the
   * normal immutable cache header. `'allow-private'` — not publicly
   * readable, but the caller is signed in, so serve it anyway with
   * `no-store` (an editor previewing an unpublished attachment, or an
   * admin who has the link from the dashboard). `'deny'` — not publicly
   * readable and no session: 404, indistinguishable from a missing asset.
   *
   * C41: a shared preview link (`GET news/:slug?preview=…`) is opened by
   * someone without a session, so its unpublished cover would 404. The
   * news detail hands back `previewFileQuery` (`preview=<token>&post=<id>`)
   * for such a response; with it, an asset *that post shows* is served
   * privately, and only while the token is valid.
   */
  private async gatePublication(assetId: string, req: RequestContext): Promise<'allow-public' | 'allow-private' | 'deny'> {
    if (await this.mediaService.isPubliclyReadable(assetId)) return 'allow-public';
    if (req.user) return 'allow-private';
    const query = (req.query ?? {}) as Record<string, unknown>;
    const token = readString(query, 'preview');
    const postId = readString(query, 'post');
    if (
      token &&
      postId &&
      /^\d+$/.test(postId) &&
      verifyPreviewToken(this.env.APP_ENCRYPTION_KEY, 'posts', postId, token) &&
      (await this.mediaService.isUsedByPost(assetId, postId))
    ) {
      return 'allow-private';
    }
    return 'deny';
  }

  /**
   * Public assets are always streamed through this API — local disk or the
   * S3 public bucket alike (decision 3) — never a redirect: nothing about
   * caching, content-type or the download-count side effect above depends
   * on where the bytes actually live.
   */
  private async sendFile(
    res: Response,
    storageKey: string,
    mimeType: string,
    attachmentName: string | null,
    isPrivate: boolean,
    cacheControl: string,
  ): Promise<void> {
    res.setHeader('Content-Type', mimeType);
    // C25: an original or a PDF can be unpublished (or replaced) at any time,
    // so browsers and CDNs may keep it only briefly; the WebP variants' URLs
    // are only ever handed out alongside a published row and change with the
    // asset, so they stay long-lived.
    res.setHeader('Cache-Control', isPrivate ? 'private, no-store' : cacheControl);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (attachmentName !== null) {
      // C19: RFC 5987 filename (Arabic document titles) with an ASCII fallback.
      res.setHeader('Content-Disposition', contentDisposition('attachment', attachmentName));
    }
    const stream = await this.mediaService.getStream(storageKey);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404);
      res.end();
    });
    stream.pipe(res);
  }
}
