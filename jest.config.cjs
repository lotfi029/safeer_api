// jest.config.cjs — plain CommonJS on purpose (a `.cjs` file is always
// CommonJS regardless of the repo's own `"type": "module"`), same trick
// `test/package.json` ({"type":"commonjs"}) uses: it lets ts-jest run in
// its default (non-ESM) mode for the test suite without fighting Node's
// ESM loader, since spec files never `import` compiled src/ ESM output —
// they talk to a real, already-booted server over HTTP and to a real
// MySQL test database directly (mysql2), exactly like scripts/smoke.mjs.
//
// Phase 6 (safeer-backend-fix-prompt.md): Jest + ts-jest + supertest, a
// real MySQL database created and migrated in globalSetup, no ORM mock.
module.exports = {
  rootDir: 'test',
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  testMatch: ['**/*.spec.ts'],
  globalSetup: '<rootDir>/global-setup.ts',
  globalTeardown: '<rootDir>/global-teardown.ts',
  // Each spec file drives the same shared server/database — a slow OTP
  // lockout case or a large bulk action next to it would otherwise stall
  // the rest of the suite behind Jest's default 5s.
  testTimeout: 30_000,
  // The suite exercises rate limits (login, OTP, the applications throttle)
  // that are shared per-process state on the one server every spec file
  // talks to — parallel workers would fight over the same counters the way
  // scripts/smoke.mjs's own comments describe. One worker keeps every spec
  // file's throttle budget deterministic.
  maxWorkers: 1,
};
