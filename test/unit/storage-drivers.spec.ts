// Phase 6 (decision 3): the storage drivers behave the same from a caller's
// point of view — missing keys, deletes, readiness — and the local driver
// never leaves STORAGE_ROOT.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { LocalStorageDriver } from '../../src/storage/local-storage.driver';
import { S3StorageDriver } from '../../src/storage/s3-storage.driver';
import { StorageObjectNotFoundError } from '../../src/storage/storage-driver.interface';
import { ProblemException } from '../../src/common/problem-details/problem.exception';
import type { Env } from '../../src/config/env';

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

describe('LocalStorageDriver', () => {
  let root: string;
  let driver: LocalStorageDriver;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'safeer-storage-'));
    driver = new LocalStorageDriver({ STORAGE_ROOT: root } as Env);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes under STORAGE_ROOT (creating directories) and reads it back', async () => {
    await driver.put('assets/2026/09/a.txt', Buffer.from('hello'));
    expect(await readAll(await driver.getStream('assets/2026/09/a.txt'))).toBe('hello');
  });

  it.each(['../outside.txt', 'assets/../../outside.txt', '/etc/passwd', 'a/../../b'])('refuses the traversal key %j', async (key) => {
    await expect(driver.put(key, Buffer.from('x'))).rejects.toBeInstanceOf(ProblemException);
    await expect(driver.getStream(key)).rejects.toBeInstanceOf(ProblemException);
  });

  it('a missing key rejects with StorageObjectNotFoundError', async () => {
    await expect(driver.getStream('assets/missing.jpg')).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it('remove is a no-op for a missing key and deletes an existing one', async () => {
    await expect(driver.remove('assets/missing.jpg')).resolves.toBeUndefined();
    mkdirSync(path.join(root, 'assets'), { recursive: true });
    writeFileSync(path.join(root, 'assets', 'b.txt'), 'x');
    await driver.remove('assets/b.txt');
    await expect(driver.getStream('assets/b.txt')).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it('healthCheck: true for a writable root (created if missing), false when it cannot be created', async () => {
    expect(await new LocalStorageDriver({ STORAGE_ROOT: path.join(root, 'new', 'dir') } as Env).healthCheck()).toBe(true);
    writeFileSync(path.join(root, 'file'), 'x');
    expect(await new LocalStorageDriver({ STORAGE_ROOT: path.join(root, 'file', 'sub') } as Env).healthCheck()).toBe(false);
  });
});

describe('S3StorageDriver', () => {
  const env = {
    S3_ENDPOINT: 'https://s3.example.test',
    S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_BUCKET_PUBLIC: 'safeer-public',
    S3_BUCKET_PRIVATE: 'safeer-private',
    S3_SIGNED_URL_TTL_SECONDS: 300,
  } as Env;

  function withSend(bucket: 'public' | 'private', send: jest.Mock) {
    const driver = new S3StorageDriver(env, bucket);
    (driver as any).client.send = send;
    return driver;
  }

  it('put/getStream/remove address the bucket chosen at construction', async () => {
    const send = jest.fn().mockResolvedValue({ Body: Readable.from(['data']) });
    const driver = withSend('private', send);
    await driver.put('private/applications/1/x.pdf', Buffer.from('pdf'));
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[0][0].input).toMatchObject({ Bucket: 'safeer-private', Key: 'private/applications/1/x.pdf' });

    expect(await readAll(await driver.getStream('k'))).toBe('data');
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);

    await driver.remove('k');
    expect(send.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[2][0].input).toEqual({ Bucket: 'safeer-private', Key: 'k' });
  });

  it('a NoSuchKey on get becomes StorageObjectNotFoundError; other errors pass through', async () => {
    const missing = withSend('public', jest.fn().mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchKey' })));
    await expect(missing.getStream('k')).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    const denied = withSend('public', jest.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' })));
    await expect(denied.getStream('k')).rejects.toThrow('denied');
  });

  it('remove never throws, but logs a real failure', async () => {
    const driver = withSend('public', jest.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' })));
    const log = jest.spyOn((driver as any).logger, 'error').mockImplementation(() => undefined);
    await expect(driver.remove('k')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('s3://safeer-public/k'));
  });

  it('healthCheck is a HeadBucket on its own bucket', async () => {
    const ok = jest.fn().mockResolvedValue({});
    expect(await withSend('private', ok).healthCheck()).toBe(true);
    expect(ok.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    expect(ok.mock.calls[0][0].input).toEqual({ Bucket: 'safeer-private' });
    expect(await withSend('private', jest.fn().mockRejectedValue(new Error('no'))).healthCheck()).toBe(false);
  });

  it('signs a short-lived GET that carries the type and RFC 5987 disposition (C19)', async () => {
    const driver = new S3StorageDriver(env, 'private');
    const url = new URL(
      await driver.signedUrl('private/applications/1/x.pdf', {
        contentType: 'application/pdf',
        contentDisposition: `inline; filename="x.pdf"; filename*=UTF-8''%D8%B4%D9%87%D8%A7%D8%AF%D8%A9.pdf`,
      }),
    );
    expect(url.origin + url.pathname).toBe('https://s3.example.test/safeer-private/private/applications/1/x.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(url.searchParams.get('response-content-disposition')).toContain("filename*=UTF-8''%D8%B4");
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);

    const short = new URL(await driver.signedUrl('k', { ttlSeconds: 60 }));
    expect(short.searchParams.get('X-Amz-Expires')).toBe('60');
  });
});
