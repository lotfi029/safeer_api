import type { WorkArea } from '../database/entities/work-area.entity.js';
import type { WorkAreaItem } from '../database/entities/work-area-item.entity.js';

export interface PublicWorkAreaItem {
  id: string;
  textAr: string;
  textEn: string | null;
  sortOrder: number;
}

export function toPublicWorkAreaItem(item: WorkAreaItem): PublicWorkAreaItem {
  return { id: item.id, textAr: item.textAr, textEn: item.textEn, sortOrder: item.sortOrder };
}

export interface PublicWorkArea {
  id: string;
  icon: string | null;
  titleAr: string;
  titleEn: string | null;
  sortOrder: number;
  items: PublicWorkAreaItem[];
}

export function toPublicWorkArea(area: WorkArea, items: WorkAreaItem[]): PublicWorkArea {
  return {
    id: area.id,
    icon: area.icon,
    titleAr: area.titleAr,
    titleEn: area.titleEn,
    sortOrder: area.sortOrder,
    items: items.map(toPublicWorkAreaItem),
  };
}
