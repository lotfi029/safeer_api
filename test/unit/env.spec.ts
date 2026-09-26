// src/config/env.ts cross-field rules: S3 settings (Phase 6), the frontend
// URL outside dev (C2), and the dev password fixup never in production.
import { validateEnv } from '../../src/config/env';

const base = {
  NODE_ENV: 'development',
  DB_HOST: '127.0.0.1',
  DB_USER: 'safeer',
  DB_PASSWORD: '',
  DB_NAME: 'safeer',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
  BOOTSTRAP_ADMIN_PASSWORD: 'long-enough-password',
  IP_HASH_SALT: 'salt',
  CORS_ORIGINS: 'http://localhost:4200',
};

const s3 = {
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://s3.example.test',
  S3_REGION: 'auto',
  S3_BUCKET_PUBLIC: 'pub',
  S3_BUCKET_PRIVATE: 'priv',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret',
};

function issues(source: Record<string, string>): string[] {
  const result = validateEnv(source);
  return result.success ? [] : result.error.issues.map((i) => String(i.path[0]));
}

describe('env validation', () => {
  it('the baseline is valid, with local storage and a 300 s signed-URL TTL by default', () => {
    const result = validateEnv(base);
    expect(result.success).toBe(true);
    expect(result.data!.STORAGE_DRIVER).toBe('local');
    expect(result.data!.S3_SIGNED_URL_TTL_SECONDS).toBe(300);
  });

  it('STORAGE_DRIVER=s3 needs every S3 setting', () => {
    expect(issues({ ...base, ...s3 })).toEqual([]);
    for (const key of Object.keys(s3).filter((k) => k !== 'STORAGE_DRIVER')) {
      const { [key]: _omitted, ...rest } = s3 as Record<string, string>;
      expect(issues({ ...base, ...rest })).toContain(key);
    }
  });

  it('staging and production need FRONTEND_BASE_URL; development does not', () => {
    expect(issues({ ...base, NODE_ENV: 'production' })).toContain('FRONTEND_BASE_URL');
    expect(issues({ ...base, NODE_ENV: 'staging' })).toContain('FRONTEND_BASE_URL');
    expect(issues({ ...base, NODE_ENV: 'production', FRONTEND_BASE_URL: 'https://safeer-sa.org' })).toEqual([]);
  });

  it('refuses ALLOW_DEV_PASSWORD_FIXUP in production', () => {
    expect(issues({ ...base, NODE_ENV: 'production', FRONTEND_BASE_URL: 'https://safeer-sa.org', ALLOW_DEV_PASSWORD_FIXUP: 'true' })).toContain(
      'ALLOW_DEV_PASSWORD_FIXUP',
    );
  });
});
