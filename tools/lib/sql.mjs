// SQL literal generation for the seed scripts. Uses mysql2's own escape()
// (battle-tested) rather than a hand-rolled escaper — Arabic strings pass
// through untouched; NULL/undefined become the NULL keyword; numbers stay
// numeric. Never used for user-facing runtime queries — that's parameterised
// queries only; this is offline SQL-file generation.
//
// Ported from african_api's tools/lib/sql.mjs, renamed for Safeer's tables
// and with the oEmbed/library-specific ref helpers dropped in favour of the
// natural-key refs Safeer's own seed actually needs.

import mysql from 'mysql2';

/** Normalises JS booleans to 0/1 to match the schema's own TINYINT(1) idiom. */
function normalize(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/**
 * Wraps a SQL expression (typically a subquery) so it is inserted verbatim
 * instead of being escaped as a string literal. Used to resolve foreign keys
 * against a stable natural key (slug, checksum, ...) instead of assuming
 * auto-increment values — the only safe way to reference a row inserted by
 * an earlier migration, or one inserted earlier in the same file.
 */
export function raw(sqlExpr) {
  return { __sqlRaw: true, sql: sqlExpr };
}

export function sqlValue(value) {
  if (value && typeof value === 'object' && value.__sqlRaw) return `(${value.sql})`;
  return mysql.escape(normalize(value));
}

/** `(SELECT id FROM media_assets WHERE checksum_sha256 = '<hex>')` */
export function assetRef(checksumSha256) {
  return raw(`SELECT id FROM media_assets WHERE checksum_sha256 = ${mysql.escape(checksumSha256)}`);
}

/** `(SELECT id FROM <table> WHERE <column> = '<value>')` — the generic natural-key lookup the specific helpers below wrap. */
export function refBy(table, column, value) {
  return raw(`SELECT id FROM ${table} WHERE ${column} = ${mysql.escape(value)}`);
}

/** `(SELECT id FROM <table> WHERE slug = '<slug>')` */
export function refBySlug(table, slug) {
  return refBy(table, 'slug', slug);
}

/** `(SELECT id FROM pages WHERE slug = '<slug>')` */
export function pageRef(slug) {
  return refBySlug('pages', slug);
}

/** `(SELECT id FROM doc_categories WHERE slug = '<slug>')` */
export function docCategoryRef(slug) {
  return refBySlug('doc_categories', slug);
}

/** `(SELECT id FROM news_categories WHERE slug = '<slug>')` */
export function newsCategoryRef(slug) {
  return refBySlug('news_categories', slug);
}

/** `(SELECT id FROM work_areas WHERE title_ar = '<titleAr>')` — work_areas has no slug column, so the Arabic title is its natural key. */
export function workAreaRef(titleAr) {
  return refBy('work_areas', 'title_ar', titleAr);
}

/** `(SELECT id FROM applications WHERE reference = '<ref>')` */
export function applicationRef(reference) {
  return refBy('applications', 'reference', reference);
}

/**
 * Builds a multi-row INSERT. `rows` is an array of objects; `columns` fixes
 * the column order (and lets a row omit a column to mean NULL).
 */
export function insertStatement(table, columns, rows) {
  if (rows.length === 0) return `-- (no rows for ${table})\n`;

  const columnList = columns.map((c) => (c === 'key' ? '`key`' : c)).join(', ');
  const valueLines = rows.map((row) => {
    const values = columns.map((c) => sqlValue(row[c] ?? null));
    return `  (${values.join(', ')})`;
  });

  return `INSERT INTO ${table} (${columnList}) VALUES\n${valueLines.join(',\n')};\n`;
}

export function comment(text) {
  return `-- ${text}\n`;
}
