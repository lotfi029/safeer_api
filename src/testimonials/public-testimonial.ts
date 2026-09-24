import type { Testimonial } from '../database/entities/testimonial.entity.js';
import type { TestimonialTheme } from '../database/entities/testimonial-theme.entity.js';

/** Drops `status`, `source`, `sourceMessageId` and timestamps — internal moderation state, not for anonymous visitors. */
export interface PublicTestimonial {
  id: string;
  quoteAr: string;
  quoteEn: string | null;
  authorName: string;
  authorDescAr: string | null;
  authorDescEn: string | null;
  isFeatured: boolean;
  sortOrder: number;
}

export function toPublicTestimonial(t: Testimonial): PublicTestimonial {
  return {
    id: t.id,
    quoteAr: t.quoteAr,
    quoteEn: t.quoteEn,
    authorName: t.authorName,
    authorDescAr: t.authorDescAr,
    authorDescEn: t.authorDescEn,
    isFeatured: t.isFeatured,
    sortOrder: t.sortOrder,
  };
}

export interface PublicTestimonialTheme {
  id: string;
  titleAr: string;
  titleEn: string | null;
  descriptionAr: string | null;
  descriptionEn: string | null;
  isImprovement: boolean;
  sortOrder: number;
}

export function toPublicTestimonialTheme(t: TestimonialTheme): PublicTestimonialTheme {
  return {
    id: t.id,
    titleAr: t.titleAr,
    titleEn: t.titleEn,
    descriptionAr: t.descriptionAr,
    descriptionEn: t.descriptionEn,
    isImprovement: t.isImprovement,
    sortOrder: t.sortOrder,
  };
}
