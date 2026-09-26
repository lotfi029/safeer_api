import type { Post } from '../database/entities/post.entity.js';
import type { NewsCategory } from '../database/entities/news-category.entity.js';
import { toPublicAsset, type PublicMediaAsset } from '../media/public-media-asset.js';

export interface PublicNewsCategory {
  id: string;
  slug: string;
  nameAr: string;
  nameEn: string | null;
  sortOrder: number;
}

export function toPublicNewsCategory(category: NewsCategory): PublicNewsCategory {
  return { id: category.id, slug: category.slug, nameAr: category.nameAr, nameEn: category.nameEn, sortOrder: category.sortOrder };
}

/**
 * The subset of `Post` safe to serve to anonymous visitors — drops `author`
 * entirely (the joined `User`, including its `passwordHash`, must never
 * reach an anonymous cached route), plus `createdBy`, `isLegacy`,
 * `isPublished`, `createdAt`/`updatedAt`. `bodyAr`/`bodyEn` are omitted from
 * the list shape (`toPublicPostSummary`) — the feed only needs the excerpt —
 * and included, already Markdown-rendered, on the detail shape
 * (`toPublicPostDetail`).
 */
export interface PublicPostSummary {
  id: string;
  slug: string;
  titleAr: string;
  titleEn: string | null;
  excerptAr: string | null;
  excerptEn: string | null;
  publishedOn: string | null;
  isFeatured: boolean;
  coverAsset: PublicMediaAsset | null;
  category: PublicNewsCategory | null;
}

export function toPublicPostSummary(post: Post): PublicPostSummary {
  return {
    id: post.id,
    slug: post.slug,
    titleAr: post.titleAr,
    titleEn: post.titleEn,
    excerptAr: post.excerptAr,
    excerptEn: post.excerptEn,
    publishedOn: post.publishedOn,
    isFeatured: post.isFeatured,
    coverAsset: toPublicAsset(post.coverAsset),
    category: post.category ? toPublicNewsCategory(post.category) : null,
  };
}

const WORDS_PER_MINUTE = 200;

export function estimateReadMinutes(text: string | null | undefined): number {
  if (!text) return 1;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
}

export interface PublicPostDetail extends PublicPostSummary {
  bodyAr: string | null;
  bodyEn: string | null;
  /**
   * C39: a rounded estimate per language, from that body's own word count
   * at ~200 words/minute; `readMinutesEn` is null without an English body.
   * The public locale collapse turns the pair into one `readMinutes`, so it
   * always matches the body actually shown.
   */
  readMinutesAr: number;
  readMinutesEn: number | null;
  related: PublicPostSummary[];
  /**
   * C41: only on a preview (a verified `?preview=` token) — append it to
   * this post's `/files/…` URLs so an unpublished cover loads for a viewer
   * without a session.
   */
  previewFileQuery?: string;
}

export function toPublicPostDetail(post: Post, related: Post[]): PublicPostDetail {
  return {
    ...toPublicPostSummary(post),
    bodyAr: post.bodyAr,
    bodyEn: post.bodyEn,
    readMinutesAr: estimateReadMinutes(post.bodyAr),
    readMinutesEn: post.bodyEn && post.bodyEn.trim() ? estimateReadMinutes(post.bodyEn) : null,
    related: related.map(toPublicPostSummary),
  };
}
