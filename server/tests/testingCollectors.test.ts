import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { capDetail, collectArtifacts, CollectorParseError, MAX_RESULT_CASES, MAX_RESULT_FINDINGS, mergeResults, parseCollectorArtifact } from '../src/testing/collectors.ts';
import { PathTraversalError } from '../src/projects/fileTree.ts';
import { admitChunk, closingLog, EMPTY_LOG_BUDGET } from '../src/testing/runLog.ts';
import type { NormalizedTestResult } from '../src/domain/types.ts';

const empty = (patch: Partial<NormalizedTestResult> = {}): NormalizedTestResult => ({ outcome: 'passed', metrics: [], findings: [], cases: [], ...patch });

// ---- junit-xml ----

test('junit-xml: counts, groups, durations, failure messages, errors and skips', () => {
  const xml = `<?xml version="1.0"?>
<!-- <testcase name="commented out"/> -->
<testsuites time="3.25">
  <testsuite name="api">
    <testcase classname="api.users" name="lists &amp; filters" time="0.1"/>
    <testcase classname="api.users" name='creates'><failure message="expected 201 &lt;got 500&gt;" type="AssertionError">trace</failure></testcase>
    <testcase classname="api.users" name="deletes"><error message="boom"/></testcase>
    <testcase classname="api.users" name="later"><skipped/></testcase>
    <testcase name="&#x41;&#66;"></testcase>
  </testsuite>
</testsuites>`;
  const result = parseCollectorArtifact('junit-xml', xml);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.durationMs, 3250);
  assert.deepEqual(result.counts, { total: 5, passed: 2, failed: 1, errored: 1, skipped: 1 });
  assert.deepEqual(result.cases[0], { name: 'lists & filters', group: 'api.users', outcome: 'passed', durationMs: 100 });
  assert.equal(result.cases[1]?.message, 'expected 201 <got 500>');
  assert.equal(result.cases[2]?.outcome, 'error');
  assert.equal(result.cases[3]?.outcome, 'skipped');
  assert.equal(result.cases[4]?.name, 'AB');
});

test('junit-xml: all passing, all skipped, empty and non-junit documents', () => {
  assert.equal(parseCollectorArtifact('junit-xml', '<testsuite><testcase name="a"/></testsuite>').outcome, 'passed');
  assert.equal(parseCollectorArtifact('junit-xml', '<testsuite><testcase name="a"><skipped/></testcase></testsuite>').outcome, 'skipped');
  const none = parseCollectorArtifact('junit-xml', '<testsuite name="x" tests="0"></testsuite>');
  assert.equal(none.outcome, 'skipped');
  assert.equal(none.counts?.total, 0);
  assert.equal(parseCollectorArtifact('junit-xml', '<testsuite><testcase/></testsuite>').cases[0]?.name, '(unnamed test)');
  assert.throws(() => parseCollectorArtifact('junit-xml', '<html></html>'), CollectorParseError);
});

// ---- coverage ----

test('lcov: sums line, branch and function coverage across files', () => {
  const lcov = 'TN:\nSF:a.ts\nFNF:2\nFNH:1\nLF:10\nLH:8\nBRF:4\nBRH:1\nend_of_record\nSF:b.ts\nLF:10\nLH:10\nend_of_record\n';
  const result = parseCollectorArtifact('lcov', lcov);
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.metrics, [
    { key: 'line-coverage', label: 'Line coverage', value: 90, unit: '%' },
    { key: 'branch-coverage', label: 'Branch coverage', value: 25, unit: '%' },
    { key: 'function-coverage', label: 'Function coverage', value: 50, unit: '%' },
  ]);
  assert.deepEqual(parseCollectorArtifact('lcov', 'SF:a.ts\nend_of_record\n').metrics, []);
  assert.throws(() => parseCollectorArtifact('lcov', 'hello'), CollectorParseError);
});

test('cobertura-xml: reads line and branch rates from the root element', () => {
  const result = parseCollectorArtifact('cobertura-xml', '<?xml version="1.0"?><coverage line-rate="0.8765" branch-rate="0.5" version="1"><packages/></coverage>');
  assert.deepEqual(result.metrics.map((m) => [m.key, m.value]), [['line-coverage', 87.65], ['branch-coverage', 50]]);
  assert.deepEqual(parseCollectorArtifact('cobertura-xml', "<coverage line-rate='1'>").metrics.map((m) => m.key), ['line-coverage']);
  assert.throws(() => parseCollectorArtifact('cobertura-xml', '<report/>'), /no <coverage> element/);
  assert.throws(() => parseCollectorArtifact('cobertura-xml', '<coverage line-rate="abc">'), /no line-rate/);
});

// ---- sarif ----

test('sarif: findings with severity from level or security-severity, locations, suppressions skipped', () => {
  const sarif = {
    runs: [{
      tool: { driver: { rules: [{ id: 'sqli', properties: { 'security-severity': '9.1' } }, { id: 'weak', defaultConfiguration: { level: 'note' } }] } },
      results: [
        { ruleId: 'sqli', level: 'warning', message: { text: 'SQL injection' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db.ts' }, region: { startLine: 12 } } }] },
        { ruleId: 'weak', message: { text: 'weak hash' } },
        { ruleId: 'ignored', level: 'error', message: { text: 'suppressed' }, suppressions: [{ kind: 'inSource' }] },
        { level: 'none', locations: [{ physicalLocation: {} }] },
        { ruleId: 'plain', properties: { 'security-severity': 5 } },
        { ruleId: 'low', properties: { 'security-severity': 1 } },
        { ruleId: 'zero', properties: { 'security-severity': 0 } },
        { ruleId: 'high', properties: { 'security-severity': 7.5 } },
        { ruleId: 'default' },
      ],
    }, { results: 'not an array' }],
  };
  const result = parseCollectorArtifact('sarif', JSON.stringify(sarif));
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.findings[0], { severity: 'critical', title: 'SQL injection', ruleId: 'sqli', location: { path: 'src/db.ts', line: 12 } });
  assert.deepEqual(result.findings.map((f) => f.severity), ['critical', 'low', 'info', 'medium', 'low', 'info', 'high', 'medium']);
  assert.equal(result.findings[2]?.title, 'Unnamed finding');
  assert.equal(result.findings[2]?.location, undefined);
  assert.equal(result.findings[4]?.title, 'low');
});

test('sarif: only low-severity findings pass; malformed documents throw', () => {
  assert.equal(parseCollectorArtifact('sarif', JSON.stringify({ runs: [{ results: [{ level: 'note', message: { text: 'x' } }] }] })).outcome, 'passed');
  assert.throws(() => parseCollectorArtifact('sarif', '{'), /not valid JSON/);
  assert.throws(() => parseCollectorArtifact('sarif', '{"version":"2.1.0"}'), /"runs" array/);
});

// ---- avos-result ----

test('avos-result: the contract fixture parses into a normalized result without its envelope', async () => {
  const text = await readFile(path.join(import.meta.dirname, 'fixtures', 'testing', 'avos-result.json'), 'utf-8');
  const result = parseCollectorArtifact('avos-result', text);
  assert.equal('format' in result, false);
  assert.equal('schemaVersion' in result, false);
  assert.equal(result.outcome, JSON.parse(text).outcome);
  assert.throws(() => parseCollectorArtifact('avos-result', JSON.stringify({ format: 'agent-visual-os.test-result', schemaVersion: 1 })), /outcome/);
  assert.throws(() => parseCollectorArtifact('avos-result', JSON.stringify({ format: 'nope' })), /format must be/);
});

// ---- merge, caps, collection ----

test('mergeResults keeps the worst outcome, sums counts and fails on a failing metric', () => {
  const merged = mergeResults([
    empty({ outcome: 'passed', counts: { total: 2, passed: 2 }, durationMs: 100 }),
    empty({ outcome: 'skipped', counts: { total: 1, skipped: 1 }, durationMs: 300, metrics: [{ key: 'p95', value: 1, status: 'fail' }] }),
    empty({ outcome: 'passed' }),
  ]);
  assert.equal(merged.outcome, 'failed');
  assert.deepEqual(merged.counts, { total: 3, passed: 2, skipped: 1 });
  assert.equal(merged.durationMs, 300);
  assert.equal(mergeResults([empty({ outcome: 'error', metrics: [{ key: 'x', value: 1, status: 'fail' }] })]).outcome, 'error');
  assert.equal(mergeResults([empty({ outcome: 'skipped' })]).outcome, 'skipped');
  assert.equal(mergeResults([empty()]).counts, undefined);
});

test('capDetail keeps non-passing cases and the most severe findings first', () => {
  const cases = Array.from({ length: MAX_RESULT_CASES + 10 }, (_, i) => ({ name: `c${i}`, outcome: (i === MAX_RESULT_CASES + 5 ? 'failed' : 'passed') as 'passed' | 'failed' }));
  const findings = Array.from({ length: MAX_RESULT_FINDINGS + 1 }, (_, i) => ({ title: `f${i}`, severity: (i === MAX_RESULT_FINDINGS ? 'critical' : 'info') as 'critical' | 'info' }));
  const { result, truncated } = capDetail(empty({ cases, findings }));
  assert.equal(result.cases.length, MAX_RESULT_CASES);
  assert.equal(result.cases[0]?.name, `c${MAX_RESULT_CASES + 5}`);
  assert.equal(result.findings.length, MAX_RESULT_FINDINGS);
  assert.equal(result.findings[0]?.severity, 'critical');
  assert.match(truncated!, new RegExp(`kept ${MAX_RESULT_CASES} of ${MAX_RESULT_CASES + 10} cases.*kept ${MAX_RESULT_FINDINGS} of ${MAX_RESULT_FINDINGS + 1} findings`));
  assert.equal(capDetail(empty()).truncated, null);
});

test('collectArtifacts reports each broken collector and merges the rest', async () => {
  const files: Record<string, string | Error> = {
    'junit.xml': '<testsuite><testcase name="a"/></testsuite>',
    'bad.xml': 'not xml',
    'escape.xml': new PathTraversalError('escape.xml'),
    'denied.xml': Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
  };
  const read = async (p: string) => {
    const file = files[p];
    if (file === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (file instanceof Error) throw file;
    return file;
  };
  const collection = await collectArtifacts([
    { id: 'ok', format: 'junit-xml', path: 'junit.xml' },
    { id: 'missing', format: 'lcov', path: 'lcov.info' },
    { id: 'bad', format: 'junit-xml', path: 'bad.xml' },
    { id: 'escape', format: 'junit-xml', path: 'escape.xml' },
    { id: 'denied', format: 'junit-xml', path: 'denied.xml' },
  ], read);
  assert.equal(collection.complete, false);
  assert.equal(collection.result?.counts?.total, 1);
  assert.deepEqual(collection.diagnostics.map((d) => `${d.code}:${d.collectorId}`), [
    'artifact-missing:missing', 'artifact-malformed:bad', 'artifact-unsafe-path:escape', 'artifact-malformed:denied',
  ]);

  const none = await collectArtifacts([{ id: 'missing', format: 'lcov', path: 'lcov.info' }], read);
  assert.equal(none.result, null);

  const many = `<testsuite>${'<testcase name="x"/>'.repeat(MAX_RESULT_CASES + 1)}</testsuite>`;
  const capped = await collectArtifacts([{ id: 'ok', format: 'junit-xml', path: 'many.xml' }], async () => many);
  assert.equal(capped.complete, true);
  assert.equal(capped.diagnostics[0]?.code, 'truncated');
  assert.equal(capped.result?.counts?.total, MAX_RESULT_CASES + 1);
});

// ---- log bounds ----

test('admitChunk writes the head, then keeps only a rolling tail and counts what it drops', () => {
  let step = admitChunk(EMPTY_LOG_BUDGET, 'abcdef', 4, 3);
  assert.deepEqual(step, { write: 'abcd', budget: { written: 4, tail: 'ef', dropped: 0 } });
  assert.equal(closingLog(step.budget), 'ef', 'nothing dropped yet, so no marker');
  step = admitChunk(step.budget, 'ghi', 4, 3);
  assert.deepEqual(step, { write: '', budget: { written: 4, tail: 'ghi', dropped: 2 } });
  assert.equal(closingLog(step.budget), '\n[agent-visual-os: 2 characters of output omitted]\nghi');
  assert.deepEqual(admitChunk(EMPTY_LOG_BUDGET, 'ab', 4, 3), { write: 'ab', budget: { written: 2, tail: '', dropped: 0 } });
  assert.equal(closingLog(EMPTY_LOG_BUDGET), '');
});

test('junit-xml: captured output and quoted ">" never confuse the scanner', () => {
  const xml = `<testsuite>
  <testcase name="logs an error" classname="a"><system-out><![CDATA[<error> logged <testcase name="fake"/>]]></system-out></testcase>
  <testcase name="x > 1" classname='a > b'/>
  <testcase name="after"/>
  <testcase name="raw"><system-err>&lt;failure&gt; <failure in stderr</system-err></testcase>
  <testcase name="real"><failure message="a > b"/></testcase>
</testsuite>`;
  const result = parseCollectorArtifact('junit-xml', xml);
  assert.deepEqual(result.cases.map((c) => [c.name, c.outcome]), [
    ['logs an error', 'passed'], ['x > 1', 'passed'], ['after', 'passed'], ['raw', 'passed'], ['real', 'failed'],
  ]);
  assert.equal(result.cases[1]?.group, 'a > b');
  assert.equal(result.cases[4]?.message, 'a > b');
  assert.equal(result.counts?.total, 5);
});
