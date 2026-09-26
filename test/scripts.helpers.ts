// test/scripts.helpers.ts — run the repo's plain-JS scripts as child
// processes against the test MySQL server, with a controlled environment
// (no .env leakage: dotenv never overrides a variable that is already set,
// so every value the script reads is passed explicitly here).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import mysql from 'mysql2/promise';

export const ROOT = path.join(__dirname, '..');

export interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

export function dbEnv(dbName: string, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    // The scripts `import 'dotenv/config'`, which fills any variable not set
    // here from the developer's .env — including ones a test unsets on
    // purpose. Point it at nothing.
    DOTENV_CONFIG_PATH: '/dev/null',
    NODE_ENV: 'test',
    DB_HOST: process.env.TEST_DB_HOST,
    DB_PORT: process.env.TEST_DB_PORT,
    DB_USER: process.env.TEST_DB_USER,
    DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? '',
    DB_NAME: dbName,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export function runScript(script: string, env: NodeJS.ProcessEnv, args: string[] = []): ScriptResult {
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

export async function withServer<T>(fn: (conn: mysql.Connection) => Promise<T>, database?: string): Promise<T> {
  const conn = await mysql.createConnection({
    host: process.env.TEST_DB_HOST,
    port: Number(process.env.TEST_DB_PORT ?? 3306),
    user: process.env.TEST_DB_USER,
    password: process.env.TEST_DB_PASSWORD,
    database,
    charset: 'utf8mb4_unicode_ci',
    multipleStatements: true,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

export async function recreateDatabase(name: string): Promise<void> {
  await withServer(async (conn) => {
    await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  });
}

export async function dropDatabase(name: string): Promise<void> {
  await withServer((conn) => conn.query(`DROP DATABASE IF EXISTS \`${name}\``));
}
