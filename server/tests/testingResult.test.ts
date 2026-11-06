import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveCollectorArtifactPath } from '../src/testing/artifacts.ts';
import { parseAvosResult } from '../src/testing/result.ts';
import { PathTraversalError } from '../src/projects/fileTree.ts';
import type { ContractIssue } from '../src/testing/types.ts';

const fixture = JSON.parse(await readFile(path.join(import.meta.dirname, 'fixtures', 'testing', 'avos-result.json'), 'utf-8'));
const minimal = { format: 'agent-visual-os.test-result', schemaVersion: 1, outcome: 'passed' };

function issuesOf(raw: unknown): ContractIssue[] {
  const parsed = parseAvosResult(raw);
  assert.equal(parsed.ok, false, 'expected the result to be rejected');
  return parsed.ok ? [] : parsed.issues;
}

function assertIssue(raw: unknown, code: ContractIssue['code'], at: string) {
  const issues = issuesOf(raw);
  assert.ok(issues.some((issue) => issue.code === code && issue.path === at), `expected ${code} at ${at}, got ${JSON.stringify(issues)}`);
}

// ---- Agent Visual OS result JSON v1 ----

test('the example result fixture parses with outcome, counts, metrics, findings and cases intact', () => {
  const parsed = parseAvosResult(fixture);
  assert.ok(parsed.ok, JSON.stringify(!parsed.ok && parsed.issues));
  assert.deepEqual(parsed.result, fixture);
});

test('a minimal result needs only format, schemaVersion and outcome', () => {
  assert.deepEqual(parseAvosResult(minimal), { ok: true, result: { ...minimal, metrics: [], findings: [], cases: [] } });
});

test('the format marker and schema version gate everything else', () => {
  assertIssue({ ...minimal, format: 'junit' }, 'unsupported-format', 'format');
  assertIssue({ ...minimal, schemaVersion: 2 }, 'unsupported-schema-version', 'schemaVersion');
  for (const raw of [null, [], 'x']) assertIssue(raw, 'invalid-value', '');
});

test('outcomes must be one of passed/failed/error/skipped', () => {
  assertIssue({ ...minimal, outcome: 'green' }, 'invalid-value', 'outcome');
  assertIssue({ ...minimal, outcome: undefined }, 'invalid-value', 'outcome');
  assertIssue({ ...minimal, cases: [{ name: 'c', outcome: 'ok' }] }, 'invalid-value', 'cases[0].outcome');
});

test('counts must be non-negative whole numbers', () => {
  assertIssue({ ...minimal, counts: { passed: -1 } }, 'invalid-value', 'counts.passed');
  assertIssue({ ...minimal, counts: { total: 1.5 } }, 'invalid-value', 'counts.total');
  assertIssue({ ...minimal, counts: [] }, 'invalid-value', 'counts');
  assertIssue({ ...minimal, durationMs: -5 }, 'invalid-value', 'durationMs');
});

test('metrics need a key and a finite value; thresholds and statuses are validated', () => {
  assertIssue({ ...minimal, metrics: [{ value: 1 }] }, 'invalid-value', 'metrics[0].key');
  assertIssue({ ...minimal, metrics: [{ key: 'k', value: 'fast' }] }, 'invalid-value', 'metrics[0].value');
  assertIssue({ ...minimal, metrics: [{ key: 'k' }] }, 'invalid-value', 'metrics[0].value');
  assertIssue({ ...minimal, metrics: [{ key: 'k', value: 1, threshold: { operator: '<', value: 2 } }] }, 'invalid-value', 'metrics[0].threshold.operator');
  assertIssue({ ...minimal, metrics: [{ key: 'k', value: 1, threshold: { operator: 'lt' } }] }, 'invalid-value', 'metrics[0].threshold.value');
  assertIssue({ ...minimal, metrics: [{ key: 'k', value: 1, threshold: 2 }] }, 'invalid-value', 'metrics[0].threshold');
  assertIssue({ ...minimal, metrics: [{ key: 'k', value: 1, status: 'ok' }] }, 'invalid-value', 'metrics[0].status');
  assertIssue({ ...minimal, metrics: 'none' }, 'invalid-value', 'metrics');
});

test('findings need a severity and a title; locations are validated', () => {
  assertIssue({ ...minimal, findings: [{ title: 't' }] }, 'invalid-value', 'findings[0].severity');
  assertIssue({ ...minimal, findings: [{ severity: 'low' }] }, 'invalid-value', 'findings[0].title');
  assertIssue({ ...minimal, findings: [{ severity: 'low', title: 't', location: { line: -1 } }] }, 'invalid-value', 'findings[0].location.line');
  assertIssue({ ...minimal, findings: [{ severity: 'low', title: 't', location: 'a.js' }] }, 'invalid-value', 'findings[0].location');
  assertIssue({ ...minimal, findings: [7] }, 'invalid-value', 'findings[0]');
});

test('cases need a name', () => {
  assertIssue({ ...minimal, cases: [{ outcome: 'passed' }] }, 'invalid-value', 'cases[0].name');
});

// ---- Collector artifact paths ----

test('resolveCollectorArtifactPath resolves a relative path inside the run artifact directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'artifacts-test-'));
  try {
    assert.equal(await resolveCollectorArtifactPath(dir, 'coverage/lcov.info'), path.join(dir, 'coverage', 'lcov.info'));
    assert.equal(await resolveCollectorArtifactPath(dir, './junit.xml'), path.join(dir, 'junit.xml'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveCollectorArtifactPath never resolves outside the run artifact directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'artifacts-test-'));
  const dir = path.join(root, 'run');
  try {
    await mkdir(dir);
    await writeFile(path.join(root, 'secret.xml'), '<x/>');
    await symlink(path.join(root, 'secret.xml'), path.join(dir, 'linked.xml'));
    for (const bad of ['../secret.xml', '/etc/passwd', path.join(root, 'secret.xml'), '.', '', 'C:\\x', 'linked.xml']) {
      await assert.rejects(resolveCollectorArtifactPath(dir, bad), PathTraversalError, bad);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
