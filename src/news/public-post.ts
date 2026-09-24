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

export interface PublicPostDetail extends PublicPostSummary {
  bodyAr: string | null;
  bodyEn: string | null;
  /** Rounded estimate, computed from the raw Markdown word count at ~200 words/minute. */
  readMinutes: number;
  related: PublicPostSummary[];
}

export function toPublicPostDetail(post: Post, readMinutes: number, related: Post[]): PublicPostDetail {
  return {
    ...toPublicPostSummary(post),
    bodyAr: post.bodyAr,
    bodyEn: post.bodyEn,
    readMinutes,
    related: related.map(toPublicPostSummary),
  };
}
