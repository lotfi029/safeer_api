/**
 * C19: multer/busboy hand back a multipart filename decoded as latin1, so an
 * Arabic name arrives as mojibake (`Ø´Ù‡Ø§Ø¯Ø©.pdf`). Re-decode it as UTF-8
 * when the latin1 bytes form valid UTF-8; otherwise keep it as given (a
 * client that really sent latin1). Control characters are dropped.
 */
export function decodeUploadName(name: string | undefined | null): string {
  const raw = name ?? '';
  let decoded = raw;
  // eslint-disable-next-line no-control-regex -- deliberately matching the whole latin1 range
  if (/[\u0080-\u00ff]/.test(raw) && !/[^\u0000-\u00ff]/.test(raw)) {
    const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
    if (!utf8.includes('\uFFFD')) decoded = utf8;
  }
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return decoded.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255) || 'file';
}

/**
 * C19: a `Content-Disposition` value that never throws in `setHeader` and
 * keeps non-ASCII names intact: an ASCII-only `filename=` fallback for old
 * clients plus the RFC 5987/6266 `filename*=UTF-8''…` form every current
 * browser prefers.
 */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const clean = filename.replace(/[\r\n"\\]/g, '').trim() || 'file';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
