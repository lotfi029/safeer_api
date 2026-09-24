import type { Stat } from '../database/entities/stat.entity.js';
import type { AboutItem } from '../database/entities/about-item.entity.js';

/**
 * `stats`/`about_items` have no public route of their own (unlike work
 * areas, board, news, testimonials, partners, documents) — `GET /home` is
 * the only anonymous consumer, so their public projections live here rather
 * than in a `public-stat.ts`/`public-about-item.ts` file nobody else would
 * import.
 */
export interface PublicStat {
  id: string;
  value: string | null;
  labelAr: string;
  labelEn: string | null;
  subAr: string | null;
  subEn: string | null;
  sortOrder: number;
}

export function toPublicStat(stat: Stat): PublicStat {
  return {
    id: stat.id,
    value: stat.value,
    labelAr: stat.labelAr,
    labelEn: stat.labelEn,
    subAr: stat.subAr,
    subEn: stat.subEn,
    sortOrder: stat.sortOrder,
  };
}

export interface PublicAboutItem {
  id: string;
  icon: string | null;
  titleAr: string;
  titleEn: string | null;
  bodyAr: string | null;
  bodyEn: string | null;
  sortOrder: number;
}

export function toPublicAboutItem(item: AboutItem): PublicAboutItem {
  return {
    id: item.id,
    icon: item.icon,
    titleAr: item.titleAr,
    titleEn: item.titleEn,
    bodyAr: item.bodyAr,
    bodyEn: item.bodyEn,
    sortOrder: item.sortOrder,
  };
}
