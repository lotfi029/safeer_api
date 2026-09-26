// scripts/lib/node-env.mjs — the NODE_ENV values the plain-JS scripts accept
// (C11). NODE_ENVS must equal the z.enum in src/config/env.ts;
// test/node-env.spec.ts fails if the two drift apart. The scripts can't
// import env.ts itself: migrate.mjs and db-reset.mjs run before (and
// without) a build.

export const NODE_ENVS = ['development', 'test', 'staging', 'production'];

/** Environments that get migrations/dev/ fixtures and may run destructive dev tooling (db:reset, smoke). */
export const DEV_ENVS = ['development', 'test'];

/** Returns NODE_ENV, or exits 1 when it is missing or not one of NODE_ENVS. */
export function requireNodeEnv(scriptName) {
  const nodeEnv = process.env.NODE_ENV;
  if (!nodeEnv || !NODE_ENVS.includes(nodeEnv)) {
    console.error(`${scriptName}: NODE_ENV must be one of ${NODE_ENVS.join(', ')} (got ${nodeEnv ? `'${nodeEnv}'` : 'nothing'}).`);
    process.exit(1);
  }
  return nodeEnv;
}
