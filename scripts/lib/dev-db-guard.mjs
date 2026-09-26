// scripts/lib/dev-db-guard.mjs — C8. Scripts that write to or wipe the
// configured database (db:reset drops it; smoke inserts and deletes rows)
// refuse to start unless NODE_ENV is development/test AND the caller names
// the database explicitly with --confirm=<DB_NAME>. Runs before any
// connection is opened.

import { DEV_ENVS, requireNodeEnv } from './node-env.mjs';

export function requireDevDbConfirmation(scriptName, argv = process.argv.slice(2)) {
  const nodeEnv = requireNodeEnv(scriptName);
  if (!DEV_ENVS.includes(nodeEnv)) {
    console.error(`${scriptName}: refusing to run with NODE_ENV=${nodeEnv}. It is only allowed when NODE_ENV is ${DEV_ENVS.join(' or ')}.`);
    process.exit(1);
  }
  const dbName = process.env.DB_NAME;
  if (!dbName) {
    console.error(`${scriptName}: DB_NAME is not set.`);
    process.exit(1);
  }
  const confirm = argv.find((a) => a.startsWith('--confirm='))?.slice('--confirm='.length);
  if (confirm !== dbName) {
    console.error(
      `${scriptName}: this modifies the database '${dbName}'. Re-run with --confirm=${dbName} to proceed` +
        (confirm === undefined ? '.' : ` (got --confirm=${confirm}).`),
    );
    process.exit(1);
  }
}
