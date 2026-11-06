import type { StorageSpec, TableSpec } from './contract.ts';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertIdent(name: string, what: string): void {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new Error(`${what} "${name}" is not a valid identifier`);
}

/** Validates the storage declaration: identifiers are safe to embed in SQL, and every named column/table exists. */
export function validateStorageSpec(spec: StorageSpec): void {
  const tables = new Map<string, TableSpec>();
  for (const table of spec.tables) {
    assertIdent(table.name, 'table');
    if (tables.has(table.name)) throw new Error(`duplicate table "${table.name}"`);
    tables.set(table.name, table);
    const cols = new Set(table.columns.map((c) => c.name));
    for (const c of table.columns) assertIdent(c.name, `column of ${table.name}`);
    const known = (c: string, what: string) => { if (c !== 'id' && !cols.has(c)) throw new Error(`${what} names missing column "${c}" in ${table.name}`); };
    table.sortable.forEach((c) => known(c, 'sortable'));
    table.filterable.forEach((c) => known(c, 'filterable'));
    table.searchable?.forEach((c) => known(c, 'searchable'));
    table.indexes?.forEach((ix) => ix.forEach((c) => known(c, 'index')));
    table.uniqueKey?.forEach((c) => known(c, 'uniqueKey'));
  }
  for (const table of spec.tables) {
    if (table.onConflict !== undefined && table.onConflict !== 'fail' && table.onConflict !== 'ignore') throw new Error(`table "${table.name}" has an unsupported onConflict "${String(table.onConflict)}"`);
  }
  for (const rollup of spec.rollups) {
    assertIdent(rollup.name, 'rollup');
    const table = tables.get(rollup.table);
    if (!table) throw new Error(`rollup "${rollup.name}" names missing table "${rollup.table}"`);
    for (const c of [...rollup.groupBy, ...rollup.measures]) {
      if (!table.columns.some((col) => col.name === c)) throw new Error(`rollup "${rollup.name}" names missing column "${c}"`);
    }
  }
  const rule = spec.retention;
  if (rule) {
    const table = tables.get(rule.table);
    if (!table || !table.columns.some((c) => c.name === rule.timeColumn)) throw new Error(`retention names a missing table or column`);
    if (!table.sortable.includes(rule.timeColumn)) throw new Error(`retention column "${rule.timeColumn}" must be sortable so pruning is indexed`);
    for (const name of rule.alsoTables ?? []) {
      const other = tables.get(name);
      if (!other?.columns.some((c) => c.name === rule.timeColumn)) throw new Error(`retention table "${name}" is missing or lacks column "${rule.timeColumn}"`);
    }
    if (!(rule.months > 0)) throw new Error('retention months must be positive');
  }
}

export const rollupTable = (name: string) => `rollup_${name}`;

/** A table's secondary indexes: one per sortable column plus the declared composites. */
export function tableIndexes(t: TableSpec): Array<{ name: string; sql: string }> {
  const sorted = t.sortable.filter((c) => c !== 'id').map((c) => [c]);
  return [...sorted, ...(t.indexes ?? [])].map((cols) => {
    const name = `ix_${t.name}_${cols.join('_')}`;
    return { name, sql: `CREATE INDEX IF NOT EXISTS ${name} ON ${t.name} (${cols.join(', ')})` };
  });
}

/** Idempotent DDL for the whole spec (tables, indexes, roll-ups, meta). */
export function schemaStatements(spec: StorageSpec): string[] {
  const out = ['CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'];
  for (const t of spec.tables) {
    const cols = t.columns.map((c) => `${c.name} ${c.type.toUpperCase()} NOT NULL`);
    const unique = t.uniqueKey?.length ? [`UNIQUE (${t.uniqueKey.join(', ')})`] : [];
    out.push(`CREATE TABLE IF NOT EXISTS ${t.name} (id INTEGER PRIMARY KEY, ${[...cols, ...unique].join(', ')})`);
    out.push(...tableIndexes(t).map((i) => i.sql));
  }
  for (const r of spec.rollups) {
    const cols = [...r.groupBy.map((g) => `${g} NOT NULL`), ...r.measures.map((m) => `${m} INTEGER NOT NULL DEFAULT 0`), 'rows INTEGER NOT NULL DEFAULT 0'];
    out.push(`CREATE TABLE IF NOT EXISTS ${rollupTable(r.name)} (${cols.join(', ')}, PRIMARY KEY (${r.groupBy.join(', ')})) WITHOUT ROWID`);
  }
  return out;
}
