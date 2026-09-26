// scripts/lib/dev-assets.mjs — C45 (safeer-backend-code-review.md).
//
// migrations/dev/003_dev_sample.sql inserts media_assets / media_variants /
// application_documents rows whose files were written, once, by
// tools/seed-from-prototype.mjs on the machine that generated it. They are
// not in git (var/ is ignored), and regenerating them can't reproduce the
// same storage keys (they're random UUIDs), so on any other checkout every
// dev image and document 404ed.
//
// After migrating a development/test database with STORAGE_DRIVER=local,
// scripts/migrate.mjs calls ensureDevAssetFiles(): every stored key with no
// file under STORAGE_ROOT gets a small placeholder of the right type, and
// images get the dimensions the row records. Existing files are never
// touched, and a database without those tables (the migrate spec's scratch
// schemas) is skipped.

import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const PLACEHOLDER_BACKGROUND = { r: 0xe6, g: 0xee, b: 0xed };

function placeholderPdf(label) {
  return Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF placeholder ${label}\n`);
}

async function placeholderImage(mime, width, height) {
  const image = sharp({
    create: { width: Math.max(1, width || 64), height: Math.max(1, height || 64), channels: 3, background: PLACEHOLDER_BACKGROUND },
  });
  if (mime === 'image/png') return image.png().toBuffer();
  if (mime === 'image/webp') return image.webp().toBuffer();
  return image.jpeg().toBuffer();
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function hasTables(connection, names) {
  const [rows] = await connection.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (?)',
    [names],
  );
  return Number(rows[0].n) === names.length;
}

/** Returns the number of placeholder files written. */
export async function ensureDevAssetFiles(connection, { storageRoot, log }) {
  if (!(await hasTables(connection, ['media_assets', 'media_variants', 'application_documents']))) return 0;
  const root = path.resolve(storageRoot);

  const wanted = [];
  const [assets] = await connection.query('SELECT id, kind, mime_type, storage_key, width_px, height_px FROM media_assets');
  const byId = new Map(assets.map((a) => [String(a.id), a]));
  for (const a of assets) {
    wanted.push({ key: a.storage_key, make: () => (a.kind === 'pdf' ? placeholderPdf(a.storage_key) : placeholderImage(a.mime_type, a.width_px, a.height_px)) });
  }
  const [variants] = await connection.query('SELECT asset_id, storage_key, width_px FROM media_variants');
  for (const v of variants) {
    const asset = byId.get(String(v.asset_id));
    const ratio = asset?.width_px && asset?.height_px ? asset.height_px / asset.width_px : 1;
    wanted.push({ key: v.storage_key, make: () => placeholderImage('image/webp', v.width_px, Math.round((v.width_px || 64) * ratio)) });
  }
  const [documents] = await connection.query('SELECT storage_key, mime FROM application_documents');
  for (const d of documents) {
    wanted.push({ key: d.storage_key, make: () => (d.mime === 'application/pdf' ? placeholderPdf(d.storage_key) : placeholderImage(d.mime, 600, 400)) });
  }

  let written = 0;
  for (const { key, make } of wanted) {
    const file = path.resolve(root, key);
    if (!file.startsWith(root + path.sep)) continue; // never write outside STORAGE_ROOT
    if (await exists(file)) continue;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, await make());
    written++;
  }
  if (written) log(`Wrote ${written} placeholder file(s) under ${root} for dev fixture rows with no stored file (C45).`);
  return written;
}
