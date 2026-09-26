import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import { MediaAsset, type MediaAssetKind } from '../database/entities/media-asset.entity.js';
import { MediaVariant } from '../database/entities/media-variant.entity.js';
import { normalizeOriginal, generateWebpVariants } from './image-pipeline.js';
import { ProblemException } from '../common/problem-details/problem.exception.js';
import { ErrorCode } from '../common/problem-details/error-codes.js';
import { CacheService } from '../cache/cache.service.js';
import { PUBLIC_STORAGE_DRIVER, type StorageDriver } from '../storage/storage-driver.interface.js';

/**
 * The tags `isPubliclyReadable`'s memo is stored under — every collection
 * that can own a media asset purges at least one of these on a
 * publish-affecting write, so that whichever owning row's publish state
 * actually changed, one of its collection's existing purge points
 * invalidates this memo for free. Matches the five asset-owning tables in
 * `queryIsPubliclyReadable`/`findUsages` below: `pages` (page_sections'
 * image, which also purges 'pages'), `board_members`, `news` (posts' cover),
 * `partners`, `documents`. 'home' stays too — every one of these also feeds
 * the home aggregate via `extraPurgeTags`.
 */
// C25: + 'doc_categories' — a document is only public while its category is
// published too, so unpublishing a category must drop the memo.
export const ASSET_PUBLIC_MEMO_TAGS: string[] = ['home', 'pages', 'board_members', 'news', 'partners', 'documents', 'doc_categories'];

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
    @Inject(PUBLIC_STORAGE_DRIVER) private readonly driver: StorageDriver,
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

    // C7: an image original is re-encoded (EXIF/GPS stripped, orientation
    // applied) before anything is stored; the checksum above stays the hash
    // of the uploaded bytes, so re-uploading the same photo still dedups.
    let body = buffer;
    let widthPx: number | null = null;
    let heightPx: number | null = null;
    let variants: Awaited<ReturnType<typeof generateWebpVariants>>['variants'] = [];
    if (kind === 'image') {
      try {
        const normalized = await normalizeOriginal(buffer, detected!.mime);
        if (normalized.width > MAX_DIMENSION_PX || normalized.height > MAX_DIMENSION_PX) {
          throw new ProblemException(422, ErrorCode.VALIDATION_FAILED, `Image dimensions exceed the ${MAX_DIMENSION_PX}px limit per side`);
        }
        body = normalized.buffer;
        widthPx = normalized.width || null;
        heightPx = normalized.height || null;
        variants = (await generateWebpVariants(body)).variants;
      } catch (err) {
        if (err instanceof ProblemException) throw err;
        // H4: sharp's own limitInputPixels guard (image-pipeline.ts) throws
        // a plain Error with this exact message — a typed 422 so an editor
        // knows to downscale.
        if (err instanceof Error && err.message === 'Input image exceeds pixel limit') {
          throw new ProblemException(
            422,
            ErrorCode.VALIDATION_FAILED,
            'Image is too large to process (over the 50-megapixel limit) — please downscale it and try again.',
          );
        }
        // C38: anything else sharp can't decode is the file's fault, not a 500.
        throw new ProblemException(422, ErrorCode.VALIDATION_FAILED, 'The image could not be decoded — it may be corrupt or truncated');
      }
    }

    const publicId = randomUUID();
    const now = new Date();
    const dir = `assets/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const storageKey = `${dir}/${publicId}.${detected!.ext}`;
    const written: string[] = [];

    try {
      await this.driver.put(storageKey, body);
      written.push(storageKey);
      const variantRows: { label: 'thumb' | 'card' | 'full'; storageKey: string; widthPx: number; sizeBytes: number }[] = [];
      for (const v of variants) {
        const variantKey = `${dir}/${publicId}-${v.label}.webp`;
        await this.driver.put(variantKey, v.buffer);
        written.push(variantKey);
        variantRows.push({ label: v.label, storageKey: variantKey, widthPx: v.width, sizeBytes: v.buffer.length });
      }

      const asset = await this.assetRepo.manager.transaction(async (manager) => {
        const saved = await manager.save(
          manager.create(MediaAsset, {
            publicId,
            kind,
            mimeType: detected!.mime,
            sizeBytes: body.length,
            originalName,
            storageKey,
            checksumSha256: checksum,
            widthPx,
            heightPx,
            // I-2: a resolver-downloaded cover must not land as a bare, alt-less
            // image — passing the provider's title here closes that gap.
            altAr,
            altEn: null,
            uploadedBy,
          }),
        );
        for (const v of variantRows) {
          await manager.save(manager.create(MediaVariant, { assetId: saved.id, ...v }));
        }
        return saved;
      });
      return { asset, wasExisting: false };
    } catch (err) {
      // C38: a failed write or save must not orphan what was already stored.
      await Promise.all(written.map((key) => this.deleteFile(key)));
      // Two identical uploads racing: the loser's insert hits
      // uq_assets_checksum — hand back the winner's row, as a normal dedup would.
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
        const winner = await this.assetRepo.findOne({ where: { checksumSha256: checksum } });
        if (winner) return { asset: winner, wasExisting: true };
      }
      throw err;
    }
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
  /** C41: whether post `postId` shows this asset (its cover) — what a post preview token may unlock on /files. */
  async isUsedByPost(assetId: string, postId: string): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query('SELECT 1 FROM posts WHERE id = ? AND cover_asset_id = ? LIMIT 1', [postId, assetId]);
    return rows.length > 0;
  }

  async isPubliclyReadable(assetId: string): Promise<boolean> {
    const key = `asset-public:${assetId}`;
    const memoised = this.cache.getMemo(key);
    if (memoised !== undefined) return memoised;

    const version = this.cache.versionOf(ASSET_PUBLIC_MEMO_TAGS); // C31
    const isPublic = await this.queryIsPubliclyReadable(assetId);
    this.cache.setMemo(key, isPublic, ASSET_PUBLIC_MEMO_TAGS, version);
    return isPublic;
  }

  /**
   * The five asset-owning tables in Safeer's schema (project plan's "Data
   * model" section — about_items/work_areas/stats/testimonials/
   * testimonial_themes have no `*_asset_id` column). `page_sections.image_asset_id`
   * joins to its parent `pages` row — a section can only be public when
   * both its own `is_published` ("visible" toggle) and its page's are true.
   *
   * TypeORM's mysql2 driver returns a computed `EXISTS(...)` column as the
   * *string* "1"/"0", not a JS number (confirmed directly against this
   * connection) — `Number(...)` below, not a strict `=== 1`, which would
   * silently always be false.
   */
  private async queryIsPubliclyReadable(assetId: string): Promise<boolean> {
    const [row] = await this.dataSource.query<{ isPublic: number | string }[]>(
      `SELECT EXISTS(
         SELECT 1 FROM page_sections ps JOIN pages p ON p.id = ps.page_id
           WHERE ps.image_asset_id = ? AND ps.is_published = 1 AND p.is_published = 1
         UNION ALL SELECT 1 FROM board_members WHERE photo_asset_id = ? AND is_published = 1
         UNION ALL SELECT 1 FROM posts WHERE cover_asset_id = ? AND is_published = 1
         UNION ALL SELECT 1 FROM partners WHERE logo_asset_id = ? AND is_published = 1
         UNION ALL SELECT 1 FROM documents d JOIN doc_categories dc ON dc.id = d.category_id
           WHERE d.asset_id = ? AND d.is_published = 1 AND dc.is_published = 1
       ) AS isPublic`,
      [assetId, assetId, assetId, assetId, assetId],
    );
    return Number(row?.isPublic) === 1;
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
   */
  async incrementDownloadCount(publicId: string): Promise<void> {
    try {
      await this.dataSource.query(
        'UPDATE documents SET download_count = download_count + 1 WHERE asset_id = (SELECT id FROM media_assets WHERE public_id = ?)',
        [publicId],
      );
    } catch (err) {
      this.logger.error(`Failed to increment download count for ${publicId}`, err instanceof Error ? err.stack : String(err));
    }
  }

  /**
   * Every FK with ON DELETE RESTRICT pointing at media_assets — the same
   * five tables as `queryIsPubliclyReadable` above. ER_ROW_IS_REFERENCED_2
   * (trap 3) is the backstop this query exists to make unnecessary; the
   * global filter still maps it if some future write path bypasses this.
   */
  async findUsages(assetId: string): Promise<AssetUsage[]> {
    const rows = await this.dataSource.query<AssetUsage[]>(
      `SELECT 'page_sections' AS entity, id, section_key AS label FROM page_sections WHERE image_asset_id = ?
       UNION ALL SELECT 'board_members', id, name_ar FROM board_members WHERE photo_asset_id = ?
       UNION ALL SELECT 'posts',         id, title_ar FROM posts        WHERE cover_asset_id = ?
       UNION ALL SELECT 'partners',      id, name_ar  FROM partners     WHERE logo_asset_id = ?
       UNION ALL SELECT 'documents',     id, title_ar FROM documents    WHERE asset_id = ?`,
      [assetId, assetId, assetId, assetId, assetId],
    );
    return rows;
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
    await this.driver.remove(storageKey);
  }

  /** `FilesController`'s two routes stream through this rather than reaching the driver directly. */
  async getStream(storageKey: string): Promise<Readable> {
    return this.driver.getStream(storageKey);
  }
}
