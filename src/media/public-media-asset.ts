import type { MediaAsset } from '../database/entities/media-asset.entity.js';

/**
 * The subset of `MediaAsset` safe to serve to anonymous visitors. Drops
 * `storageKey` (an on-disk path), `checksumSha256`, `originalName` and
 * `uploadedBy` — none of which the public site needs and none of which
 * should be readable by anyone who isn't an editor (B0-0/B0-3). `altAr`/
 * `altEn` stay as a pair so `LocaleInterceptor` still collapses them into
 * `alt`.
 *
 * Shared by every public controller that joins a `MediaAsset` relation
 * (news, library, governance, home) — one projection, not one per caller.
 */
export interface PublicMediaAsset {
  id: string;
  publicId: string;
  kind: MediaAsset['kind'];
  mimeType: string;
  sizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
  altAr: string | null;
  altEn: string | null;
}

export function toPublicAsset(asset: MediaAsset | null | undefined): PublicMediaAsset | null {
  if (!asset) return null;
  return {
    id: asset.id,
    publicId: asset.publicId,
    kind: asset.kind,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    widthPx: asset.widthPx,
    heightPx: asset.heightPx,
    altAr: asset.altAr,
    altEn: asset.altEn,
  };
}
