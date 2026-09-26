#!/usr/bin/env node
// scripts/check-schema.mjs — C44: `npm run schema:check`. Fails when the
// TypeORM entities (dist/database/entities) and the migrated database
// disagree. Migrations are hand-written SQL, so this is the gate that keeps
// an entity change and its migration in step.
//
// Why not `typeorm schema:log` (still available as `npm run schema:log`)?
// On MariaDB, the production engine, it reports ~280 lines on a database
// that matches exactly: every foreign key dropped and re-added, JSON
// columns (stored by MariaDB as LONGTEXT) dropped and re-added, identical
// indexes dropped and re-created. Nothing in that output can gate CI. This
// check compares the facts that matter, from information_schema, the same
// way on MariaDB and MySQL 8:
//   - every entity table and column exists;
//   - nullability, type family, varchar/char length and enum values match;
//   - every index/unique the entities declare exists, with the same columns
//     in the same order and the same uniqueness;
//   - no NOT NULL column without a default is unknown to the entity (an
//     insert through TypeORM would fail on it).
//
// Usage (after `npm run build` + `npm run migrate`): npm run schema:check

import { AppDataSource } from '../dist/database/data-source.js';

const TYPE_FAMILY = {
  int: 'int',
  integer: 'int',
  tinyint: 'tinyint',
  boolean: 'tinyint',
  bool: 'tinyint',
  smallint: 'smallint',
  bigint: 'bigint',
  decimal: 'decimal',
  varchar: 'varchar',
  char: 'char',
  text: 'text',
  mediumtext: 'mediumtext',
  longtext: 'longtext',
  json: 'json',
  date: 'date',
  datetime: 'datetime',
  timestamp: 'timestamp',
  enum: 'enum',
  varbinary: 'varbinary',
  blob: 'blob',
};

/** MariaDB stores JSON as LONGTEXT (with a JSON_VALID check). */
function sameFamily(entityType, dbType) {
  const want = TYPE_FAMILY[entityType];
  if (!want) return true; // a type this check doesn't know: don't guess
  if (want === dbType) return true;
  return want === 'json' && dbType === 'longtext';
}

function parseEnum(columnType) {
  const m = /^enum\((.*)\)$/i.exec(columnType);
  if (!m) return null;
  return [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
}

async function main() {
  await AppDataSource.initialize();
  const problems = [];
  try {
    const q = (sql, params) => AppDataSource.query(sql, params);
    const columns = await q(
      `SELECT TABLE_NAME, COLUMN_NAME, IS_NULLABLE, DATA_TYPE, COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH, COLUMN_DEFAULT, EXTRA
         FROM information_schema.columns WHERE table_schema = DATABASE()`,
    );
    const stats = await q(
      `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
         FROM information_schema.statistics WHERE table_schema = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    );

    const dbColumns = new Map();
    for (const c of columns) {
      if (!dbColumns.has(c.TABLE_NAME)) dbColumns.set(c.TABLE_NAME, new Map());
      dbColumns.get(c.TABLE_NAME).set(c.COLUMN_NAME, c);
    }
    const dbIndexes = new Map();
    for (const s of stats) {
      const key = `${s.TABLE_NAME}.${s.INDEX_NAME}`;
      if (!dbIndexes.has(key)) dbIndexes.set(key, { unique: Number(s.NON_UNIQUE) === 0, columns: [] });
      dbIndexes.get(key).columns.push(s.COLUMN_NAME);
    }

    for (const md of AppDataSource.entityMetadatas) {
      const table = md.tableName;
      const tableColumns = dbColumns.get(table);
      if (!tableColumns) {
        problems.push(`${table}: table missing (entity ${md.name})`);
        continue;
      }

      const mapped = new Set();
      for (const col of md.columns) {
        const name = col.databaseName;
        mapped.add(name);
        const db = tableColumns.get(name);
        if (!db) {
          problems.push(`${table}.${name}: column missing (entity ${md.name}.${col.propertyName})`);
          continue;
        }
        const dbNullable = db.IS_NULLABLE === 'YES';
        if (!col.isPrimary && col.isNullable !== dbNullable) {
          problems.push(`${table}.${name}: entity says ${col.isNullable ? 'NULL' : 'NOT NULL'}, database says ${dbNullable ? 'NULL' : 'NOT NULL'}`);
        }
        if (typeof col.type === 'string' && !sameFamily(col.type.toLowerCase(), String(db.DATA_TYPE).toLowerCase())) {
          problems.push(`${table}.${name}: entity type ${col.type}, database type ${db.DATA_TYPE}`);
        }
        if (col.length && (db.DATA_TYPE === 'varchar' || db.DATA_TYPE === 'char' || db.DATA_TYPE === 'varbinary')) {
          if (Number(col.length) !== Number(db.CHARACTER_MAXIMUM_LENGTH)) {
            problems.push(`${table}.${name}: entity length ${col.length}, database length ${db.CHARACTER_MAXIMUM_LENGTH}`);
          }
        }
        if (col.enum) {
          const dbValues = parseEnum(db.COLUMN_TYPE);
          const want = col.enum.map(String);
          if (!dbValues || dbValues.join('|') !== want.join('|')) {
            problems.push(`${table}.${name}: entity enum (${want.join(', ')}), database ${db.COLUMN_TYPE}`);
          }
        }
      }

      for (const [name, db] of tableColumns) {
        if (mapped.has(name)) continue;
        const required = db.IS_NULLABLE === 'NO' && db.COLUMN_DEFAULT === null && !/auto_increment|GENERATED/i.test(db.EXTRA);
        if (required) problems.push(`${table}.${name}: NOT NULL without a default, but no entity column maps it`);
      }

      const declared = [
        ...md.indices.map((i) => ({ name: i.name, unique: i.isUnique, columns: i.columns.map((c) => c.databaseName) })),
        ...md.uniques.map((u) => ({ name: u.name, unique: true, columns: u.columns.map((c) => c.databaseName) })),
      ];
      for (const idx of declared) {
        const db = dbIndexes.get(`${table}.${idx.name}`);
        if (!db) {
          problems.push(`${table}: index ${idx.name} (${idx.columns.join(', ')}) missing`);
          continue;
        }
        if (db.columns.join(',') !== idx.columns.join(',') || db.unique !== idx.unique) {
          problems.push(
            `${table}: index ${idx.name} is ${db.unique ? 'UNIQUE ' : ''}(${db.columns.join(', ')}) in the database, ` +
              `${idx.unique ? 'UNIQUE ' : ''}(${idx.columns.join(', ')}) in the entity`,
          );
        }
      }
    }
  } finally {
    await AppDataSource.destroy();
  }

  if (problems.length > 0) {
    console.error(`Schema drift — ${problems.length} problem(s) between the entities and the migrated database:\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error('\nFix the entity, or add a numbered migration (never edit an applied one).');
    process.exit(1);
  }
  console.log(`Schema matches the entities (${AppDataSource.entityMetadatas.length} tables checked).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
