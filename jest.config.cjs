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
const e2e = {
  displayName: 'e2e',
  rootDir: 'test',
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  // Top-level test/*.spec.ts only — test/unit/ is its own project below.
  testMatch: ['<rootDir>/*.spec.ts'],
  globalSetup: '<rootDir>/global-setup.ts',
  globalTeardown: '<rootDir>/global-teardown.ts',
  // A 30 s per-test timeout (jest.setup.ts): Jest ignores `testTimeout`
  // inside `projects`.
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
};

// Pure helpers from src/ (escaping, validation, CSV, phone numbers …),
// imported directly — no server, no database. src/ imports use the ESM
// `./x.js` form, mapped back to the .ts source here.
const unit = {
  displayName: 'unit',
  rootDir: '.',
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/unit/tsconfig.json' }],
  },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
};

module.exports = {
  projects: [unit, e2e],
  // The suite exercises rate limits (login, OTP, the applications throttle)
  // that are shared per-process state on the one server every spec file
  // talks to — parallel workers would fight over the same counters the way
  // scripts/smoke.mjs's own comments describe. One worker keeps every spec
  // file's throttle budget deterministic.
  maxWorkers: 1,
};
