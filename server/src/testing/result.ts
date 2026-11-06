import {
  AVOS_RESULT_FORMAT,
  AVOS_RESULT_SCHEMA_VERSION,
  FINDING_SEVERITIES,
  TEST_OUTCOMES,
  THRESHOLD_OPERATORS,
  THRESHOLD_STATUSES,
} from './types.ts';
import type { AvosResultParse, AvosTestResult, ResultCase, ResultCounts, ResultFinding, ResultMetric } from './types.ts';
import { addIssue, asRecord, childPath, dropUndefined, isRecord, readArray, readEnum, readNumber, readString } from './validation.ts';
import type { Issues } from './validation.ts';

/**
 * Validates an Agent Visual OS result document (the `avos-result` Collector format, v1) — the one
 * framework-neutral way a suite reports an outcome, counts, labelled metrics with thresholds,
 * findings and per-case detail. See docs/testing-contract.md for the schema and an example.
 */

const COUNT_KEYS = ['total', 'passed', 'failed', 'errored', 'skipped'] as const;

export function parseAvosResult(raw: unknown): AvosResultParse {
  const issues: Issues = [];
  if (!isRecord(raw)) {
    addIssue(issues, 'invalid-value', '', 'the result must be a JSON object');
    return { ok: false, issues };
  }
  if (raw.format !== AVOS_RESULT_FORMAT) {
    addIssue(issues, 'unsupported-format', 'format', `format must be "${AVOS_RESULT_FORMAT}"`);
    return { ok: false, issues };
  }
  if (raw.schemaVersion !== AVOS_RESULT_SCHEMA_VERSION) {
    addIssue(issues, 'unsupported-schema-version', 'schemaVersion', `schemaVersion must be ${AVOS_RESULT_SCHEMA_VERSION}; got ${JSON.stringify(raw.schemaVersion)}`);
    return { ok: false, issues };
  }

  const result: Partial<AvosTestResult> = {
    format: AVOS_RESULT_FORMAT,
    schemaVersion: AVOS_RESULT_SCHEMA_VERSION,
    outcome: readEnum(issues, raw, 'outcome', '', TEST_OUTCOMES),
    durationMs: readNumber(issues, raw, 'durationMs', '', { nonNegative: true }),
    counts: readCounts(issues, raw.counts),
    metrics: readList(issues, raw, 'metrics', readMetric),
    findings: readList(issues, raw, 'findings', readFinding),
    cases: readList(issues, raw, 'cases', readCase),
  };
  dropUndefined(result);
  return issues.length ? { ok: false, issues } : { ok: true, result: result as AvosTestResult };
}

function readList<T extends object>(issues: Issues, obj: Record<string, unknown>, key: string, read: (issues: Issues, obj: Record<string, unknown>, at: string) => T): T[] {
  return readArray(issues, obj, key, '').flatMap((entry, index) => {
    const at = childPath(key, index);
    const record = asRecord(issues, entry, at);
    return record ? [dropUndefined(read(issues, record, at))] : [];
  });
}

function readCounts(issues: Issues, value: unknown): ResultCounts | undefined {
  if (value === undefined) return undefined;
  const obj = asRecord(issues, value, 'counts');
  if (!obj) return undefined;
  const counts: ResultCounts = {};
  for (const key of COUNT_KEYS) {
    const count = readNumber(issues, obj, key, 'counts', { nonNegative: true });
    if (count === undefined) continue;
    if (!Number.isInteger(count)) addIssue(issues, 'invalid-value', childPath('counts', key), `${key} must be a whole number`);
    counts[key] = count;
  }
  return counts;
}

function readMetric(issues: Issues, obj: Record<string, unknown>, at: string): ResultMetric {
  return {
    key: readString(issues, obj, 'key', at, true) as string,
    label: readString(issues, obj, 'label', at),
    value: readNumber(issues, obj, 'value', at, { required: true }) as number,
    unit: readString(issues, obj, 'unit', at),
    threshold: readThreshold(issues, obj.threshold, childPath(at, 'threshold')),
    status: obj.status === undefined ? undefined : readEnum(issues, obj, 'status', at, THRESHOLD_STATUSES),
  };
}

function readThreshold(issues: Issues, value: unknown, at: string): ResultMetric['threshold'] {
  if (value === undefined) return undefined;
  const obj = asRecord(issues, value, at);
  if (!obj) return undefined;
  const operator = readEnum(issues, obj, 'operator', at, THRESHOLD_OPERATORS);
  const threshold = readNumber(issues, obj, 'value', at, { required: true });
  return operator && threshold !== undefined ? { operator, value: threshold } : undefined;
}

function readFinding(issues: Issues, obj: Record<string, unknown>, at: string): ResultFinding {
  return {
    id: readString(issues, obj, 'id', at),
    ruleId: readString(issues, obj, 'ruleId', at),
    severity: readEnum(issues, obj, 'severity', at, FINDING_SEVERITIES) as ResultFinding['severity'],
    title: readString(issues, obj, 'title', at, true) as string,
    description: readString(issues, obj, 'description', at),
    location: readLocation(issues, obj.location, childPath(at, 'location')),
  };
}

function readLocation(issues: Issues, value: unknown, at: string): ResultFinding['location'] {
  if (value === undefined) return undefined;
  const obj = asRecord(issues, value, at);
  if (!obj) return undefined;
  const line = readNumber(issues, obj, 'line', at, { nonNegative: true });
  return dropUndefined({ path: readString(issues, obj, 'path', at), line });
}

function readCase(issues: Issues, obj: Record<string, unknown>, at: string): ResultCase {
  return {
    id: readString(issues, obj, 'id', at),
    name: readString(issues, obj, 'name', at, true) as string,
    group: readString(issues, obj, 'group', at),
    outcome: readEnum(issues, obj, 'outcome', at, TEST_OUTCOMES) as ResultCase['outcome'],
    durationMs: readNumber(issues, obj, 'durationMs', at, { nonNegative: true }),
    message: readString(issues, obj, 'message', at),
  };
}
