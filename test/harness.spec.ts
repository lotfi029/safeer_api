// test/harness.spec.ts — proves the harness itself works: global-setup.ts
// created and migrated a real test database and booted the compiled app
// against it, and supertest can drive that running instance.

import request from 'supertest';
import { withDb } from './helpers';

const ORIGIN = new URL(process.env.TEST_BASE_URL!).origin;

describe('test harness', () => {
  it('boots the app: /health and /health/ready answer', async () => {
    await request(ORIGIN).get('/health').expect(200);
    const ready = await request(ORIGIN).get('/health/ready').expect(200);
    expect(ready.body.checks?.database).toBe('up');
  });

  it('serves the versioned API from the migrated test database', async () => {
    const site = await request(ORIGIN).get('/api/v1/site').expect(200);
    expect(site.body).toBeTruthy();
    const applied = await withDb((conn) =>
      conn.query('SELECT COUNT(*) AS c FROM schema_migrations WHERE checksum IS NOT NULL').then(([rows]: any) => Number(rows[0].c)),
    );
    expect(applied).toBeGreaterThanOrEqual(4);
  });

  it('runs the app off-UTC (C9), so every spec exercises the UTC pinning', () => {
    expect(process.env.TEST_APP_TZ).toBeTruthy();
  });
});
