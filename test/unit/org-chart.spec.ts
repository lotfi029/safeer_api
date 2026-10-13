// test/unit/org-chart.spec.ts — 023: the org chart's pure parts — the tree
// guard (self-parent, missing parent, cycle, depth counted both ways) and the
// public forest builder (unpublished branches hidden, holders only where
// shown, `auto` tone by depth).

import { checkParent, type TreeRow } from '../../src/org-chart/tree-guard';
import { buildOrgForest, resolveTone } from '../../src/org-chart/public-org-chart';
import type { OrgPosition } from '../../src/database/entities/org-position.entity';
import type { BoardMember } from '../../src/database/entities/board-member.entity';

// 1 → 2 → 3 → 4, and 5 under 1.
const rows: TreeRow[] = [
  { id: '1', parentId: null },
  { id: '2', parentId: '1' },
  { id: '3', parentId: '2' },
  { id: '4', parentId: '3' },
  { id: '5', parentId: '1' },
];

describe('checkParent', () => {
  it('accepts a root, a new child and a valid move', () => {
    expect(checkParent(rows, null, null)).toBeNull();
    expect(checkParent(rows, null, '4')).toBeNull(); // 5th level
    expect(checkParent(rows, '5', '2')).toBeNull();
  });

  it('refuses self, a missing parent and a cycle', () => {
    expect(checkParent(rows, '2', '2')).toBe('SELF_PARENT');
    expect(checkParent(rows, null, '99')).toBe('PARENT_NOT_FOUND');
    expect(checkParent(rows, '2', '4')).toBe('CYCLE');
    expect(checkParent(rows, '1', '3')).toBe('CYCLE');
  });

  it('counts depth both ways', () => {
    const five = [...rows, { id: '6', parentId: '4' }]; // 1→2→3→4→6 is five levels
    expect(checkParent(five, null, '6')).toBe('TOO_DEEP'); // a sixth level
    // Moving 2 (three levels below it: 3, 4, 6) under 5 (depth 2) would make 2+4 = 6 levels.
    expect(checkParent(five, '2', '5')).toBe('TOO_DEEP');
    expect(checkParent(rows, '2', '5')).toBeNull(); // 2 + 3 = 5 levels
  });
});

function position(id: string, parentId: string | null, extra: Partial<OrgPosition> = {}): OrgPosition {
  return { id, parentId, nameAr: `منصب ${id}`, nameEn: null, tone: 'auto', showHolders: true, isPublished: true, sortOrder: 0, ...extra } as OrgPosition;
}

function member(id: string, orgPositionId: string | null): BoardMember {
  return { id, orgPositionId, nameAr: `عضو ${id}`, nameEn: `Member ${id}` } as BoardMember;
}

describe('buildOrgForest', () => {
  it('nests children, keeps order, resolves auto tones by depth and adds holders', () => {
    const forest = buildOrgForest(
      [position('1', null), position('2', '1'), position('3', '1', { tone: 'brand' }), position('4', '2')],
      [member('10', '1'), member('11', '1'), member('12', '4')],
    );
    expect(forest).toHaveLength(1);
    expect(forest[0]).toMatchObject({ id: '1', tone: 'neutral', holders: [{ id: '10' }, { id: '11' }] });
    expect(forest[0].children.map((c) => [c.id, c.tone])).toEqual([
      ['2', 'sky'],
      ['3', 'brand'],
    ]);
    expect(forest[0].children[0].children[0]).toMatchObject({ id: '4', tone: 'green', holders: [{ id: '12', nameAr: 'عضو 12' }] });
  });

  it('drops a branch under an unpublished parent and hides holders when not shown', () => {
    // 2 is not in the (published) list, so 4 under it disappears with it.
    const forest = buildOrgForest([position('1', null, { showHolders: false }), position('4', '2')], [member('10', '1')]);
    expect(forest).toEqual([{ id: '1', nameAr: 'منصب 1', nameEn: null, tone: 'neutral', holders: [], children: [] }]);
  });

  it('maps auto to the depth palette, brand from the fourth level on', () => {
    expect([0, 1, 2, 3, 4].map((d) => resolveTone('auto', d))).toEqual(['neutral', 'sky', 'green', 'brand', 'brand']);
    expect(resolveTone('sky', 3)).toBe('sky');
  });
});
