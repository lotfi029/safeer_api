// test/node-env.spec.ts — C11: the plain-JS scripts' NODE_ENV list
// (scripts/lib/node-env.mjs) must be exactly the z.enum src/config/env.ts
// accepts. The scripts can't import env.ts (they run before a build), so
// this is what keeps the two lists from drifting.

import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');

function stringList(source: string, pattern: RegExp): string[] {
  const match = source.match(pattern);
  if (!match) throw new Error(`pattern ${pattern} not found`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('NODE_ENV values (C11)', () => {
  const envTs = readFileSync(path.join(ROOT, 'src/config/env.ts'), 'utf8');
  const nodeEnvMjs = readFileSync(path.join(ROOT, 'scripts/lib/node-env.mjs'), 'utf8');

  it('scripts/lib/node-env.mjs NODE_ENVS equals the env.ts enum', () => {
    const fromEnvTs = stringList(envTs, /NODE_ENV:\s*z\.enum\(\[([^\]]*)\]\)/);
    const fromScripts = stringList(nodeEnvMjs, /export const NODE_ENVS = \[([^\]]*)\]/);
    expect(fromScripts).toEqual(fromEnvTs);
  });

  it('only development and test get dev fixtures and dev-only tooling', () => {
    expect(stringList(nodeEnvMjs, /export const DEV_ENVS = \[([^\]]*)\]/)).toEqual(['development', 'test']);
  });
});
