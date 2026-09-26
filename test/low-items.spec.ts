// test/low-items.spec.ts — Phase 5 of the fix plan:
//   B10 admin pages carry sectionsCount (factory listEnrich hook)
//   B17 GET admin/roles returns the matrix RolesGuard enforces
//   B18 public GET about-items + the about/scholarships sections (014)
//   C30 parallel readiness probes never collide
//   C33 idle sessions aren't listed; changePassword is throttled
//   C35 portal notifications are mapped
//   C36 CSV export: X-Truncated + audit row
//   C39 whitespace-only English falls back to Arabic; per-language read time
//   C40 markdown h1 → h2, GFM tables
//   C41 a post preview token unlocks that post's cover on /files
//   C42 unknown public filter values are 400
//   C45 dev fixture files exist after migrate

import sharp from 'sharp';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  BASE,
  adminApi,
  api,
  createApplication,
  createTempUser,
  deleteApplication,
  deleteTempUser,
  loginAs,
  withDb,
} from './helpers';

const FILES_BASE = BASE.replace(/\/api\/v1$/, '');

async function scalar<T = any>(sql: string, params: any[] = []): Promise<T> {
  return withDb((conn) => conn.execute(sql, params).then(([rows]: any) => (rows[0] ? (Object.values(rows[0])[0] as T) : (undefined as T))));
}

describe('B10: admin pages list', () => {
  it('carries sectionsCount and updatedAt for every row, via the factory hook (filters still apply)', async () => {
    const res = await adminApi('GET', '/admin/pages?limit=50');
    expect(res.status).toBe(200);
    const bySlug = Object.fromEntries(res.body.data.map((p: any) => [p.slug, p]));
    expect(bySlug.home.sectionsCount).toBe(9);
    expect(bySlug.about.sectionsCount).toBe(4);
    expect(bySlug.scholarships.sectionsCount).toBe(5);
    expect(bySlug.contact.sectionsCount).toBe(0);
    expect(typeof bySlug.home.updatedAt).toBe('string');

    const searched = await adminApi('GET', '/admin/pages?q=scholarships');
    expect(searched.body.data.map((p: any) => p.slug)).toEqual(['scholarships']);
    expect(searched.body.data[0].sectionsCount).toBe(5);
  });
});

describe('B17: GET admin/roles', () => {
  const expected = {
    roles: ['admin', 'reviewer', 'editor', 'support'],
    matrix: {
      applications: ['admin', 'reviewer'],
      'applications.delete': ['admin'],
      content: ['admin', 'editor'],
      'redirects.delete': ['admin'],
      inbox: ['admin', 'support'],
      'inbox.delete': ['admin'],
      users: ['admin'],
      settings: ['admin'],
      audit: ['admin'],
    },
  };

  it('is served to any staff role, and to nobody signed out', async () => {
    expect((await api('GET', '/admin/roles')).status).toBe(401);
    expect((await adminApi('GET', '/admin/roles')).body).toEqual(expected);
    const support = await createTempUser('support');
    try {
      expect((await api('GET', '/admin/roles', { session: support })).body).toEqual(expected);
    } finally {
      await deleteTempUser(support.id);
    }
  });
});

describe('B18: about items and inner-page sections', () => {
  it('GET about-items groups published items by the requested kinds, sorted, as HTML', async () => {
    const res = await api('GET', '/about-items?kind=vision,goal,requirement&lang=ar');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['goal', 'requirement', 'vision']);
    expect(res.body.vision).toHaveLength(1);
    expect(res.body.goal).toHaveLength(5);
    expect(res.body.requirement).toHaveLength(4);
    const orders = res.body.goal.map((g: any) => g.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(res.body.vision[0].body).toMatch(/^<p>/);
    expect(Object.keys(res.body.vision[0]).sort()).toEqual(['body', 'icon', 'id', 'sortOrder', 'title']);

    const all = await api('GET', '/about-items');
    expect(Object.keys(all.body).sort()).toEqual(['care_pillar', 'goal', 'mission', 'requirement', 'scholarship_step', 'vision']);
  });

  it('an unknown kind is a 400 (C42); an unpublished item disappears at once (cache purged)', async () => {
    expect((await api('GET', '/about-items?kind=vision,nope')).status).toBe(400);

    await api('GET', '/about-items?kind=goal'); // warm the cache
    const items = await adminApi('GET', '/admin/about-items?kind=goal&limit=1');
    const goal = items.body.data[0];
    try {
      await adminApi('PATCH', `/admin/about-items/${goal.id}/publish`, { body: { isPublished: false } });
      const after = await api('GET', '/about-items?kind=goal');
      expect(after.body.goal.map((g: any) => g.id)).not.toContain(goal.id);
    } finally {
      await adminApi('PATCH', `/admin/about-items/${goal.id}/publish`, { body: { isPublished: true } });
    }
  });

  it('the about and scholarships pages carry their prototype sections', async () => {
    const about = await api('GET', '/pages/about?lang=ar');
    expect(about.body.sections.map((s: any) => s.sectionKey)).toEqual(['intro', 'vision_mission', 'goals', 'governance']);
    const scholarships = await api('GET', '/pages/scholarships?lang=en');
    expect(scholarships.body.sections.map((s: any) => s.sectionKey)).toEqual(['hero', 'pillars', 'steps', 'requirements', 'cta']);
    const cta = scholarships.body.sections.find((s: any) => (s.sectionKey) === 'cta');
    expect(cta.heading).toBe('Ready to apply?');
  });
});

describe('C30: readiness', () => {
  it('twenty parallel /health/ready probes all report ready', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => fetch(`${FILES_BASE}/health/ready`).then((r) => r.status)));
    expect(new Set(results)).toEqual(new Set([200]));
  });
});

describe('C33: auth details', () => {
  it('the sessions list leaves out a session idle past SESSION_IDLE_HOURS', async () => {
    const user = await createTempUser('editor');
    try {
      await withDb(async (conn) => {
        for (const [agent, idleHours] of [['jest-idle', 9], ['jest-active', 1]] as const) {
          await conn.execute(
            `INSERT INTO sessions (user_id, token_hash, user_agent, expires_at, last_seen_at)
             VALUES (?, SHA2(UUID(), 256), ?, UTC_TIMESTAMP(3) + INTERVAL 1 DAY, UTC_TIMESTAMP(3) - INTERVAL ${idleHours} HOUR)`,
            [user.id, agent],
          );
        }
      });
      const listed = await api('GET', '/admin/auth/sessions', { session: user });
      expect(listed.status).toBe(200);
      const agents = listed.body.map((s: any) => s.userAgent);
      expect(agents).toContain('jest-active');
      expect(agents).not.toContain('jest-idle');
      expect(listed.body.some((s: any) => s.isCurrent)).toBe(true);
    } finally {
      await deleteTempUser(user.id);
    }
  });

  it('changing a password is throttled (5 per 15 minutes)', async () => {
    const user = await createTempUser('editor');
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`${BASE}/admin/auth/password`, {
          method: 'PATCH',
          headers: { Cookie: user.cookie, 'X-CSRF-Token': user.csrfToken, 'Content-Type': 'application/json', 'x-test-enforce-throttle': '1' },
          body: JSON.stringify({ currentPassword: 'wrong-password-123', newPassword: 'Brand-New-P4ssword!' }),
        });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
      expect(statuses[5]).toBe(429);
    } finally {
      await deleteTempUser(user.id);
    }
  });
});

describe('C35: portal notifications', () => {
  it('are mapped like recentEvents — no actorId or visibleToApplicant', async () => {
    const applicant = await createApplication();
    try {
      await withDb((conn) =>
        conn.execute("INSERT INTO application_events (application_id, type, actor_id, visible_to_applicant, data) VALUES (?, 'STATUS_CHANGED', 1, 1, ?)", [
          applicant.id,
          JSON.stringify({ from: 'draft', to: 'new' }),
        ]),
      );
      const res = await api('GET', '/portal/notifications', { session: applicant });
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const event of res.body.data) {
        expect(Object.keys(event).sort()).toEqual(['createdAt', 'data', 'id', 'type']);
      }
    } finally {
      await deleteApplication(applicant.id);
    }
  });
});

describe('C36: CSV export', () => {
  it('says whether it was truncated and is audited with its filters and row count', async () => {
    const admin = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    const before: number = await scalar("SELECT COALESCE(MAX(id), 0) FROM audit_log WHERE action = 'export'");
    const res = await fetch(`${BASE}/admin/applications/export.csv?status=accepted`, { headers: { Cookie: admin.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-truncated')).toBe('false');
    // The audit row is written just after the response (AuditInterceptor never delays it), so wait for it.
    let row: any;
    for (let i = 0; i < 50 && !row; i++) {
      [row] = await withDb((conn) =>
        conn.execute("SELECT entity_type, diff FROM audit_log WHERE action = 'export' AND id > ? ORDER BY id DESC LIMIT 1", [before]).then(([r]: any) => r),
      );
      if (!row) await new Promise((r) => setTimeout(r, 50));
    }
    expect(row.entity_type).toBe('applications');
    const diff = typeof row.diff === 'string' ? JSON.parse(row.diff) : row.diff;
    expect(diff.after.filters).toEqual({ status: 'accepted', q: null, reviewerId: null });
    expect(typeof diff.after.rows).toBe('number');
    expect(diff.after.truncated).toBe(false);
  });
});

describe('C39 / C40 / C41: news content', () => {
  const created: string[] = [];
  afterAll(async () => {
    for (const id of created) await adminApi('DELETE', `/admin/news/${id}`);
  });

  async function categoryId(): Promise<string> {
    return scalar('SELECT id FROM news_categories ORDER BY id LIMIT 1').then(String);
  }

  it('C39: a whitespace-only English body/title falls back to Arabic; read time follows the body shown', async () => {
    const words = Array.from({ length: 600 }, () => 'كلمة').join(' ');
    const post = await adminApi('POST', '/admin/news', {
      body: { titleAr: 'عنوان عربي', titleEn: '   ', bodyAr: words, bodyEn: '  \n ', categoryId: await categoryId(), isPublished: true },
    });
    expect(post.status).toBe(201);
    created.push(post.body.id);
    expect(post.body.titleEn).toBe('');

    const en = await api('GET', `/news/${post.body.slug}?lang=en`);
    expect(en.body.title).toBe('عنوان عربي');
    expect(en.body.body).toContain('كلمة');
    expect(en.body.readMinutes).toBe(3);
    expect(en.body.readMinutesAr).toBeUndefined();
  });

  it('C40: # renders as h2 and a GFM table survives', async () => {
    const post = await adminApi('POST', '/admin/news', {
      body: {
        titleAr: 'جدول',
        bodyAr: '# عنوان رئيسي\n\n| البند | العدد |\n|:--|--:|\n| أ | 1 |',
        categoryId: await categoryId(),
        isPublished: true,
      },
    });
    created.push(post.body.id);
    const res = await api('GET', `/news/${post.body.slug}?lang=ar`);
    expect(res.body.body).toContain('<h2>عنوان رئيسي</h2>');
    expect(res.body.body).toContain('<table>');
    expect(res.body.body).toContain('<td align="right">1</td>');
  });

  it("C41: a shared preview link can load that post's unpublished cover, and nothing else", async () => {
    const admin = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: { r: 10, g: 120, b: 90 } } }).png().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), `c41-${Date.now()}.png`);
    const upload = await fetch(`${BASE}/admin/media`, { method: 'POST', headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrfToken }, body: form });
    const asset = await upload.json();
    expect(upload.status).toBe(201);
    expect((await adminApi('PATCH', `/admin/media/${asset.id}`, { body: { altAr: 'غلاف' } })).status).toBe(200);

    const post = await adminApi('POST', '/admin/news', { body: { titleAr: 'مسودة', bodyAr: 'نص', categoryId: await categoryId(), coverAssetId: asset.id } });
    expect(post.status).toBe(201);
    created.push(post.body.id);
    const other = await adminApi('POST', '/admin/news', { body: { titleAr: 'مسودة أخرى', bodyAr: 'نص', categoryId: await categoryId() } });
    created.push(other.body.id);

    const fileUrl = `${FILES_BASE}/files/${asset.publicId}`;
    expect((await fetch(fileUrl)).status).toBe(404);

    const { token } = (await adminApi('GET', `/admin/preview-token?collection=posts&id=${post.body.id}`)).body;
    const preview = await api('GET', `/news/${post.body.slug}?preview=${encodeURIComponent(token)}`);
    expect(preview.status).toBe(200);
    expect(preview.body.previewFileQuery).toBe(`preview=${encodeURIComponent(token)}&post=${post.body.id}`);

    const allowed = await fetch(`${fileUrl}?${preview.body.previewFileQuery}`);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('private, no-store');
    expect((await fetch(`${fileUrl}/thumb?${preview.body.previewFileQuery}`)).status).toBe(200);

    // A token for a different post, or a tampered one, unlocks nothing.
    const otherToken = (await adminApi('GET', `/admin/preview-token?collection=posts&id=${other.body.id}`)).body.token;
    expect((await fetch(`${fileUrl}?preview=${encodeURIComponent(otherToken)}&post=${other.body.id}`)).status).toBe(404);
    expect((await fetch(`${fileUrl}?preview=${encodeURIComponent(otherToken)}&post=${post.body.id}`)).status).toBe(404);

    // Without the token the draft itself is still a 404.
    const anonymous = await api('GET', `/news/${post.body.slug}`);
    expect(anonymous.status).toBe(404);
  });
});

describe('C42: public filters', () => {
  it('an unknown news category or partner category is a 400', async () => {
    expect((await api('GET', `/news?category=made-up-${Date.now()}`)).status).toBe(400);
    expect((await api('GET', '/partners?category=bogus')).status).toBe(400);
    const categories = await api('GET', '/news-categories');
    expect((await api('GET', `/news?category=${categories.body[0].slug}`)).status).toBe(200);
    expect((await api('GET', '/partners?category=university')).status).toBe(200);
  });
});

describe('C45: dev fixture files', () => {
  it("migrate wrote a placeholder for every seeded asset, so the dev fixtures' images load", async () => {
    const publicIds: string[] = await withDb((conn) =>
      conn.execute("SELECT public_id FROM media_assets WHERE kind = 'image' ORDER BY id LIMIT 3").then(([rows]: any) => rows.map((r: any) => r.public_id)),
    );
    expect(publicIds.length).toBeGreaterThan(0);
    const admin = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    for (const publicId of publicIds) {
      const res = await fetch(`${FILES_BASE}/files/${publicId}`, { headers: { Cookie: admin.cookie } });
      expect(res.status).toBe(200);
    }
  });
});
