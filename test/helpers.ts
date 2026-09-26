// test/helpers.ts — shared utilities for every *.spec.ts file, mirroring
// scripts/smoke.mjs's own conventions (a real HTTP client against the
// running app, a direct mysql2 connection for setup/assertions an
// HTTP-only test can't reach, argon2-hashed temp users). Values come from
// `process.env`, set by global-setup.ts.

import mysql, { type Connection } from 'mysql2/promise';
import * as argon2 from 'argon2';

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
  await conn.query("SET time_zone = '+00:00'");
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

export type StaffRole = 'admin' | 'reviewer' | 'editor' | 'support';

/** A throwaway staff account, created by a direct row insert (see scripts/smoke.mjs's own long comment on why: no invite/accept token round-trip needed for a script's own fixture). */
export async function createTempUser(role: StaffRole): Promise<Session & { id: string; email: string }> {
  const password = 'Jest-Test-P4ssword!';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const email = `jest-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const id = await withDb(async (conn) => {
    const [result] = await conn.execute(
      'INSERT INTO users (name, email, password_hash, role, is_locked, failed_logins) VALUES (?, ?, ?, ?, 0, 0)',
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

export interface TestApplicant extends Session {
  id: string;
  reference: string;
  email: string;
  phone: string;
}

/** `POST applications` — mirrors scripts/smoke.mjs's own createApplication(). */
export async function createApplication(overrides: Record<string, unknown> = {}): Promise<TestApplicant> {
  const email = (overrides.email as string) ?? `jest-app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const body = {
    firstName: overrides.firstName ?? 'Test',
    middleName: overrides.middleName ?? null,
    lastName: overrides.lastName ?? 'Applicant',
    birthDate: overrides.birthDate ?? '2000-01-01',
    phone: overrides.phone ?? `+9665${String(Date.now()).slice(-8)}`,
    nationality: overrides.nationality ?? 'SA',
    idNumber: overrides.idNumber ?? null,
    email,
    currentJob: overrides.currentJob ?? null,
    gender: overrides.gender ?? 'male',
  };
  const res = await fetch(`${BASE}/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`create application failed: ${res.status} ${text}`);
  const json = JSON.parse(text);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('applications did not set a session cookie');
  const cookie = setCookie.split(';')[0];
  const id = await withDb((conn) =>
    conn
      .execute('SELECT id FROM applications WHERE reference = ?', [json.reference])
      .then(([rows]: any) => rows[0]?.id && String(rows[0].id)),
  );
  if (!id) throw new Error(`could not resolve the numeric id for reference ${json.reference}`);
  return { id, reference: json.reference, cookie, csrfToken: json.csrfToken, email, phone: String(body.phone) };
}

export async function deleteApplication(applicationId: string): Promise<void> {
  await withDb(async (conn) => {
    await conn.execute('UPDATE interview_slots SET application_id = NULL WHERE application_id = ?', [applicationId]);
    await conn.execute('DELETE FROM applications WHERE id = ?', [applicationId]);
  });
}

/**
 * C1: OTP codes are no longer readable from sms_log / mail_log (masked), so
 * specs read the last code issued for an application from the dev/test-only
 * hook (src/dev/dev-otp.controller.ts), along with the channel it went out on.
 */
export async function readOtp(applicationId: string): Promise<{ code: string; channel: 'sms' | 'email' }> {
  const res = await fetch(`${BASE}/__dev/otp/${applicationId}`);
  if (!res.ok) throw new Error(`no OTP issued for application ${applicationId} (dev hook answered ${res.status})`);
  return res.json();
}

/** The last code for `applicationId`, which must have gone out by SMS. */
export async function readSmsOtpCode(applicationId: string): Promise<string> {
  const otp = await readOtp(applicationId);
  if (otp.channel !== 'sms') throw new Error(`expected the OTP to go out by sms, it went by ${otp.channel}`);
  return otp.code;
}

/** The last code for `applicationId`, which must have gone out by email. */
export async function readMailOtpCode(applicationId: string): Promise<string> {
  const otp = await readOtp(applicationId);
  if (otp.channel !== 'email') throw new Error(`expected the OTP to go out by email, it went by ${otp.channel}`);
  return otp.code;
}

export async function withSmsEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const before = await adminApi('GET', '/admin/sms/settings');
  const enabled = await adminApi('PUT', '/admin/sms/settings', { body: { isEnabled: true, driver: 'log' } });
  if (enabled.status !== 200) throw new Error(`enabling SMS (log driver) failed: ${enabled.status}`);
  try {
    return await fn();
  } finally {
    await adminApi('PUT', '/admin/sms/settings', { body: { isEnabled: before.body.isEnabled, driver: before.body.driver } });
  }
}

/** A minimal but genuinely valid PDF — real magic bytes, same as scripts/smoke.mjs's own tinyPdf(). */
export function tinyPdf(tag: string): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF jest-${tag}-${Date.now()}`);
}

export async function uploadApplicationDocument(session: Session, docType: string, tag: string): Promise<ApiResult> {
  const form = new FormData();
  form.append('docType', docType);
  form.append('file', new Blob([new Uint8Array(tinyPdf(tag))], { type: 'application/pdf' }), `${tag}.pdf`);
  const res = await fetch(`${BASE}/portal/documents`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken },
    body: form,
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, body: json };
}

/** `POST portal/auth/verify-otp`, returning the applicant session it mints (cookie + csrfToken). */
export async function verifyOtpSession(identifier: string, code: string): Promise<Session> {
  const res = await fetch(`${BASE}/portal/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, code }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`verify-otp failed: ${res.status} ${text}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('verify-otp did not set a session cookie');
  return { cookie: setCookie.split(';')[0], csrfToken: JSON.parse(text).csrfToken };
}
