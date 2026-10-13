// test/org-chart.spec.ts — 023: the organisational structure.
//   admin/org-positions: CRUD, the tree rules (self-parent, missing parent,
//   cycle, depth) as 400 naming parentId, new and moved positions go last
//   among their siblings, delete refused (409 RESOURCE_IN_USE with usages)
//   while sub-positions or members point at it;
//   admin/board: orgPositionId must exist (400), and links a member;
//   GET org-chart: published positions only (an unpublished branch hides its
//   sub-tree), holders only where shown and only published members, names
//   collapsed to the request locale, and a write is visible at once (cache
//   purged).

import { adminApi, api } from './helpers';

describe('org chart (023)', () => {
  const positionIds: string[] = [];
  const memberIds: string[] = [];

  afterAll(async () => {
    for (const id of memberIds) await adminApi('DELETE', `/admin/board/${id}`);
    // children first
    for (const id of [...positionIds].reverse()) await adminApi('DELETE', `/admin/org-positions/${id}`);
  });

  async function createPosition(body: Record<string, unknown>) {
    const res = await adminApi('POST', '/admin/org-positions', { body });
    expect(res.status).toBe(201);
    positionIds.push(res.body.id);
    return res.body;
  }

  it('builds a tree, enforces the tree rules and serves the published chart', async () => {
    const tag = Date.now();
    const root = await createPosition({ nameAr: `الجمعية العمومية ${tag}`, nameEn: `General assembly ${tag}` });
    const board = await createPosition({ nameAr: `مجلس الإدارة ${tag}`, nameEn: `Board ${tag}`, parentId: root.id });
    const ceo = await createPosition({ nameAr: `المدير التنفيذي ${tag}`, parentId: board.id, tone: 'brand' });
    const hidden = await createPosition({ nameAr: `قسم مخفي ${tag}`, parentId: board.id, isPublished: false });
    const underHidden = await createPosition({ nameAr: `تحت المخفي ${tag}`, parentId: hidden.id });

    // New siblings go last.
    expect(ceo.sortOrder).toBeLessThan(hidden.sortOrder);

    // Tree rules → 400 naming parentId.
    for (const [id, parentId, reason] of [
      [board.id, board.id, 'SELF_PARENT'],
      [root.id, ceo.id, 'CYCLE'],
      [ceo.id, '999999999', 'PARENT_NOT_FOUND'],
    ] as const) {
      const res = await adminApi('PATCH', `/admin/org-positions/${id}`, { body: { parentId } });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', field: 'parentId', reason });
    }
    const missingParent = await adminApi('POST', '/admin/org-positions', { body: { nameAr: 'يتيم', parentId: '999999999' } });
    expect(missingParent.status).toBe(400);

    // Depth: root(1) → board(2) → ceo(3) → d4 → d5; a sixth level is refused.
    const d4 = await createPosition({ nameAr: `مستوى 4 ${tag}`, parentId: ceo.id });
    const d5 = await createPosition({ nameAr: `مستوى 5 ${tag}`, parentId: d4.id });
    const tooDeep = await adminApi('POST', '/admin/org-positions', { body: { nameAr: 'مستوى 6', parentId: d5.id } });
    expect(tooDeep.status).toBe(400);
    expect(tooDeep.body.reason).toBe('TOO_DEEP');

    // Members: a bad position is a 400, a good one links.
    const bad = await adminApi('POST', '/admin/board', { body: { nameAr: 'عضو', roleAr: 'عضو', grp: 'board', orgPositionId: '999999999' } });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('orgPositionId');
    const chair = await adminApi('POST', '/admin/board', {
      body: { nameAr: `رئيس المجلس ${tag}`, nameEn: `Chair ${tag}`, roleAr: 'رئيس', grp: 'board', orgPositionId: board.id, isPublished: true },
    });
    expect(chair.status).toBe(201);
    memberIds.push(chair.body.id);
    const draftMember = await adminApi('POST', '/admin/board', {
      body: { nameAr: `عضو مسودة ${tag}`, roleAr: 'عضو', grp: 'board', orgPositionId: board.id, isPublished: false },
    });
    memberIds.push(draftMember.body.id);

    // Public chart, English: names collapsed, unpublished branch and draft member hidden.
    const chart = await api('GET', '/org-chart?lang=en');
    expect(chart.status).toBe(200);
    const mine = chart.body.find((n: any) => n.id === root.id);
    expect(mine).toMatchObject({ name: `General assembly ${tag}`, tone: 'neutral', holders: [] });
    expect(Object.keys(mine).sort()).toEqual(['children', 'holders', 'id', 'name', 'tone']);
    const boardNode = mine.children.find((n: any) => n.id === board.id);
    expect(boardNode).toMatchObject({ name: `Board ${tag}`, tone: 'sky', holders: [{ id: chair.body.id, name: `Chair ${tag}` }] });
    expect(boardNode.children.map((n: any) => n.id)).toEqual([ceo.id]); // `hidden` and its child are gone
    expect(boardNode.children[0]).toMatchObject({ name: `المدير التنفيذي ${tag}`, tone: 'brand' }); // no English → Arabic
    expect(JSON.stringify(chart.body)).not.toContain(String(underHidden.nameAr));

    // Hiding holders on the board position empties its list (cache purged by the write).
    expect((await adminApi('PATCH', `/admin/org-positions/${board.id}`, { body: { showHolders: false } })).status).toBe(200);
    const again = await api('GET', '/org-chart');
    expect(again.body.find((n: any) => n.id === root.id).children.find((n: any) => n.id === board.id).holders).toEqual([]);

    // Delete is refused while sub-positions or members point at the position.
    const inUse = await adminApi('DELETE', `/admin/org-positions/${board.id}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe('RESOURCE_IN_USE');
    const kinds = inUse.body.usages.map((u: any) => u.entity).sort();
    expect(kinds).toContain('board_members');
    expect(kinds).toContain('org_positions');

    // A move goes to the end of the new siblings.
    const moved = await adminApi('PATCH', `/admin/org-positions/${d5.id}`, { body: { parentId: board.id } });
    expect(moved.status).toBe(200);
    expect(moved.body.sortOrder).toBeGreaterThan(hidden.sortOrder);
  });
});
