// test/helpers.ts — shared utilities for every *.spec.ts file, mirroring
// scripts/smoke.mjs's own conventions (a real HTTP client against the
// running app, a direct mysql2 connection for setup/assertions an
// HTTP-only test can't reach, argon2-hashed temp users). Values come from
// `process.env`, set by global-setup.ts.

import mysql, { type Connection } from 'mysql2/promise';
import * as argon2 from 'argon2';
import { UTC_SESSION_SQL } from '../src/database/utc';

export const BASE = process.env.TEST_BASE_URL!;
export const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL!;
export const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD!;

export interface Session {
  cookie: string;
  csrfToken: string;
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export async function api<T = any>(
  method: string,
  path: string,
  opts: { body?: unknown; session?: Session } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = opts.session ? { Cookie: opts.session.cookie } : {};
  if (method !== 'GET' && opts.session) headers['X-CSRF-Token'] = opts.session.csrfToken;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

export async function loginAs(email: string, password: string): Promise<Session> {
  const res = await fetch(`${BASE}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`login failed: ${res.status} ${text}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('login did not set a session cookie');
  const cookie = setCookie.split(';')[0];
  const csrfToken = JSON.parse(text).csrfToken;
  if (!csrfToken) throw new Error('login response carried no csrfToken');
  return { cookie, csrfToken };
}

let adminSession: Session | undefined;
/** The bootstrap admin's session, logged in once and reused across specs (mirrors scripts/smoke.mjs's module-level `admin`). */
export async function adminApi<T = any>(method: string, path: string, opts: { body?: unknown } = {}): Promise<ApiResult<T>> {
  if (!adminSession) adminSession = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  return api<T>(method, path, { ...opts, session: adminSession });
}

export async function withDb<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({
    host: process.env.TEST_DB_HOST,
    port: Number(process.env.TEST_DB_PORT ?? 3306),
    user: process.env.TEST_DB_USER,
    password: process.env.TEST_DB_PASSWORD,
    database: process.env.TEST_DB_NAME,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z', // C9: same clock as the app (src/database/utc.ts)
  });
  await conn.query(UTC_SESSION_SQL); // C9 + A3: same session settings as the app
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

export type StaffRole = 'admin' | 'editor' | 'support';

/** A throwaway staff account, created by a direct row insert (see scripts/smoke.mjs's own long comment on why: no invite/accept token round-trip needed for a script's own fixture). */
export async function createTempUser(role: StaffRole): Promise<Session & { id: string; email: string }> {
  const password = 'Jest-Test-P4ssword!';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const email = `jest-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const id = await withDb(async (conn) => {
    const [result] = await conn.execute(
      "INSERT INTO users (name, email, password_hash, role, status, failed_logins) VALUES (?, ?, ?, ?, 'active', 0)",
      [`Jest ${role}`, email, passwordHash, role],
    );
    return String((result as any).insertId);
  });
  const session = await loginAs(email, password);
  return { id, email, ...session };
}

export async function deleteTempUser(id: string): Promise<void> {
  await withDb((conn) => conn.execute('DELETE FROM users WHERE id = ?', [id]));
}

/** A minimal but genuinely valid PDF — real magic bytes, same as scripts/smoke.mjs's own tinyPdf(). */
export function tinyPdf(tag: string): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF jest-${tag}-${Date.now()}`);
}

/**
 * C33: `POST admin/auth/forgot` answers before it looks the address up, so a
 * spec waits for the reset token to appear (or, for "nothing is sent",
 * lets the background work finish before checking).
 */
export async function waitForAuthToken(userId: string, purpose = 'reset', timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [rows]: any = await withDb((conn) => conn.execute('SELECT id FROM auth_tokens WHERE user_id = ? AND purpose = ?', [userId, purpose]));
    if (rows.length > 0) return;
    if (Date.now() > deadline) throw new Error(`no ${purpose} token for user ${userId} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const settleForgot = () => new Promise((r) => setTimeout(r, 500));

/** A4: waits until work routes hand to BackgroundWork is done (`__dev/settle`). */
export async function settleBackground(): Promise<void> {
  const res = await fetch(`${BASE}/__dev/settle`, { method: 'POST' });
  if (!res.ok) throw new Error(`__dev/settle answered ${res.status}`);
}
