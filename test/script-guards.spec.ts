// test/script-guards.spec.ts — C8: db:reset (drops the database) and smoke
// (writes rows directly) refuse to run unless NODE_ENV is development/test
// and --confirm=<DB_NAME> names the configured database. The guard runs
// before any connection, so these cases never touch a database: DB_NAME
// points at one that doesn't exist, and a successful guard is never reached.

import { dbEnv, runScript } from './scripts.helpers';

const DB = 'safeer_guard_never_created';

describe.each([
  ['db:reset', 'scripts/db-reset.mjs'],
  ['smoke', 'scripts/smoke.mjs'],
])('%s guard (C8)', (name, script) => {
  it('refuses without --confirm', () => {
    const result = runScript(script, dbEnv(DB));
    expect(result.status).toBe(1);
    expect(result.output).toContain(`${name}: this modifies the database '${DB}'. Re-run with --confirm=${DB}`);
  });

  it('refuses when --confirm names a different database', () => {
    const result = runScript(script, dbEnv(DB), ['--confirm=safeer']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('(got --confirm=safeer)');
  });

  it.each(['staging', 'production'])('refuses with NODE_ENV=%s even when confirmed', (nodeEnv) => {
    const result = runScript(script, dbEnv(DB, { NODE_ENV: nodeEnv }), [`--confirm=${DB}`]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`refusing to run with NODE_ENV=${nodeEnv}`);
  });

  it('refuses an unknown or missing NODE_ENV', () => {
    expect(runScript(script, dbEnv(DB, { NODE_ENV: 'dev' }), [`--confirm=${DB}`]).output).toContain('NODE_ENV must be one of');
    expect(runScript(script, dbEnv(DB, { NODE_ENV: undefined }), [`--confirm=${DB}`]).output).toContain('NODE_ENV must be one of');
  });
});

it('db:reset still refuses a non-local DB_HOST once confirmed', () => {
  const result = runScript('scripts/db-reset.mjs', dbEnv(DB, { DB_HOST: 'db.example.com' }), [`--confirm=${DB}`]);
  expect(result.status).toBe(1);
  expect(result.output).toContain('Refusing to reset a non-local DB_HOST');
});
