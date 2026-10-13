import type { BoardMember } from '../database/entities/board-member.entity.js';
import type { OrgPosition, OrgTone } from '../database/entities/org-position.entity.js';
import { ORG_MAX_DEPTH } from './tree-guard.js';

export type ResolvedTone = Exclude<OrgTone, 'auto'>;

/**
 * One box of GET /org-chart. `nameAr/nameEn` stay as pairs so
 * LocaleInterceptor collapses them into `name` (it recurses into `holders`
 * and `children`).
 */
export interface PublicOrgHolder {
  id: string;
  nameAr: string;
  nameEn: string | null;
}

export interface PublicOrgNode {
  id: string;
  nameAr: string;
  nameEn: string | null;
  tone: ResolvedTone;
  holders: PublicOrgHolder[];
  children: PublicOrgNode[];
}

/** ta3lom's depth palette for `auto`: neutral, sky, green, then brand from the fourth level. */
const AUTO_TONES: ResolvedTone[] = ['neutral', 'sky', 'green', 'brand'];

export function resolveTone(tone: OrgTone, depth: number): ResolvedTone {
  if (tone !== 'auto') return tone;
  return AUTO_TONES[Math.min(depth, AUTO_TONES.length - 1)];
}

/**
 * Builds the published forest. `positions` and `members` are already filtered
 * to published rows and sorted (sortOrder, id). A position whose parent is
 * not in `positions` (unpublished) is dropped with its whole branch; holders
 * appear only on positions with `showHolders`.
 */
export function buildOrgForest(positions: OrgPosition[], members: BoardMember[]): PublicOrgNode[] {
  const ids = new Set(positions.map((p) => p.id));
  const children = new Map<string | null, OrgPosition[]>();
  for (const p of positions) {
    if (p.parentId !== null && !ids.has(p.parentId)) continue; // parent unpublished: the branch is hidden
    const list = children.get(p.parentId) ?? [];
    list.push(p);
    children.set(p.parentId, list);
  }
  const holders = new Map<string, PublicOrgHolder[]>();
  for (const m of members) {
    if (!m.orgPositionId) continue;
    const list = holders.get(m.orgPositionId) ?? [];
    list.push({ id: m.id, nameAr: m.nameAr, nameEn: m.nameEn });
    holders.set(m.orgPositionId, list);
  }
  const build = (parent: string | null, depth: number): PublicOrgNode[] =>
    depth >= ORG_MAX_DEPTH
      ? []
      : (children.get(parent) ?? []).map((p) => ({
          id: p.id,
          nameAr: p.nameAr,
          nameEn: p.nameEn,
          tone: resolveTone(p.tone, depth),
          holders: p.showHolders ? (holders.get(p.id) ?? []) : [],
          children: build(p.id, depth + 1),
        }));
  return build(null, 0);
}
