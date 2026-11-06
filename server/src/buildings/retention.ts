import type { RetentionRule } from './contract.ts';

/** The first day (UTC, `YYYY-MM-DD`) that is kept: rows dated before it are discarded; a row dated exactly on it is kept. */
export function retentionCutoff(rule: Pick<RetentionRule, 'months'>, now: Date): string {
  // setUTCFullYear (unlike Date.UTC) keeps years 0-99 literal.
  const d = new Date(0);
  d.setUTCFullYear(now.getUTCFullYear(), now.getUTCMonth() - rule.months, now.getUTCDate());
  return d.toISOString().slice(0, 10);
}

/** The rule as the person reads it in Settings. */
export function describeRetention(rule: RetentionRule | undefined): string {
  if (!rule) return 'Nothing is discarded automatically.';
  const kept = rule.mode === 'rollup' ? ' Roll-up totals keep covering the discarded period.' : ' Roll-up totals are reduced to match.';
  return `Rows in "${rule.table}" dated more than ${rule.months} month${rule.months === 1 ? '' : 's'} ago are discarded.${kept}`;
}
