import { z } from 'zod';

/**
 * Typed environment config (11-architecture.md §6, 13-backend-build-plan.md P1).
 * Parsed once at boot; the process exits on a missing or malformed value.
 * No JWT_SECRET (sessions are server-side, D-06) and no SMTP_* (mail is
 * configured in the dashboard, D-11).
 */
function boolFromString(defaultValue: 'true' | 'false') {
  return z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((v) => v === 'true');
}

/** The local Next.js dev server — FRONTEND_BASE_URL's default outside staging/production. */
const DEV_FRONTEND_BASE_URL = 'http://localhost:4200';

const envSchema = z.object({
  // No default (B0-1): two security behaviours key off this — the session
  // cookie's `secure` flag (auth.controller.ts) and the dev password fixup
  // (bootstrap.service.ts). A deploy that forgot to set it used to fall
  // through to 'development' and silently get both wrong; now it's a
  // startup error instead.
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  PORT: z.coerce.number().int().positive().default(3000),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),
  // C29: the DDL-capable account scripts/migrate.mjs and db-reset.mjs use
  // (scripts/lib/db-connection.mjs). The app never connects with it — it's
  // declared here so the running process's env is validated as one set.
  // Required by the scripts in staging/production; in development/test they
  // fall back to DB_USER/DB_PASSWORD.
  MIGRATION_DB_USER: z.string().min(1).optional(),
  MIGRATION_DB_PASSWORD: z.string().optional(),

  SESSION_COOKIE_NAME: z.string().min(1).default('sf_sid'),
  SESSION_IDLE_HOURS: z.coerce.number().positive().default(8),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().positive().default(30),

  // Student-portal session (Safeer infra change §2) — a second, completely
  // separate cookie/table pair from the staff session above. Longer idle
  // timeout than staff (an applicant fills a multi-step form over lunch),
  // shorter absolute lifetime (nothing sensitive stays reachable for 30 days
  // after a one-time OTP sign-in).
  APPLICANT_SESSION_COOKIE_NAME: z.string().min(1).default('sf_app_sid'),
  APPLICANT_SESSION_IDLE_HOURS: z.coerce.number().positive().default(12),
  APPLICANT_SESSION_ABSOLUTE_DAYS: z.coerce.number().positive().default(7),

  // 32 raw bytes, base64-encoded — encrypts the stored SMTP password (AES-256-GCM).
  // PERMANENT: rotating it makes the stored password unreadable (trap 10).
  APP_ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),

  STORAGE_ROOT: z.string().min(1).default('./var/assets'),

  // Storage abstraction (decision 3, safeer-backend-fix-prompt.md) —
  // B3-4's comment above is now out of date: MediaService/PrivateFileStore
  // go through src/storage/storage-driver.interface.ts, and this is the
  // switch. S3_* below are validated as required only when
  // STORAGE_DRIVER=s3 (the superRefine below) — 'local' needs none of them.
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET_PUBLIC: z.string().min(1).optional(),
  S3_BUCKET_PRIVATE: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  BOOTSTRAP_ADMIN_EMAIL: z.string().email(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8),

  IP_HASH_SALT: z.string().min(1),
  CORS_ORIGINS: z.string().min(1),
  // C2: the public frontend (Next.js) origin. Every link that goes out in a
  // mail or SMS points at a locale-prefixed page there (src/common/frontend-url.ts),
  // never at this API. Required in staging/production (the superRefine
  // below); development/test default to the local frontend. Replaces the
  // old PUBLIC_BASE_URL, which pointed at the API and made every emailed
  // link a 404.
  FRONTEND_BASE_URL: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u), 'FRONTEND_BASE_URL must be an http(s) URL')
    .optional(),

  CACHE_TTL_SECONDS: z.coerce.number().positive().default(60),
  CACHE_MAX_ENTRIES: z.coerce.number().positive().default(500),

  // No FEATURE_* flags: african_api's FEATURE_DONATIONS and
  // FEATURE_LIBRARY_SEARCH gated Home African-specific modules that Safeer
  // does not have (donations, library). Add a flag here only when a real
  // Safeer feature needs one.

  /**
   * B0-1/B0-6: lets BootstrapService turn a pending invitee's placeholder
   * hash (UNUSABLE_PASSWORD_HASH) into BOOTSTRAP_ADMIN_PASSWORD, for local
   * and staging convenience. Deliberately an explicit opt-in rather than
   * "not production" — the failure mode of getting this wrong is a known
   * password on a real account. Refused outright when NODE_ENV=production
   * (see the superRefine below), so the two can never be combined even if
   * a deploy's env is copied carelessly.
   */
  ALLOW_DEV_PASSWORD_FIXUP: boolFromString('false'),
}).superRefine((v, ctx) => {
  if ((v.NODE_ENV === 'production' || v.NODE_ENV === 'staging') && !v.FRONTEND_BASE_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['FRONTEND_BASE_URL'],
      message: `FRONTEND_BASE_URL is required when NODE_ENV=${v.NODE_ENV}`,
    });
  }
  if (v.NODE_ENV === 'production' && v.ALLOW_DEV_PASSWORD_FIXUP) {
    ctx.addIssue({
      code: 'custom',
      path: ['ALLOW_DEV_PASSWORD_FIXUP'],
      message: 'ALLOW_DEV_PASSWORD_FIXUP must be false when NODE_ENV=production',
    });
  }
  if (v.STORAGE_DRIVER === 's3') {
    const required = [
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_BUCKET_PUBLIC',
      'S3_BUCKET_PRIVATE',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ] as const;
    for (const key of required) {
      if (!v[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when STORAGE_DRIVER=s3` });
      }
    }
  }
}).transform((v) => ({
  ...v,
  FRONTEND_BASE_URL: (v.FRONTEND_BASE_URL ?? DEV_FRONTEND_BASE_URL).replace(/\/+$/, ''),
}));

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Validates without caching or exiting — for tests and tooling. */
export function validateEnv(source: NodeJS.ProcessEnv) {
  return envSchema.safeParse(source);
}

/** Parses and validates process.env once. Exits the process on failure. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const result = validateEnv(source);
  if (!result.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment configuration:');
    for (const issue of result.error.issues) {
      // eslint-disable-next-line no-console
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  cached = result.data;
  return cached;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The local environments (scripts/lib/node-env.mjs DEV_ENVS): dev-only hooks, plain-HTTP cookies. */
export const DEV_ENVS: ReadonlyArray<Env['NODE_ENV']> = ['development', 'test'];

export function isDevEnv(env: Pick<Env, 'NODE_ENV'>): boolean {
  return DEV_ENVS.includes(env.NODE_ENV);
}
