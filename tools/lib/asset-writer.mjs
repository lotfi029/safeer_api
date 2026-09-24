// Shared asset-writing helper for the dev seed generator. Writes real bytes
// to STORAGE_ROOT and returns the media_assets / media_variants row data
// (not yet SQL-escaped) — one implementation used both for the prototype's
// real logo and for its placeholder files, so the checksum/variant/
// storage-path logic isn't duplicated.
//
// Images are run through the same WebP pipeline the real upload endpoint
// uses (dist/media/image-pipeline.js, compiled from src/media/image-pipeline.ts)
// so the dev fixtures are produced exactly the way a real upload would be.
//
// Ported from african_api's tools/lib/asset-writer.mjs, renamed for Safeer.
// The oEmbed/provider-download helper is dropped — Safeer's prototype has no
// equivalent library-item sources to fetch.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { generateWebpVariants } from '../../dist/media/image-pipeline.js';

/**
 * @param {object} opts
 * @param {string} opts.storageRoot
 * @param {Buffer} opts.buffer
 * @param {'image'|'pdf'} opts.kind
 * @param {string} opts.mimeHint - used only if magic-byte sniffing can't identify the type
 * @param {string} opts.originalName
 * @param {string|null} [opts.altAr]
 * @param {string|null} [opts.altEn]
 */
export async function storeAsset({
  storageRoot,
  buffer,
  kind,
  mimeHint,
  originalName,
  altAr = null,
  altEn = null,
}) {
  const detected = await fileTypeFromBuffer(buffer);
  const mimeType = detected?.mime ?? mimeHint;
  const ext = detected?.ext ?? (mimeHint === 'application/pdf' ? 'pdf' : 'bin');

  const checksumSha256 = createHash('sha256').update(buffer).digest('hex');
  const publicId = randomUUID();
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dir = `assets/${yyyy}/${mm}`;
  await mkdir(path.join(storageRoot, dir), { recursive: true });

  const storageKey = `${dir}/${publicId}.${ext}`;
  await writeFile(path.join(storageRoot, storageKey), buffer);

  let widthPx = null;
  let heightPx = null;
  const variants = [];

  if (kind === 'image') {
    const { width, height, variants: webpVariants } = await generateWebpVariants(buffer);
    widthPx = width || null;
    heightPx = height || null;
    for (const v of webpVariants) {
      const variantKey = `${dir}/${publicId}-${v.label}.webp`;
      await writeFile(path.join(storageRoot, variantKey), v.buffer);
      variants.push({ label: v.label, storageKey: variantKey, widthPx: v.width, sizeBytes: v.buffer.length });
    }
  }

  return {
    publicId,
    kind,
    mimeType,
    sizeBytes: buffer.length,
    originalName,
    storageKey,
    checksumSha256,
    widthPx,
    heightPx,
    altAr,
    altEn,
    variants,
  };
}

const PALETTE = [
  [30, 92, 89], // teal (brand)
  [186, 155, 90], // sand (brand)
  [90, 120, 120],
  [150, 140, 100],
  [70, 100, 100],
  [170, 150, 110],
];

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A solid-colour JPEG with the asset's own label rendered on it — standing
 * in for a prototype asset with no real file. The label overlay (not just
 * the cycled background colour) is what guarantees every placeholder is
 * byte-distinct: a small fixed palette alone collides by pigeonhole once
 * there are more assets than colours, which trips the real
 * uq_assets_checksum unique key on insert.
 */
export async function makePlaceholderImage(seedIndex, label) {
  const sharp = (await import('sharp')).default;
  const [r, g, b] = PALETTE[seedIndex % PALETTE.length];
  const width = 1600;
  const height = 1200;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="50%" y="50%" font-family="sans-serif" font-size="42" fill="white" fill-opacity="0.9"
          text-anchor="middle" dominant-baseline="middle">${escapeXml(label)}</text>
  </svg>`;

  return sharp({
    create: { width, height, channels: 3, background: { r, g, b } },
  })
    .composite([{ input: Buffer.from(svg) }])
    .jpeg({ quality: 80 })
    .toBuffer();
}

/** A genuinely valid single-page PDF (byte offsets computed, not hand-typed) as a placeholder. */
export function makePlaceholderPdf(titleText) {
  const escape = (s) => s.replace(/[()\\]/g, (c) => '\\' + c);
  const content = `BT /F1 18 Tf 72 700 Td (${escape(titleText)}) Tj ET`;
  const contentLength = Buffer.byteLength(content, 'latin1');

  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
    `5 0 obj\n<< /Length ${contentLength} >>\nstream\n${content}\nendstream\nendobj\n`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += obj;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += xref;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}
