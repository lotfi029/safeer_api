/**
 * A generic CSV-with-BOM helper — first used by `admin/newsletter/export.csv`,
 * written generic over `T` so a later export (e.g. phase 7's
 * `admin/applications/export.csv`) reuses it unchanged: just a different
 * `rows`/`columns` pair, no new helper.
 */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

function escapeCsvField(raw: string): string {
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function cellToString(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((c) => escapeCsvField(c.header)).join(',');
  const lines = rows.map((row) => columns.map((c) => escapeCsvField(cellToString(c.value(row)))).join(','));
  return [header, ...lines].join('\r\n');
}

const UTF8_BOM = '﻿';

/**
 * UTF-8 with a leading BOM — without it, Excel (which sniffs a BOM-less CSV
 * as the system codepage rather than UTF-8) mangles Arabic content on open.
 */
export function toCsvWithBom<T>(rows: T[], columns: CsvColumn<T>[]): string {
  return UTF8_BOM + toCsv(rows, columns);
}
