import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { MediaAsset, type MediaAssetKind } from '../database/entities/media-asset.entity.js';
import { MediaVariant } from '../database/entities/media-variant.entity.js';
import { generateWebpVariants } from './image-pipeline.js';
import { ENV } from '../config/env.tokens.js';
import type { Env } from '../config/env.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { CacheService } from '../cache/cache.service.js';

/**
 * The tags `isPubliclyReadable`'s memo is stored under — every collection
 * that can own a media asset should purge at least one of these on a
 * publish-affecting write, so that whichever owning row's publish state
 * actually changed, one of its collection's existing purge points
 * invalidates this memo for free.
 *
 * TODO(phase 4+): extend this list (and `queryIsPubliclyReadable`'s /
 * `findUsages`' UNION below) as content modules land — e.g. 'news',
 * 'pages', 'documents', 'partners', 'board', 'testimonials' — matching
 * whichever public tags those collections' own writes purge. Empty in
 * this infra-only phase: no table besides media_assets/media_variants
 * exists yet, so nothing can reference an asset yet either.
 */
const ASSET_PUBLIC_MEMO_TAGS: string[] = ['home'];

// FR-F-02 governs (your decision) — 20 MB is the outer multipart body guard
// (main.ts / multer limits); these are the real per-kind limits checked
// here, after magic-byte detection.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** H4: media_assets.width_px/height_px are SMALLINT UNSIGNED — image-pipeline.ts's 50 MP budget still allows a degenerate thin image to exceed this in one dimension. */
const MAX_DIMENSION_PX = 65535;

const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const ALLOWED_PDF_MIME = 'application/pdf';

export interface UploadResult {
  asset: MediaAsset;
  wasExisting: boolean;
}

export interface AssetUsage {
  entity: string;
  id: string;
  label: string;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @InjectRepository(MediaAsset) private readonly assetRepo: Repository<MediaAsset>,
    @InjectRepository(MediaVariant) private readonly variantRepo: Repository<MediaVariant>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(ENV) private readonly env: Env,
    private readonly cache: CacheService,
  ) {}

  /**
   * The order is the security property (13-backend-build-plan.md P7):
   * magic-byte sniff (declared MIME/extension ignored) → allow-list check
   * (an unrecognised format, including SVG — file-type deliberately can't
   * detect it, being text/XML — is rejected simply by never matching the
   * allow-list) → per-kind size cap → checksum dedup → store → variants.
   */
  async upload(buffer: Buffer, originalName: string, uploadedBy: string | null, altAr: string | null = null): Promise<UploadResult> {
    const detected = await fileTypeFromBuffer(buffer);
    const kind = this.classify(detected?.mime);
    if (!kind) {
      throw new ProblemException(400, ErrorCode.VALIDATION_FAILED, 'Unsupported file type');
    }

    const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_PDF_BYTES;
    if (buffer.length > maxBytes) {
      throw new ProblemException(
        400,
        ErrorCode.VALIDATION_FAILED,
        `File exceeds the ${maxBytes / (1024 * 1024)} MB limit for ${kind === 'image' ? 'images' : 'PDFs'}`,
      );
    }

    const checksum = createHash('sha256').update(buffer).digest('hex');

    // uq_assets_checksum collision: return the existing asset, never an
    // error — re-uploading the same file is normal editor behaviour
    // (trap 4).
    const existing = await this.assetRepo.findOne({ where: { checksumSha256: checksum } });
    if (existing) {
      return { asset: existing, wasExisting: true };
    }

    const publicId = randomUUID();
    const now = new Date();
    const dir = `assets/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    await mkdir(path.join(this.env.STORAGE_ROOT, dir), { recursive: true });

    const ext = detected!.ext;
    const storageKey = `${dir}/${publicId}.${ext}`;
    await writeFile(path.join(this.env.STORAGE_ROOT, storageKey), buffer);

    let widthPx: number | null = null;
    let heightPx: number | null = null;
    const variantRows: { label: 'thumb' | 'card' | 'full'; storageKey: string; widthPx: number; sizeBytes: number }[] = [];

    if (kind === 'image') {
      let pipelineResult: Awaited<ReturnType<typeof generateWebpVariants>>;
      try {
        pipelineResult = await generateWebpVariants(buffer);
      } catch (err) {
        // H4: sharp's own limitInputPixels guard (image-pipeline.ts) throws
        // a plain Error with this exact message. Surfaced as a typed 422 —
        // an editor scanning a poster at high DPI needs to know to
        // downscale, not receive a generic 500. The original was already
        // written to disk above; clean it up so a rejected upload doesn't
        // orphan it.
        if (err instanceof Error && err.message === 'Input image exceeds pixel limit') {
          await this.deleteFile(storageKey);
          throw new ProblemException(
            422,
            ErrorCode.VALIDATION_FAILED,
            'Image is too large to process (over the 50-megapixel limit) — please downscale it and try again.',
          );
        }
        throw err;
      }

      const { width, height, variants } = pipelineResult;

      if (width > MAX_DIMENSION_PX || height > MAX_DIMENSION_PX) {
        await this.deleteFile(storageKey);
        throw new ProblemException(422, ErrorCode.VALIDATION_FAILED, `Image dimensions exceed the ${MAX_DIMENSION_PX}px limit per side`);
      }

      widthPx = width || null;
      heightPx = height || null;
      for (const v of variants) {
        const variantKey = `${dir}/${publicId}-${v.label}.webp`;
        await writeFile(path.join(this.env.STORAGE_ROOT, variantKey), v.buffer);
        variantRows.push({ label: v.label, storageKey: variantKey, widthPx: v.width, sizeBytes: v.buffer.length });
      }
    }

    const asset = await this.assetRepo.save(
      this.assetRepo.create({
        publicId,
        kind,
        mimeType: detected!.mime,
        sizeBytes: buffer.length,
        originalName,
        storageKey,
        checksumSha256: checksum,
        widthPx,
        heightPx,
        // I-2: a resolver-downloaded cover must not land as a bare, alt-less
        // image — that would satisfy `assertAltTextReady`'s check by simply
        // never being attached, since FR-F-03 blocks it at attach time, not
        // upload time; passing the provider's title here closes that gap.
        altAr,
        altEn: null,
        uploadedBy,
      }),
    );

    for (const v of variantRows) {
      await this.variantRepo.save(this.variantRepo.create({ assetId: asset.id, ...v }));
    }

    return { asset, wasExisting: false };
  }

  async findByPublicId(publicId: string): Promise<MediaAsset | null> {
    return this.assetRepo.findOne({ where: { publicId } });
  }

  async findById(id: string): Promise<MediaAsset> {
    const asset = await this.assetRepo.findOne({ where: { id } });
    if (!asset) throw new ProblemException(404, ErrorCode.NOT_FOUND, 'File not found');
    return asset;
  }

  async findVariant(assetId: string, label: string): Promise<MediaVariant | null> {
    return this.variantRepo.findOne({ where: { assetId, label: label as MediaVariant['label'] } });
  }

  /**
   * The file library is precisely the collection that grows without bound,
   * so this list is on the standard `{data,total,page,limit}` envelope
   * every other admin list uses, from the start.
   */
  async list(offset: number, limit: number): Promise<{ data: MediaAsset[]; total: number }> {
    const [data, total] = await this.assetRepo.findAndCount({ order: { createdAt: 'DESC' }, skip: offset, take: limit });
    return { data, total };
  }

  /**
   * 30-backend-finishing-prompt.md §2.5 (task 5): lets `media.controller.ts`
   * report the real total on a `beyondMaxOffset` page without paying for
   * `findAndCount`'s row hydration it would then throw away.
   */
  async count(): Promise<number> {
    return this.assetRepo.count();
  }

  /**
   * H5: `/files/:publicId` used to stream any asset by id with no publish
   * check at all — the class comment's "UUIDs aren't enumerable" is true
   * and is not an authorisation control. An unpublished financial report
   * attached to an unpublished `documents` row was fetchable anonymously
   * and permanently by anyone who obtained the UUID, and `sendFile` set a
   * one-year immutable cache header on it.
   *
   * Same nine-FK enumeration as `findUsages`, but as an existence check
   * joined to each owning row's `is_published` rather than a usage list —
   * an asset is publicly readable only if at least one row referencing it
   * is itself published. `meeting_attachments` has no publish flag of its
   * own, so it joins through to its parent meeting's. An asset referenced
   * by no row at all (never attached, or its only reference deleted) is
   * therefore never public — there is nothing published for it to inherit
   * publication from.
   *
   * 30-backend-finishing-prompt.md §2.2: memoised in `CacheService`'s
   * boolean memo store. `files.controller.ts`'s two routes are
   * `@SkipThrottle()`d as the hottest read path in the API (B1-1); without
   * this, every `/files/:publicId/:variant` request ran three queries where
   * it used to run two — `findByPublicId` + this ten-branch UNION +
   * `findVariant` — and a single twenty-cover page multiplied that into
   * sixty queries and twenty unions. See ASSET_PUBLIC_MEMO_TAGS above for
   * why those four tags are enough to have this invalidated by every
   * owning collection's existing purge. The H5 smoke case already proves
   * the invalidation end-to-end: it caches a `false` for an unpublished
   * asset, publishes the owning row, and requires the very next anonymous
   * fetch to see a fresh `true`.
   */
  async isPubliclyReadable(assetId: string): Promise<boolean> {
    const key = `asset-public:${assetId}`;
    const memoised = this.cache.getMemo(key);
    if (memoised !== undefined) return memoised;

    const isPublic = await this.queryIsPubliclyReadable(assetId);
    this.cache.setMemo(key, isPublic, ASSET_PUBLIC_MEMO_TAGS);
    return isPublic;
  }

  /**
   * TODO(phase 4+): every content table with a `*_asset_id` FK to
   * media_assets must add a `UNION ALL SELECT 1 FROM <table> WHERE
   * <col> = ? AND is_published = 1` branch here as it lands (news,
   * pages/page_sections' image, board_members' photo, partners' logo,
   * documents' asset, etc. — see the project plan's schema section for the
   * full list of asset-owning columns). Until then no table can reference
   * a media asset at all, so nothing is ever publicly readable through
   * `/files` — the safe default.
   */
  private async queryIsPubliclyReadable(_assetId: string): Promise<boolean> {
    return false;
  }

  /** An image with no Arabic alt text cannot be attached to anything (FR-F-03). */
  async setAltText(id: string, altAr: string, altEn: string | null): Promise<MediaAsset> {
    const asset = await this.findById(id);
    asset.altAr = altAr;
    asset.altEn = altEn;
    return this.assetRepo.save(asset);
  }

  /**
   * Called fire-and-forget from files.controller.ts (not awaited), so a
   * failure here must never become an unhandled rejection — caught and
   * logged instead of thrown.
   *
   * TODO(phase 4+): african_api's equivalent bumps a `documents.download_count`
   * column; wire that back in once the Documents module and its `documents`
   * table land. A no-op until then — there is no such column anywhere yet.
   */
  async incrementDownloadCount(_publicId: string): Promise<void> {
    // Intentionally empty — see TODO above.
  }

  /**
   * Every FK with ON DELETE RESTRICT pointing at media_assets, all nine
   * tables (12-database.md §5 — the conformance pass added channels and
   * meeting_attachments, the two that get forgotten). ER_ROW_IS_REFERENCED_2
   * (trap 3) is the backstop this query exists to make unnecessary; the
   * global filter still maps it if some future write path bypasses this.
   */
  /**
   * TODO(phase 4+): add a `UNION ALL SELECT '<table>', id, <label column>
   * FROM <table> WHERE <col> = ?` branch per asset-owning table, mirroring
   * `queryIsPubliclyReadable` above — same list, same reasoning. Empty for
   * now: no table besides media_assets/media_variants exists yet, so
   * nothing can reference an asset (and therefore nothing blocks its
   * deletion) until those tables land.
   */
  async findUsages(_assetId: string): Promise<AssetUsage[]> {
    return [];
  }

  async remove(id: string): Promise<MediaAsset> {
    const asset = await this.findById(id);
    const usages = await this.findUsages(asset.id);
    if (usages.length > 0) {
      throw new ProblemException(409, ErrorCode.ASSET_IN_USE, 'File is in use', { usages });
    }

    const variants = await this.variantRepo.find({ where: { assetId: asset.id } });
    await this.assetRepo.remove(asset); // cascades media_variants at the DB level too

    await this.deleteFile(asset.storageKey);
    for (const v of variants) {
      await this.deleteFile(v.storageKey);
    }

    return asset;
  }

  private classify(mime: string | undefined): MediaAssetKind | null {
    if (!mime) return null;
    if (ALLOWED_IMAGE_MIME.has(mime)) return 'image';
    if (mime === ALLOWED_PDF_MIME) return 'pdf';
    return null;
  }

  private async deleteFile(storageKey: string): Promise<void> {
    try {
      await unlink(path.join(this.env.STORAGE_ROOT, storageKey));
    } catch {
      // Already gone, or never written — not fatal to the delete itself.
    }
  }
}
