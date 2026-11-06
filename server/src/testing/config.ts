import { readFile } from 'node:fs/promises';
import { PathTraversalError, resolveSafePath } from '../projects/fileTree.ts';
import {
  COLLECTOR_FORMATS,
  METRIC_DIRECTIONS,
  TEST_ACTION_PURPOSES,
  TEST_SUITE_KINDS,
  TESTING_CONFIG_RELATIVE_PATH,
  TESTING_CONFIG_SCHEMA_VERSION,
} from './types.ts';
import type {
  CollectorConfig,
  ContractIssue,
  MetricDisplayConfig,
  TestActionConfig,
  TestingConfig,
  TestingConfigState,
  TestSuiteConfig,
} from './types.ts';
import {
  addIssue,
  asRecord,
  checkUniqueIds,
  childPath,
  dropUndefined,
  isRecord,
  normalizeRelativePath,
  readArray,
  readBoolean,
  readEnum,
  readId,
  readString,
} from './validation.ts';
import type { Issues } from './validation.ts';

/**
 * Loads and validates a Project's `.docs/testing/config.json`. Read fresh on every call — an agent
 * or a person may edit the file on disk at any time, so the daemon never caches or owns it.
 */

export type TestingConfigValidation = { ok: true; config: TestingConfig } | { ok: false; issues: ContractIssue[] };

export async function loadTestingConfig(projectRoot: string): Promise<TestingConfigState> {
  const path = TESTING_CONFIG_RELATIVE_PATH;
  let text: string;
  try {
    text = await readFile(await resolveSafePath(projectRoot, path), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent', path };
    const code = error instanceof PathTraversalError ? 'unsafe-path' : 'unreadable';
    return { state: 'invalid', path, issues: [{ code, path: '', message: (error as Error).message }] };
  }
  const result = parseTestingConfig(text);
  return result.ok ? { state: 'valid', path, config: result.config } : { state: 'invalid', path, issues: result.issues };
}

export function parseTestingConfig(text: string): TestingConfigValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, issues: [{ code: 'malformed-json', path: '', message: `config.json is not valid JSON: ${(error as Error).message}` }] };
  }
  return validateTestingConfig(raw);
}

export function validateTestingConfig(raw: unknown): TestingConfigValidation {
  const issues: Issues = [];
  if (!isRecord(raw)) {
    addIssue(issues, 'invalid-value', '', 'the config must be a JSON object');
    return { ok: false, issues };
  }
  if (raw.schemaVersion !== TESTING_CONFIG_SCHEMA_VERSION) {
    // An unknown version may mean anything, so nothing else is checked against v1's rules.
    addIssue(issues, 'unsupported-schema-version', 'schemaVersion', `schemaVersion must be ${TESTING_CONFIG_SCHEMA_VERSION}; got ${JSON.stringify(raw.schemaVersion)}`);
    return { ok: false, issues };
  }

  const suites = readArray(issues, raw, 'suites', '', true)
    .map((entry, index) => readSuite(issues, entry, childPath('suites', index)));
  checkUniqueIds(issues, suites.map((suite) => suite?.id), (index) => childPath(childPath('suites', index), 'id'), 'suite');

  if (issues.length) return { ok: false, issues };
  return { ok: true, config: { schemaVersion: TESTING_CONFIG_SCHEMA_VERSION, suites: suites as TestSuiteConfig[] } };
}

/** Returns a (possibly partial) suite so sibling checks can still run; completeness is guaranteed only when no issue was recorded. */
function readSuite(issues: Issues, entry: unknown, at: string): Partial<TestSuiteConfig> | null {
  const obj = asRecord(issues, entry, at);
  if (!obj) return null;

  const actionsAt = childPath(at, 'actions');
  const actions = readArray(issues, obj, 'actions', at, true).map((action, index) => readAction(issues, action, childPath(actionsAt, index)));
  if (Array.isArray(obj.actions) && !actions.length) addIssue(issues, 'invalid-value', actionsAt, 'a suite needs at least one action');
  checkUniqueIds(issues, actions.map((action) => action?.id), (index) => childPath(childPath(actionsAt, index), 'id'), 'action');

  const metricsAt = childPath(at, 'metrics');
  const metrics = readArray(issues, obj, 'metrics', at).map((metric, index) => readMetric(issues, metric, childPath(metricsAt, index)));
  checkUniqueIds(issues, metrics.map((metric) => metric?.key), (index) => childPath(childPath(metricsAt, index), 'key'), 'metric');

  const suite: Partial<TestSuiteConfig> = dropUndefined({
    id: readId(issues, obj, 'id', at),
    label: readString(issues, obj, 'label', at, true),
    kind: readEnum(issues, obj, 'kind', at, TEST_SUITE_KINDS),
    description: readString(issues, obj, 'description', at),
    enabled: readBoolean(issues, obj, 'enabled', at, true),
    primaryActionId: readId(issues, obj, 'primaryActionId', at),
    actions: actions as TestActionConfig[],
    metrics: metrics as MetricDisplayConfig[],
  });
  checkPrimaryAction(issues, suite, at);
  return suite;
}

function checkPrimaryAction(issues: Issues, suite: Partial<TestSuiteConfig>, at: string): void {
  if (suite.primaryActionId === undefined) return;
  const where = childPath(at, 'primaryActionId');
  const primary = suite.actions?.find((action) => action?.id === suite.primaryActionId);
  if (!primary) {
    addIssue(issues, 'missing-primary-action', where, `primaryActionId "${suite.primaryActionId}" names no action in this suite`);
  } else if (primary.purpose === 'utility') {
    addIssue(issues, 'missing-primary-action', where, `primary action "${primary.id}" must be a result action, not a utility action`);
  } else if (suite.enabled && primary.enabled === false) {
    addIssue(issues, 'missing-primary-action', where, `primary action "${primary.id}" is disabled while its suite is enabled`);
  }
}

function readAction(issues: Issues, entry: unknown, at: string): Partial<TestActionConfig> | null {
  const obj = asRecord(issues, entry, at);
  if (!obj) return null;

  const purpose = readEnum(issues, obj, 'purpose', at, TEST_ACTION_PURPOSES, { fallback: 'result' });
  const collectorsAt = childPath(at, 'collectors');
  const collectors = readArray(issues, obj, 'collectors', at).map((collector, index) => readCollector(issues, collector, childPath(collectorsAt, index)));
  checkUniqueIds(issues, collectors.map((collector) => collector?.id), (index) => childPath(childPath(collectorsAt, index), 'id'), 'collector');
  if (purpose === 'utility' && collectors.length) {
    addIssue(issues, 'invalid-value', collectorsAt, 'a utility action keeps only a log, so it cannot declare collectors');
  }

  return {
    id: readId(issues, obj, 'id', at),
    label: readString(issues, obj, 'label', at, true),
    purpose,
    command: readString(issues, obj, 'command', at, true),
    workingDirectory: readRelativePath(issues, obj, 'workingDirectory', at, { allowRoot: true }),
    enabled: readBoolean(issues, obj, 'enabled', at, true),
    collectors: collectors as CollectorConfig[],
  };
}

function readCollector(issues: Issues, entry: unknown, at: string): Partial<CollectorConfig> | null {
  const obj = asRecord(issues, entry, at);
  if (!obj) return null;
  return {
    id: readId(issues, obj, 'id', at),
    format: readEnum(issues, obj, 'format', at, COLLECTOR_FORMATS, { code: 'unsupported-format' }),
    path: readRelativePath(issues, obj, 'path', at, { allowRoot: false }),
  };
}

function readMetric(issues: Issues, entry: unknown, at: string): Partial<MetricDisplayConfig> | null {
  const obj = asRecord(issues, entry, at);
  if (!obj) return null;
  return dropUndefined({
    key: readId(issues, obj, 'key', at),
    label: readString(issues, obj, 'label', at, true),
    unit: readString(issues, obj, 'unit', at),
    direction: readEnum(issues, obj, 'direction', at, METRIC_DIRECTIONS, { fallback: 'neutral' }),
  });
}

/**
 * A working directory (relative to the Project root, `.` allowed and the default) or a collector
 * path (relative to the run's artifact directory, must name something below it).
 */
function readRelativePath(issues: Issues, obj: Record<string, unknown>, key: string, at: string, opts: { allowRoot: boolean }): string | undefined {
  if (opts.allowRoot && obj[key] === undefined) return '.';
  const raw = readString(issues, obj, key, at, true);
  if (raw === undefined) return undefined;
  const normalized = normalizeRelativePath(raw);
  if (normalized === null || (!opts.allowRoot && normalized === '.')) {
    addIssue(issues, 'unsafe-path', childPath(at, key), `${key} "${raw}" must be a relative path that stays inside its base directory`);
    return undefined;
  }
  return normalized;
}
