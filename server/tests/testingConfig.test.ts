import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { loadTestingConfig, parseTestingConfig, validateTestingConfig } from '../src/testing/config.ts';
import type { ContractIssue } from '../src/testing/types.ts';

const FIXTURE_PATH = path.join(import.meta.dirname, 'fixtures', 'testing', 'config.json');
let tempRoot: string;
let fixtureText: string;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'testing-config-test-'));
  fixtureText = await readFile(FIXTURE_PATH, 'utf-8');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

let projectCounter = 0;
/** A fresh, isolated project folder, optionally with `.docs/testing/config.json` written as given. */
async function project(configText?: string): Promise<string> {
  const root = path.join(tempRoot, `project-${projectCounter++}`);
  await mkdir(path.join(root, '.docs', 'testing'), { recursive: true });
  if (configText !== undefined) await writeFile(path.join(root, '.docs', 'testing', 'config.json'), configText);
  return root;
}

/** A minimal valid config whose single suite/action can be overridden per test. */
function config(suite: Record<string, unknown> = {}, action: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    suites: [{
      id: 'unit', label: 'Unit', kind: 'unit', primaryActionId: 'run',
      actions: [{ id: 'run', label: 'Run', command: 'npm test', ...action }],
      ...suite,
    }],
  };
}

function issuesOf(raw: unknown): ContractIssue[] {
  const result = validateTestingConfig(raw);
  assert.equal(result.ok, false, 'expected the config to be rejected');
  return result.ok ? [] : result.issues;
}

function assertIssue(raw: unknown, code: ContractIssue['code'], at: string) {
  const issues = issuesOf(raw);
  assert.ok(issues.some((issue) => issue.code === code && issue.path === at), `expected ${code} at ${at}, got ${JSON.stringify(issues)}`);
}

// ---- Representative fixture ----

test('the representative fixture validates and every default is filled in', () => {
  const result = parseTestingConfig(fixtureText);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
  const suites = result.config.suites;
  assert.deepEqual(suites.map((suite) => [suite.id, suite.kind]), [
    ['unit', 'unit'], ['integration', 'integration'], ['load', 'performance'], ['security', 'security'], ['lighthouse', 'custom'],
  ]);

  const unit = suites[0]!;
  assert.equal(unit.enabled, true);
  assert.equal(unit.description, 'Fast, isolated tests for the API package.');
  assert.deepEqual(unit.metrics, []);
  assert.deepEqual(unit.actions.map((action) => [action.id, action.purpose]), [['run', 'result'], ['changed', 'result'], ['update-snapshots', 'utility']]);
  assert.deepEqual(unit.actions[0]!.collectors, [
    { id: 'cases', format: 'junit-xml', path: 'junit.xml' },
    { id: 'coverage', format: 'lcov', path: 'coverage/lcov.info' },
  ]);
  assert.deepEqual(unit.actions[2]!.collectors, []);

  const load = suites[2]!;
  assert.equal(load.actions[0]!.workingDirectory, '.');
  assert.deepEqual(load.metrics[0], { key: 'p95-latency', label: 'p95 latency', unit: 'ms', direction: 'lower-is-better' });
  assert.equal('description' in load, false);

  assert.equal(suites[3]!.actions[0]!.collectors[0]!.format, 'sarif');
  assert.equal(suites[1]!.actions[0]!.collectors[1]!.format, 'cobertura-xml');
  const custom = suites[4]!;
  assert.equal(custom.enabled, false);
  assert.equal(custom.actions[0]!.enabled, false);
  assert.deepEqual(custom.metrics[0], { key: 'performance-score', label: 'Performance score', direction: 'higher-is-better' });
});

test('defaults: purpose "result", workingDirectory ".", enabled true, metric direction "neutral"', () => {
  const result = validateTestingConfig(config({ metrics: [{ key: 'm', label: 'M' }] }));
  assert.ok(result.ok);
  const suite = result.config.suites[0]!;
  assert.deepEqual(suite.actions[0], { id: 'run', label: 'Run', purpose: 'result', command: 'npm test', workingDirectory: '.', enabled: true, collectors: [] });
  assert.deepEqual(suite.metrics, [{ key: 'm', label: 'M', direction: 'neutral' }]);
});

test('an empty suites list is a valid (if idle) config', () => {
  const result = validateTestingConfig({ schemaVersion: 1, suites: [] });
  assert.deepEqual(result, { ok: true, config: { schemaVersion: 1, suites: [] } });
});

test('working directories are normalized to POSIX form without "." segments', () => {
  for (const [raw, expected] of [['./server/', 'server'], ['server\\api', 'server/api'], ['.', '.'], ['a/./b', 'a/b']]) {
    const result = validateTestingConfig(config({}, { workingDirectory: raw }));
    assert.ok(result.ok, raw);
    assert.equal(result.config.suites[0]!.actions[0]!.workingDirectory, expected);
  }
});

test('unknown keys are ignored so a newer tool can add display hints without breaking v1', () => {
  assert.equal(validateTestingConfig({ ...config(), extra: true }).ok, true);
});

// ---- Document-level failures ----

test('malformed JSON is reported as a single malformed-json issue', () => {
  const result = parseTestingConfig('{ "schemaVersion": 1, ');
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.issues[0]!.code, 'malformed-json');
  assert.equal(!result.ok && result.issues.length, 1);
});

test('a non-object document is rejected', () => {
  for (const raw of [null, [], 'config', 1]) assertIssue(raw, 'invalid-value', '');
});

test('an unsupported or missing schemaVersion stops validation with one issue', () => {
  for (const schemaVersion of [2, '1', undefined, 0]) {
    const issues = issuesOf({ ...config(), schemaVersion, suites: 'garbage' });
    assert.deepEqual(issues.map((issue) => issue.code), ['unsupported-schema-version']);
  }
});

test('suites must be present and an array; entries must be objects', () => {
  assertIssue({ schemaVersion: 1 }, 'invalid-value', 'suites');
  assertIssue({ schemaVersion: 1, suites: {} }, 'invalid-value', 'suites');
  assertIssue({ schemaVersion: 1, suites: [42] }, 'invalid-value', 'suites[0]');
});

// ---- Ids ----

test('invalid ids are rejected everywhere they appear', () => {
  for (const bad of ['', 'Unit', '-x', 'has space', 'a/b', 'x'.repeat(65), 7]) {
    assertIssue(config({ id: bad }), 'invalid-id', 'suites[0].id');
    assertIssue(config({}, { id: bad }), 'invalid-id', 'suites[0].actions[0].id');
    assertIssue(config({}, { collectors: [{ id: bad, format: 'junit-xml', path: 'j.xml' }] }), 'invalid-id', 'suites[0].actions[0].collectors[0].id');
    assertIssue(config({ metrics: [{ key: bad, label: 'M' }] }), 'invalid-id', 'suites[0].metrics[0].key');
  }
  assertIssue(config({ primaryActionId: 'Run' }), 'invalid-id', 'suites[0].primaryActionId');
});

test('duplicate suite ids are rejected', () => {
  const base = config();
  const raw = { ...base, suites: [base.suites[0], { ...base.suites[0] }] };
  assertIssue(raw, 'duplicate-id', 'suites[1].id');
});

test('duplicate action, collector and metric ids within their parent are rejected', () => {
  const action = { id: 'run', label: 'Run', command: 'x' };
  assertIssue(config({ actions: [action, { ...action }] }), 'duplicate-id', 'suites[0].actions[1].id');
  const collector = { id: 'c', format: 'lcov', path: 'lcov.info' };
  assertIssue(config({}, { collectors: [collector, { ...collector, path: 'other.info' }] }), 'duplicate-id', 'suites[0].actions[0].collectors[1].id');
  assertIssue(config({ metrics: [{ key: 'm', label: 'A' }, { key: 'm', label: 'B' }] }), 'duplicate-id', 'suites[0].metrics[1].key');
});

test('the same action id may repeat across different suites', () => {
  const base = config();
  assert.equal(validateTestingConfig({ ...base, suites: [base.suites[0], { ...base.suites[0], id: 'e2e', kind: 'e2e' }] }).ok, true);
});

// ---- Primary action ----

test('a primaryActionId that names no action is rejected', () => {
  assertIssue(config({ primaryActionId: 'missing' }), 'missing-primary-action', 'suites[0].primaryActionId');
});

test('a missing primaryActionId is rejected', () => {
  assertIssue(config({ primaryActionId: undefined }), 'invalid-id', 'suites[0].primaryActionId');
});

test('a utility action cannot be the primary action', () => {
  assertIssue(config({}, { purpose: 'utility' }), 'missing-primary-action', 'suites[0].primaryActionId');
});

test('an enabled suite cannot have a disabled primary action, but a disabled suite can', () => {
  assertIssue(config({}, { enabled: false }), 'missing-primary-action', 'suites[0].primaryActionId');
  assert.equal(validateTestingConfig(config({ enabled: false }, { enabled: false })).ok, true);
});

test('a suite needs at least one action', () => {
  assertIssue(config({ actions: [] }), 'invalid-value', 'suites[0].actions');
  assertIssue(config({ actions: undefined }), 'invalid-value', 'suites[0].actions');
});

// ---- Field values ----

test('suite kind, action purpose and metric direction must be known values', () => {
  assertIssue(config({ kind: 'smoke' }), 'invalid-value', 'suites[0].kind');
  assertIssue(config({ kind: undefined }), 'invalid-value', 'suites[0].kind');
  assertIssue(config({}, { purpose: 'fix' }), 'invalid-value', 'suites[0].actions[0].purpose');
  assertIssue(config({ metrics: [{ key: 'm', label: 'M', direction: 'up' }] }), 'invalid-value', 'suites[0].metrics[0].direction');
});

test('labels and commands are required non-empty strings', () => {
  assertIssue(config({ label: '  ' }), 'invalid-value', 'suites[0].label');
  assertIssue(config({}, { label: undefined }), 'invalid-value', 'suites[0].actions[0].label');
  assertIssue(config({}, { command: '' }), 'invalid-value', 'suites[0].actions[0].command');
  assertIssue(config({}, { command: ['npm', 'test'] }), 'invalid-value', 'suites[0].actions[0].command');
  assertIssue(config({ description: 3 }), 'invalid-value', 'suites[0].description');
  assertIssue(config({ metrics: [{ key: 'm', label: 'M', unit: '' }] }), 'invalid-value', 'suites[0].metrics[0].unit');
});

test('enabled flags must be booleans', () => {
  assertIssue(config({ enabled: 'yes' }), 'invalid-value', 'suites[0].enabled');
  assertIssue(config({}, { enabled: 1 }), 'invalid-value', 'suites[0].actions[0].enabled');
});

test('array-typed fields must be arrays of objects', () => {
  assertIssue(config({ metrics: {} }), 'invalid-value', 'suites[0].metrics');
  assertIssue(config({ metrics: ['m'] }), 'invalid-value', 'suites[0].metrics[0]');
  assertIssue(config({ actions: [null] }), 'invalid-value', 'suites[0].actions[0]');
  assertIssue(config({}, { collectors: 'junit' }), 'invalid-value', 'suites[0].actions[0].collectors');
  assertIssue(config({}, { collectors: ['junit'] }), 'invalid-value', 'suites[0].actions[0].collectors[0]');
});

// ---- Collectors ----

test('unsupported collector formats are rejected', () => {
  for (const format of ['tap', 'JUNIT-XML', undefined]) {
    const issues = issuesOf(config({}, { collectors: [{ id: 'c', format, path: 'r.txt' }] }));
    assert.ok(issues.some((issue) => issue.path === 'suites[0].actions[0].collectors[0].format'));
  }
  assertIssue(config({}, { collectors: [{ id: 'c', format: 'tap', path: 'r.tap' }] }), 'unsupported-format', 'suites[0].actions[0].collectors[0].format');
});

test('a utility action cannot declare collectors', () => {
  const raw = config({ actions: [
    { id: 'run', label: 'Run', command: 'x' },
    { id: 'snap', label: 'Update snapshots', purpose: 'utility', command: 'x -u', collectors: [{ id: 'c', format: 'junit-xml', path: 'j.xml' }] },
  ] });
  assertIssue(raw, 'invalid-value', 'suites[0].actions[1].collectors');
});

// ---- Path traversal ----

test('absolute and escaping working directories are rejected', () => {
  for (const bad of ['/etc', '../outside', 'a/../../b', 'a/..', 'C:\\repo', 'c:/repo', '\\\\server\\share', '..\\up', 'a\0b']) {
    assertIssue(config({}, { workingDirectory: bad }), 'unsafe-path', 'suites[0].actions[0].workingDirectory');
  }
});

test('absolute, escaping or root collector paths are rejected', () => {
  for (const bad of ['/tmp/junit.xml', '../junit.xml', 'reports/../../x.xml', '.', './', 'D:\\x.xml']) {
    assertIssue(config({}, { collectors: [{ id: 'c', format: 'junit-xml', path: bad }] }), 'unsafe-path', 'suites[0].actions[0].collectors[0].path');
  }
  assertIssue(config({}, { collectors: [{ id: 'c', format: 'junit-xml' }] }), 'invalid-value', 'suites[0].actions[0].collectors[0].path');
});

test('every issue in a document is reported in one pass', () => {
  const issues = issuesOf(config({ kind: 'nope', label: '' }, { id: 'BAD', workingDirectory: '../x' }));
  assert.deepEqual(new Set(issues.map((issue) => issue.path)), new Set([
    'suites[0].actions[0].id', 'suites[0].actions[0].workingDirectory', 'suites[0].label', 'suites[0].kind', 'suites[0].primaryActionId',
  ]));
});

// ---- Loading from disk ----

test('loadTestingConfig reports "absent" when the file does not exist', async () => {
  assert.deepEqual(await loadTestingConfig(await project()), { state: 'absent', path: '.docs/testing/config.json' });
  assert.deepEqual(await loadTestingConfig(path.join(tempRoot, 'no-such-project')), { state: 'absent', path: '.docs/testing/config.json' });
});

test('loadTestingConfig reports "valid" with the normalized config', async () => {
  const state = await loadTestingConfig(await project(fixtureText));
  assert.equal(state.state, 'valid');
  assert.equal(state.state === 'valid' && state.config.suites.length, 5);
});

test('loadTestingConfig reports "invalid" with issues for malformed JSON and bad content', async () => {
  const malformed = await loadTestingConfig(await project('not json'));
  assert.equal(malformed.state, 'invalid');
  assert.equal(malformed.state === 'invalid' && malformed.issues[0]!.code, 'malformed-json');

  const unsupported = await loadTestingConfig(await project(JSON.stringify({ schemaVersion: 9, suites: [] })));
  assert.equal(unsupported.state === 'invalid' && unsupported.issues[0]!.code, 'unsupported-schema-version');
});

test('loadTestingConfig reads the file fresh on every call', async () => {
  const root = await project();
  assert.equal((await loadTestingConfig(root)).state, 'absent');
  await writeFile(path.join(root, '.docs', 'testing', 'config.json'), JSON.stringify(config()));
  assert.equal((await loadTestingConfig(root)).state, 'valid');
  await writeFile(path.join(root, '.docs', 'testing', 'config.json'), '{');
  assert.equal((await loadTestingConfig(root)).state, 'invalid');
});

test('loadTestingConfig refuses a config symlinked to a file outside the project', async () => {
  const outside = path.join(tempRoot, 'outside-config.json');
  await writeFile(outside, JSON.stringify(config()));
  const root = await project();
  await symlink(outside, path.join(root, '.docs', 'testing', 'config.json'));
  const state = await loadTestingConfig(root);
  assert.equal(state.state, 'invalid');
  assert.equal(state.state === 'invalid' && state.issues[0]!.code, 'unsafe-path');
});

test('loadTestingConfig reports an unreadable config (a directory) as invalid, not absent', async () => {
  const root = await project();
  await mkdir(path.join(root, '.docs', 'testing', 'config.json'));
  const state = await loadTestingConfig(root);
  assert.equal(state.state, 'invalid');
  assert.equal(state.state === 'invalid' && state.issues[0]!.code, 'unreadable');
});
