/** Deterministic generators for the Notes type's large tables, used by tests and the benchmark. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86_400_000;

export interface SyntheticOptions { rows: number; days: number; endDay: string; seed: number; pages: number; queries: number }

export const DEFAULT_SYNTHETIC: Omit<SyntheticOptions, 'rows'> = { days: 365, endDay: new Date().toISOString().slice(0, 10), seed: 1, pages: 3000, queries: 50_000 };

export function dayOffset(endDay: string, back: number): string {
  return new Date(Date.parse(`${endDay}T00:00:00Z`) - back * DAY_MS).toISOString().slice(0, 10);
}

/** Row `i` of `rows`, in ascending day order, as the `metrics` table's column values. */
export function* metricRows(opts: SyntheticOptions): Generator<Array<string | number>> {
  const rand = mulberry32(opts.seed);
  const perDay = Math.max(1, Math.ceil(opts.rows / opts.days));
  let day = '';
  let lastIndex = -1;
  for (let i = 0; i < opts.rows; i++) {
    const dayIndex = Math.min(opts.days - 1, Math.floor(i / perDay));
    if (dayIndex !== lastIndex) { day = dayOffset(opts.endDay, opts.days - 1 - dayIndex); lastIndex = dayIndex; }
    const clicks = Math.floor(rand() * 20);
    yield [day, `/page-${Math.floor(rand() * opts.pages)}`, `query ${Math.floor(rand() * opts.queries)}`, clicks, clicks + Math.floor(rand() * 200)];
  }
}

export function* noteRows(opts: Pick<SyntheticOptions, 'rows' | 'seed'>): Generator<Array<string | number>> {
  const rand = mulberry32(opts.seed);
  for (let i = 0; i < opts.rows; i++) {
    yield [`Note ${i}`, `keyword ${Math.floor(rand() * 1_000_000)} backlink ${Math.floor(rand() * 1_000_000)}`, new Date(1_700_000_000_000 + i * 1000).toISOString()];
  }
}

export function syntheticRows(table: string, opts: SyntheticOptions): Generator<Array<string | number>> {
  if (table === 'metrics') return metricRows(opts);
  if (table === 'notes') return noteRows(opts);
  throw new Error(`no synthetic data for table "${table}"`);
}

export const hasSyntheticData = (table: string) => table === 'metrics' || table === 'notes';
