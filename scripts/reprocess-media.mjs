#!/usr/bin/env node
// scripts/reprocess-media.mjs — C7 backfill. Uploads now store image
// originals re-encoded with EXIF/GPS stripped and orientation applied
// (src/media/image-pipeline.ts normalizeOriginal); this brings every asset
// uploaded before that change into line, through whichever storage driver
// STORAGE_DRIVER selects (local disk or the S3 public bucket).
//
// For each image asset whose stored original still carries EXIF / XMP /
// IPTC metadata or a non-default orientation, it re-encodes the original
// in place, regenerates its WebP variants (auto-oriented), and updates
// width/height/size. checksum_sha256 is left as is: it identifies the
// *uploaded* bytes, which is what upload dedup compares against.
//
// Usage (after `npm run build`, with the app's .env):
//   node scripts/reprocess-media.mjs            dry run: list what would change
//   node scripts/reprocess-media.mjs --apply    rewrite the files and rows

import 'reflect-metadata';
import 'dotenv/config';
import mysql from 'mysql2/promise';
import sharp from 'sharp';
import { UTC_SESSION_SQL } from './lib/db-connection.mjs';
import { loadEnv } from '../dist/config/env.js';
import { LocalStorageDriver } from '../dist/storage/local-storage.driver.js';
import { S3StorageDriver } from '../dist/storage/s3-storage.driver.js';
import { generateWebpVariants, normalizeOriginal } from '../dist/media/image-pipeline.js';

const apply = process.argv.includes('--apply');

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function needsReprocessing(meta) {
  return Boolean(meta.exif || meta.xmp || meta.iptc || (meta.orientation && meta.orientation !== 1));
}

async function main() {
  const env = loadEnv();
  const driver = env.STORAGE_DRIVER === 's3' ? new S3StorageDriver(env, 'public') : new LocalStorageDriver(env);
  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
  });
  await conn.query(UTC_SESSION_SQL);

  let checked = 0;
  let changed = 0;
  let missing = 0;
  let failed = 0;
  try {
    const [assets] = await conn.query("SELECT id, public_id, storage_key, mime_type FROM media_assets WHERE kind = 'image' ORDER BY id");
    for (const asset of assets) {
      checked++;
      try {
        const original = await readAll(await driver.getStream(asset.storage_key));
        if (!needsReprocessing(await sharp(original).metadata())) continue;

        const normalized = await normalizeOriginal(original, asset.mime_type);
        console.log(
          `${apply ? 'reprocessing' : 'would reprocess'} asset ${asset.id} (${asset.public_id}): ` +
            `${normalized.width}x${normalized.height}, ${original.length} → ${normalized.buffer.length} bytes`,
        );
        changed++;
        if (!apply) continue;

        const { variants } = await generateWebpVariants(normalized.buffer);
        const [rows] = await conn.query('SELECT id, label, storage_key FROM media_variants WHERE asset_id = ?', [asset.id]);
        await driver.put(asset.storage_key, normalized.buffer);
        for (const row of rows) {
          const variant = variants.find((v) => v.label === row.label);
          if (!variant) continue;
          await driver.put(row.storage_key, variant.buffer);
          await conn.execute('UPDATE media_variants SET width_px = ?, size_bytes = ? WHERE id = ?', [variant.width, variant.buffer.length, row.id]);
        }
        await conn.execute('UPDATE media_assets SET width_px = ?, height_px = ?, size_bytes = ? WHERE id = ?', [
          normalized.width,
          normalized.height,
          normalized.buffer.length,
          asset.id,
        ]);
      } catch (err) {
        if (err?.name === 'StorageObjectNotFoundError') {
          // The row points at a file that isn't there (e.g. dev fixtures on a
          // fresh checkout) — nothing to reprocess, not a failure.
          missing++;
          console.warn(`asset ${asset.id}: stored file ${asset.storage_key} is missing — skipped`);
          continue;
        }
        failed++;
        console.error(`asset ${asset.id} (${asset.storage_key}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await conn.end();
  }

  console.log(
    `${checked} image asset(s) checked, ${changed} ${apply ? 'reprocessed' : 'to reprocess (dry run — pass --apply)'}, ` +
      `${missing} missing, ${failed} failed.`,
  );
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
