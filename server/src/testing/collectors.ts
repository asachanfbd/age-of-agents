import { parseAvosResult } from './result.ts';
import { FINDING_SEVERITIES } from './types.ts';
import type { CollectorConfig, CollectorFormat, FindingSeverity, ResultCase, ResultCounts, ResultFinding, ResultMetric, TestOutcome } from './types.ts';
import type { NormalizedTestResult, TestRunDiagnostic } from '../domain/types.ts';
import { PathTraversalError } from '../projects/fileTree.ts';

/**
 * Collectors: turn the machine-readable report files a Test Action writes into its artifact
 * directory into one NormalizedTestResult. Deliberately dependency-free and lenient about
 * formatting (attribute order, whitespace, extra elements) but strict about shape: a file that
 * isn't recognizably its declared format is a CollectorParseError, which the runner records as an
 * `artifact-malformed` diagnostic and an `error` run. See docs/testing-contract.md's "Collectors".
 */

/**
 * Sanity caps per run, well above any normal suite, so one pathological report can't produce a
 * result file too large to serve. The non-passing cases and most severe findings are kept first.
 */
export const MAX_RESULT_CASES = 20_000;
export const MAX_RESULT_FINDINGS = 5_000;

export class CollectorParseError extends Error {
  constructor(format: CollectorFormat, message: string) {
    super(`${format}: ${message}`);
    this.name = 'CollectorParseError';
  }
}

type Parser = (text: string) => NormalizedTestResult;

const PARSERS: Record<CollectorFormat, Parser> = {
  'junit-xml': parseJunitXml,
  lcov: parseLcov,
  'cobertura-xml': parseCoberturaXml,
  sarif: parseSarif,
  'avos-result': parseAvos,
};

export function parseCollectorArtifact(format: CollectorFormat, text: string): NormalizedTestResult {
  return PARSERS[format](text);
}

export interface Collection {
  /** Merged from every Collector that parsed; null when none did. */
  result: NormalizedTestResult | null;
  /** Artifact problems (missing/unsafe/malformed) plus a `truncated` note — the former make the run an `error`. */
  diagnostics: TestRunDiagnostic[];
  /** True when every declared Collector produced a result. */
  complete: boolean;
}

/** Reads and parses every declared Collector, never throwing: each failure becomes a diagnostic. */
export async function collectArtifacts(
  collectors: CollectorConfig[],
  readArtifact: (relativePath: string) => Promise<string>,
): Promise<Collection> {
  const parsed: NormalizedTestResult[] = [];
  const diagnostics: TestRunDiagnostic[] = [];
  for (const collector of collectors) {
    try {
      parsed.push(parseCollectorArtifact(collector.format, await readArtifact(collector.path)));
    } catch (error) {
      diagnostics.push(artifactDiagnostic(collector, error as Error));
    }
  }
  const complete = diagnostics.length === 0;
  if (!parsed.length) return { result: null, diagnostics, complete };
  const { result, truncated } = capDetail(mergeResults(parsed));
  if (truncated) diagnostics.push({ code: 'truncated', message: truncated });
  return { result, diagnostics, complete };
}

function artifactDiagnostic(collector: CollectorConfig, error: Error): TestRunDiagnostic {
  const where = `collector "${collector.id}" (${collector.format}, ${collector.path})`;
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    return { code: 'artifact-missing', collectorId: collector.id, message: `${where}: the command did not write this report` };
  }
  if (error instanceof PathTraversalError) {
    return { code: 'artifact-unsafe-path', collectorId: collector.id, message: `${where}: the report resolves outside the run's artifact directory` };
  }
  return { code: 'artifact-malformed', collectorId: collector.id, message: `${where}: ${error.message}` };
}

// ---- Merging and capping ----

const OUTCOME_RANK: Record<TestOutcome, number> = { skipped: 0, passed: 1, failed: 2, error: 3 };
const COUNT_KEYS = ['total', 'passed', 'failed', 'errored', 'skipped'] as const;

/** The worst outcome wins; a metric its producer marked `fail` fails the whole result. */
export function mergeResults(results: NormalizedTestResult[]): NormalizedTestResult {
  const metrics = results.flatMap((r) => r.metrics);
  let outcome = results.map((r) => r.outcome).reduce((a, b) => (OUTCOME_RANK[b] > OUTCOME_RANK[a] ? b : a));
  if (metrics.some((m) => m.status === 'fail') && OUTCOME_RANK[outcome] < OUTCOME_RANK.failed) outcome = 'failed';

  const merged: NormalizedTestResult = {
    outcome,
    metrics,
    findings: results.flatMap((r) => r.findings),
    cases: results.flatMap((r) => r.cases),
  };
  const durations = results.flatMap((r) => (r.durationMs === undefined ? [] : [r.durationMs]));
  if (durations.length) merged.durationMs = Math.max(...durations);
  const counted = results.filter((r) => r.counts);
  if (counted.length) {
    const counts: ResultCounts = {};
    for (const key of COUNT_KEYS) {
      if (counted.some((r) => r.counts![key] !== undefined)) counts[key] = counted.reduce((sum, r) => sum + (r.counts![key] ?? 0), 0);
    }
    merged.counts = counts;
  }
  return merged;
}

const CASE_PRIORITY: Record<TestOutcome, number> = { error: 0, failed: 1, skipped: 2, passed: 3 };
const SEVERITY_PRIORITY = Object.fromEntries(FINDING_SEVERITIES.map((s, i) => [s, i])) as Record<FindingSeverity, number>;

export function capDetail(result: NormalizedTestResult): { result: NormalizedTestResult; truncated: string | null } {
  const notes: string[] = [];
  let { cases, findings } = result;
  if (cases.length > MAX_RESULT_CASES) {
    notes.push(`kept ${MAX_RESULT_CASES} of ${cases.length} cases (non-passing first)`);
    cases = [...cases].sort((a, b) => CASE_PRIORITY[a.outcome] - CASE_PRIORITY[b.outcome]).slice(0, MAX_RESULT_CASES);
  }
  if (findings.length > MAX_RESULT_FINDINGS) {
    notes.push(`kept ${MAX_RESULT_FINDINGS} of ${findings.length} findings (most severe first)`);
    findings = [...findings].sort((a, b) => SEVERITY_PRIORITY[a.severity] - SEVERITY_PRIORITY[b.severity]).slice(0, MAX_RESULT_FINDINGS);
  }
  return { result: { ...result, cases, findings }, truncated: notes.length ? `Result detail truncated: ${notes.join('; ')}` : null };
}

function emptyResult(outcome: TestOutcome): NormalizedTestResult {
  return { outcome, metrics: [], findings: [], cases: [] };
}

// ---- XML helpers (a tag/attribute scanner, not a full XML parser — enough for report formats) ----

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] === '#') return String.fromCodePoint(entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity.toLowerCase()] ?? '';
  });
}

/** A tag's attribute text, where `>` inside a quoted value doesn't end the tag. */
const ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*?)`;
const TESTCASE_PATTERN = new RegExp(`<testcase\\b${ATTRS}(?:\\/>|>([\\s\\S]*?)<\\/testcase>)`, 'g');
const PROBLEM_PATTERN = new RegExp(`<(failure|error)\\b${ATTRS}\\/?>`);
const SUITE_ROOT_PATTERN = new RegExp(`<testsuites?\\b${ATTRS}\\/?>`);

/**
 * Captured output (`<system-out>`/`<system-err>`, CDATA) is free text that can contain anything,
 * including `<error` or `<testcase`; it's removed before scanning so it's never mistaken for markup.
 */
function stripJunitFreeText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<(system-out|system-err)\b[\s\S]*?<\/\1>/g, '');
}

function xmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]!] = decodeXml(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function seconds(value: string | undefined): number | undefined {
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1000) : undefined;
}

// ---- junit-xml ----

function parseJunitXml(text: string): NormalizedTestResult {
  const body = stripJunitFreeText(text);
  if (!/<testsuites?\b/.test(body)) throw new CollectorParseError('junit-xml', 'no <testsuite> or <testsuites> element found');

  const cases: ResultCase[] = [];
  for (const match of body.matchAll(TESTCASE_PATTERN)) {
    const attributes = xmlAttributes(match[1]!);
    const inner = match[2] ?? '';
    const problem = PROBLEM_PATTERN.exec(inner);
    const outcome: TestOutcome = problem ? (problem[1] === 'error' ? 'error' : 'failed') : /<skipped\b/.test(inner) ? 'skipped' : 'passed';
    const testCase: ResultCase = { name: attributes.name || '(unnamed test)', outcome };
    if (attributes.classname) testCase.group = attributes.classname;
    const durationMs = seconds(attributes.time);
    if (durationMs !== undefined) testCase.durationMs = durationMs;
    const message = problem ? xmlAttributes(problem[2]!).message : undefined;
    if (message) testCase.message = message;
    cases.push(testCase);
  }

  const counts: Required<ResultCounts> = { total: cases.length, passed: 0, failed: 0, errored: 0, skipped: 0 };
  for (const c of cases) counts[c.outcome === 'error' ? 'errored' : c.outcome] += 1;
  // A test *error* in JUnit is a broken test, not a broken run: the suite failed.
  const outcome: TestOutcome = counts.failed + counts.errored ? 'failed' : counts.passed ? 'passed' : 'skipped';
  const result: NormalizedTestResult = { ...emptyResult(outcome), counts, cases };
  const root = SUITE_ROOT_PATTERN.exec(body);
  const durationMs = root ? seconds(xmlAttributes(root[1]!).time) : undefined;
  if (durationMs !== undefined) result.durationMs = durationMs;
  return result;
}

// ---- Coverage: lcov and cobertura-xml. Coverage alone never fails a run; thresholds belong in an avos-result. ----

function percentMetric(key: string, label: string, covered: number, total: number): ResultMetric[] {
  return total > 0 ? [{ key, label, value: Math.round((covered / total) * 10_000) / 100, unit: '%' }] : [];
}

function parseLcov(text: string): NormalizedTestResult {
  if (!/^SF:/m.test(text)) throw new CollectorParseError('lcov', 'no SF: (source file) records found');
  const sums: Record<string, number> = { LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 };
  for (const match of text.matchAll(/^(LF|LH|BRF|BRH|FNF|FNH):(\d+)\s*$/gm)) sums[match[1]!]! += Number(match[2]);
  return {
    ...emptyResult('passed'),
    metrics: [
      ...percentMetric('line-coverage', 'Line coverage', sums.LH!, sums.LF!),
      ...percentMetric('branch-coverage', 'Branch coverage', sums.BRH!, sums.BRF!),
      ...percentMetric('function-coverage', 'Function coverage', sums.FNH!, sums.FNF!),
    ],
  };
}

function parseCoberturaXml(text: string): NormalizedTestResult {
  const root = /<coverage\b([^>]*)>/.exec(text);
  if (!root) throw new CollectorParseError('cobertura-xml', 'no <coverage> element found');
  const attributes = xmlAttributes(root[1]!);
  const rate = (key: string, label: string): ResultMetric[] => {
    const value = Number(attributes[`${key}-rate`]);
    return attributes[`${key}-rate`] !== undefined && Number.isFinite(value)
      ? [{ key: `${key}-coverage`, label, value: Math.round(value * 10_000) / 100, unit: '%' }]
      : [];
  };
  const metrics = [...rate('line', 'Line coverage'), ...rate('branch', 'Branch coverage')];
  if (!metrics.length) throw new CollectorParseError('cobertura-xml', '<coverage> has no line-rate or branch-rate');
  return { ...emptyResult('passed'), metrics };
}

// ---- sarif ----

function parseJson(format: CollectorFormat, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CollectorParseError(format, `not valid JSON: ${(error as Error).message}`);
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const objects = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** SARIF `level` → severity, overridden by a numeric `security-severity` (CVSS-style, 0–10) when a rule declares one. */
function sarifSeverity(level: unknown, securitySeverity: unknown): FindingSeverity {
  const score = Number(securitySeverity);
  if (securitySeverity !== undefined && Number.isFinite(score)) {
    return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'info';
  }
  return ({ error: 'high', warning: 'medium', note: 'low', none: 'info' } as Record<string, FindingSeverity>)[String(level)] ?? 'medium';
}

/**
 * Suppressed results are skipped. The run fails when any finding is critical or high; lower
 * severities are reported without failing it.
 */
function parseSarif(text: string): NormalizedTestResult {
  const doc = parseJson('sarif', text);
  if (!isObject(doc) || !Array.isArray(doc.runs)) throw new CollectorParseError('sarif', 'expected an object with a "runs" array');
  const findings: ResultFinding[] = [];
  for (const run of objects(doc.runs)) {
    const driver = isObject(run.tool) && isObject(run.tool.driver) ? run.tool.driver : {};
    const rules = new Map(objects(driver.rules).map((rule) => [String(rule.id), rule]));
    for (const result of objects(run.results)) {
      if (objects(result.suppressions).length) continue;
      const ruleId = typeof result.ruleId === 'string' ? result.ruleId : undefined;
      const rule = ruleId ? rules.get(ruleId) : undefined;
      const ruleProps = rule && isObject(rule.properties) ? rule.properties : {};
      const resultProps = isObject(result.properties) ? result.properties : {};
      const message = isObject(result.message) && typeof result.message.text === 'string' ? result.message.text : undefined;
      const finding: ResultFinding = {
        severity: sarifSeverity(result.level ?? (isObject(rule?.defaultConfiguration) ? rule.defaultConfiguration.level : undefined), resultProps['security-severity'] ?? ruleProps['security-severity']),
        title: message ?? ruleId ?? 'Unnamed finding',
      };
      if (ruleId) finding.ruleId = ruleId;
      const location = sarifLocation(result);
      if (location) finding.location = location;
      findings.push(finding);
    }
  }
  const failing = findings.some((f) => f.severity === 'critical' || f.severity === 'high');
  return { ...emptyResult(failing ? 'failed' : 'passed'), findings };
}

function sarifLocation(result: Json): ResultFinding['location'] {
  const physical = objects(result.locations)[0]?.physicalLocation;
  if (!isObject(physical)) return undefined;
  const location: NonNullable<ResultFinding['location']> = {};
  if (isObject(physical.artifactLocation) && typeof physical.artifactLocation.uri === 'string') location.path = physical.artifactLocation.uri;
  if (isObject(physical.region) && typeof physical.region.startLine === 'number') location.line = physical.region.startLine;
  return Object.keys(location).length ? location : undefined;
}

// ---- avos-result ----

function parseAvos(text: string): NormalizedTestResult {
  const parsed = parseAvosResult(parseJson('avos-result', text));
  if (!parsed.ok) throw new CollectorParseError('avos-result', parsed.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '));
  const { format: _format, schemaVersion: _version, ...result } = parsed.result;
  return result;
}
