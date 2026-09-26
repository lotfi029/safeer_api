// test/permissions.spec.ts — Phase 6 (safeer-backend-fix-prompt.md), area 1.
//
// There is no real `GET admin/roles` endpoint in this codebase (only
// mentioned in README.md's prose) to generate the matrix from, so this is
// built by hand from that same README table instead. Covers: role ×
// admin-area access/refusal, the unauthenticated 401, and staff/applicant
// cookies never being accepted on each other's routes.

import { adminApi, api, createApplication, createTempUser, deleteApplication, deleteTempUser, type StaffRole } from './helpers';

// One representative admin-area route per matrix row (README.md's own table).
const ADMIN_ONLY = ['/admin/users', '/admin/settings'];
const APPLICATIONS_AREA = '/admin/applications';
const CONTENT_AREA = '/admin/news';
const MESSAGES_AREA = '/admin/messages';

describe('permissions matrix', () => {
  const users: Record<StaffRole, Awaited<ReturnType<typeof createTempUser>>> = {} as any;

  beforeAll(async () => {
    for (const role of ['reviewer', 'editor', 'support'] as StaffRole[]) {
      users[role] = await createTempUser(role);
    }
  });

  afterAll(async () => {
    for (const role of ['reviewer', 'editor', 'support'] as StaffRole[]) {
      await deleteTempUser(users[role].id);
    }
  });

  it('admin reaches every admin area', async () => {
    for (const path of [...ADMIN_ONLY, APPLICATIONS_AREA, CONTENT_AREA, MESSAGES_AREA]) {
      const res = await adminApi('GET', path);
      expect(res.status).toBe(200);
    }
  });

  it('reviewer reaches applications but not content, messages or admin-only areas', async () => {
    expect((await api('GET', APPLICATIONS_AREA, { session: users.reviewer })).status).toBe(200);
    for (const path of [CONTENT_AREA, MESSAGES_AREA, ...ADMIN_ONLY]) {
      const res = await api('GET', path, { session: users.reviewer });
      expect(res.status).toBe(403);
      expect(res.body?.code).toBe('FORBIDDEN');
    }
  });

  it('editor reaches content but not applications, messages or admin-only areas', async () => {
    expect((await api('GET', CONTENT_AREA, { session: users.editor })).status).toBe(200);
    for (const path of [APPLICATIONS_AREA, MESSAGES_AREA, ...ADMIN_ONLY]) {
      const res = await api('GET', path, { session: users.editor });
      expect(res.status).toBe(403);
    }
  });

  it('support reaches messages but not applications, content or admin-only areas', async () => {
    expect((await api('GET', MESSAGES_AREA, { session: users.support })).status).toBe(200);
    for (const path of [APPLICATIONS_AREA, CONTENT_AREA, ...ADMIN_ONLY]) {
      const res = await api('GET', path, { session: users.support });
      expect(res.status).toBe(403);
    }
  });

  it('an unauthenticated request to an admin route is 401', async () => {
    const res = await api('GET', APPLICATIONS_AREA);
    expect(res.status).toBe(401);
    expect(res.body?.code).toBe('UNAUTHENTICATED');
  });

  it('a staff cookie is refused on a portal (applicant) route, and vice versa', async () => {
    const applicant = await createApplication();
    try {
      // Staff session on an applicant-only route.
      const staffOnPortal = await api('GET', '/portal/me', { session: users.reviewer });
      expect(staffOnPortal.status).toBe(401);

      // Applicant session on a staff-only route.
      const applicantOnAdmin = await api('GET', '/admin/applications', { session: applicant });
      expect(applicantOnAdmin.status).toBe(401);
    } finally {
      await deleteApplication(applicant.id);
    }
  });
});
