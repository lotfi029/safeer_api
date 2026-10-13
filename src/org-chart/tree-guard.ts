/**
 * The org chart's write rules (ported from ta3lom-api common/util/tree-guard.ts):
 * a position can't report to itself, to a position that doesn't exist, or to
 * one of its own descendants (a cycle), and the tree stays at most
 * ORG_MAX_DEPTH levels deep — counted both ways, so moving a position that
 * has children under a deep parent is refused too. Pure, so it is unit-tested
 * without a database; the caller loads the (small) table.
 */
export const ORG_MAX_DEPTH = 5;

export interface TreeRow {
  id: string;
  parentId: string | null;
}

export type TreeGuardError = 'SELF_PARENT' | 'PARENT_NOT_FOUND' | 'CYCLE' | 'TOO_DEEP';

/** Returns why `parentId` can't be `id`'s parent, or null when it can. `id` is null for a new row. */
export function checkParent(rows: TreeRow[], id: string | null, parentId: string | null, maxDepth = ORG_MAX_DEPTH): TreeGuardError | null {
  if (parentId === null) return subtreeDepth(rows, id) > maxDepth ? 'TOO_DEEP' : null;
  if (id !== null && parentId === id) return 'SELF_PARENT';
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (!byId.has(parentId)) return 'PARENT_NOT_FOUND';
  if (id !== null && isDescendant(byId, parentId, id)) return 'CYCLE';
  return depthOf(byId, parentId) + subtreeDepth(rows, id) > maxDepth ? 'TOO_DEEP' : null;
}

/** True when `candidate` sits somewhere under `ancestor`. */
function isDescendant(byId: Map<string, TreeRow>, candidate: string, ancestor: string): boolean {
  const seen = new Set<string>();
  let current = byId.get(candidate)?.parentId ?? null;
  while (current !== null && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}

/** 1 for a root, 2 for its child, … */
function depthOf(byId: Map<string, TreeRow>, id: string): number {
  const seen = new Set<string>();
  let depth = 0;
  let current: string | null = id;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    current = byId.get(current)?.parentId ?? null;
  }
  return depth;
}

/** Levels in the subtree rooted at `id` (1 for a leaf; 1 for a new row). */
function subtreeDepth(rows: TreeRow[], id: string | null): number {
  if (id === null) return 1;
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (r.parentId === null) continue;
    const list = children.get(r.parentId) ?? [];
    list.push(r.id);
    children.set(r.parentId, list);
  }
  const walk = (node: string, seen: Set<string>): number => {
    if (seen.has(node)) return 0;
    seen.add(node);
    let deepest = 0;
    for (const child of children.get(node) ?? []) deepest = Math.max(deepest, walk(child, seen));
    return 1 + deepest;
  };
  return walk(id, new Set());
}
