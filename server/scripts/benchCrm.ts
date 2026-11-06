/**
 * CRM scale benchmark: seeds contacts through the real import path, then times the queries the tabs use.
 * Not part of `npm test`. Usage: node scripts/benchCrm.ts [--sizes 10000,20000] [--dir <folder>]
 * The sized-down runs are extrapolated linearly to 100,000 contacts; an unfinished run does not meet the criterion.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { calendar } from '../src/crm/calendar.ts';
import type { CrmCtx } from '../src/crm/context.ts';
import { listContacts } from '../src/crm/contacts.ts';
import { openCrmDb } from '../src/crm/db.ts';
import { commitCsv } from '../src/crm/imports.ts';
import { CSV_MAX_ROWS } from '../src/crm/limits.ts';
import { listSuggestions } from '../src/crm/merge.ts';
import { defaultSettings } from '../src/crm/settings.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1]! : fallback; };
const sizes = arg('sizes', '10000,20000').split(',').map(Number);
const dir = arg('dir', mkdtempSync(path.join(tmpdir(), 'crm-bench-')));

function ctxFor(file: string): CrmCtx {
  const settings = defaultSettings('UTC');
  return {
    db: openCrmDb(file), buildingId: 'bench', now: () => Date.parse('2026-03-16T09:00:00Z'),
    deps: {} as never, secrets: {} as never, filesDir: dir, settings: () => settings, saveSettings: () => undefined, exclusive: (w) => w(),
  };
}
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;
const time = <T>(fn: () => T): [number, T] => { const t = performance.now(); const r = fn(); return [performance.now() - t, r]; };
const sample = (n: number, fn: (i: number) => unknown) => p95(Array.from({ length: n }, (_, i) => time(() => fn(i))[0]));

async function run(size: number) {
  const ctx = ctxFor(path.join(dir, `bench-${size}.sqlite`));
  let worst = 0, last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 10);
  const started = performance.now();
  for (let done = 0; done < size; done += CSV_MAX_ROWS) {
    const n = Math.min(CSV_MAX_ROWS, size - done);
    const csv = `email,name,company\n${Array.from({ length: n }, (_, i) => `u${done + i}@example.com,Person ${(done + i) % 7000},Co ${(done + i) % 500}`).join('\n')}\n`;
    await commitCsv(ctx, { fileName: 'bench.csv', contentBase64: Buffer.from(csv).toString('base64'), mapping: { channels: [{ column: 'email', type: 'email' }], name: 'name', company: 'company' } });
  }
  const importMs = performance.now() - started;
  clearInterval(timer);
  const result = {
    size,
    importRowsPerSecond: Math.round(size / (importMs / 1000)),
    importMs: Math.round(importMs),
    eventLoopStallMs: Math.round(worst),
    listP95Ms: +sample(200, (i) => listContacts(ctx, { limit: '50', offset: String((i * 50) % size) })).toFixed(2),
    searchP95Ms: +sample(100, (i) => listContacts(ctx, { search: `u${(i * 97) % size}@example` })).toFixed(2),
    filterP95Ms: +sample(100, () => listContacts(ctx, { segment: 'prospect', stage: 'New', channel: 'email' })).toFixed(2),
    suggestionScanMs: +time(() => listSuggestions(ctx, 50, 0))[0].toFixed(1),
    calendarDayMs: +time(() => calendar(ctx, {}))[0].toFixed(1),
  };
  ctx.db.close();
  return result;
}

const results = [];
for (const size of sizes) results.push(await run(size));
console.table(results);
const last = results.at(-1)!;
const k = 100_000 / last.size;
console.log(`Extrapolated to 100,000 contacts from the ${last.size.toLocaleString('en-US')} run (linear, upper bound):`);
console.log(`  import ≈ ${Math.round(last.importMs * k / 1000)} s, suggestion scan ≈ ${Math.round(last.suggestionScanMs * k)} ms; list, search and filter p95 grow with the index depth, not the row count.`);
rmSync(dir, { recursive: true, force: true });
