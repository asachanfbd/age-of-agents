import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  summarizeWorkflowRun,
  stitchFallbackSummary,
  buildCompletionReport,
  buildPrBody,
  nestHeadingsUnder,
  WORKFLOW_SUMMARY_SCHEMA,
  type SummarizeWorkflowRunInput,
  type WorkflowSummary,
} from '../src/worker/workflowSummarizer.ts';
import type { ClaudeTurnResult, RunClaudeTurnOptions } from '../src/worker/claudeProcess.ts';
import type { ExecutorProfile } from '../src/domain/types.ts';
import type { ExecutorLimits } from '../src/executors/executorLimits.ts';
import { SUMMARY_HOUSE_STYLE } from '../src/worker/summaryStyle.ts';

const EXECUTOR: ExecutorProfile = { id: 'test-claude', label: 'Test Claude', kind: 'claude-cli', bin: 'claude', env: {} };

const INPUT: SummarizeWorkflowRunInput = {
  taskTitle: 'Add CSV export',
  taskDescription: 'Let users export their data as CSV.',
  stepSummaries: [
    { stepName: 'Development', summary: 'Implemented the export button and CSV builder.' },
    { stepName: 'Code Review', summary: 'Found a missing null-check; fixed in round 2.' },
    { stepName: 'Docs & Retro', summary: 'Updated README; retro noted the null-check gap in retrospective.md.' },
  ],
};

const SUMMARY: WorkflowSummary = {
  tldr: 'Users can now export their data as CSV; review passed after one fix.',
  requirement: 'Export data as CSV.',
  whatWasDeveloped: 'An export button and CSV builder.',
  reviewHighlights: 'One null-check issue, fixed.',
  docsUpdated: 'README.md',
  retroUpdates: 'retrospective.md',
};

function fakeDeps(result: ClaudeTurnResult | Error, limits: ExecutorLimits | null = null) {
  const calls: RunClaudeTurnOptions[] = [];
  return {
    deps: {
      runClaudeTurn: async (options: RunClaudeTurnOptions) => {
        calls.push(options);
        if (result instanceof Error) throw result;
        return result;
      },
      runCodexTurn: async () => { throw new Error('not used in these tests'); },
      listExecutors: async () => [EXECUTOR],
      getExecutorLimits: async () => limits,
    },
    calls,
  };
}

test('summarizeWorkflowRun returns the parsed summary on a successful turn', async () => {
  const { deps, calls } = fakeDeps({
    sessionId: 's1',
    status: 'done',
    message: 'ok',
    extra: { ...SUMMARY },
    raw: { type: 'result' },
  });
  const summary = await summarizeWorkflowRun(INPUT, deps);
  assert.deepEqual(summary, SUMMARY);
  assert.match(calls[0]?.prompt ?? '', /Add CSV export/);
  assert.match(calls[0]?.prompt ?? '', /Development/);
  assert.match(calls[0]?.prompt ?? '', /Code Review/);
});

test('summarizeWorkflowRun returns null when no executor is available', async () => {
  const { deps } = fakeDeps({ sessionId: '', status: 'done', message: '', extra: {}, raw: { type: 'result' } });
  const summary = await summarizeWorkflowRun(INPUT, { ...deps, listExecutors: async () => [] });
  assert.equal(summary, null);
});

test('summarizeWorkflowRun returns null when the turn does not finish "done"', async () => {
  const { deps } = fakeDeps({ sessionId: 's1', status: 'blocked', message: 'need input', raw: { type: 'result' } });
  assert.equal(await summarizeWorkflowRun(INPUT, deps), null);
});

test('summarizeWorkflowRun returns null when the reply is missing a required field (bad JSON-schema conformance)', async () => {
  const { deps } = fakeDeps({
    sessionId: 's1',
    status: 'done',
    message: 'ok',
    extra: { requirement: 'x', whatWasDeveloped: 'y' }, // missing tldr/reviewHighlights/docsUpdated/retroUpdates
    raw: { type: 'result' },
  });
  assert.equal(await summarizeWorkflowRun(INPUT, deps), null);
});

test('summarizeWorkflowRun returns null instead of throwing when the turn itself throws (process error)', async () => {
  const { deps } = fakeDeps(new Error('spawn failed'));
  assert.equal(await summarizeWorkflowRun(INPUT, deps), null);
});

test('stitchFallbackSummary puts each step summary under its own heading with no LLM call, used when summarizeWorkflowRun fails', () => {
  const fallback = stitchFallbackSummary(INPUT);
  assert.equal(fallback.whatWasDeveloped, [
    '### Development\n\nImplemented the export button and CSV builder.',
    '### Code Review\n\nFound a missing null-check; fixed in round 2.',
    '### Docs & Retro\n\nUpdated README; retro noted the null-check gap in retrospective.md.',
  ].join('\n\n'));
  assert.equal(fallback.reviewHighlights, 'See the **Code Review** step summary above.');
  assert.equal(fallback.docsUpdated, 'See the **Docs & Retro** step summary above.');
  assert.equal(fallback.retroUpdates, 'See the **Docs & Retro** step summary above.');
  assert.match(fallback.tldr, /report writer was unavailable/);
  assert.equal(fallback.requirement, INPUT.taskDescription);
});

test('stitchFallbackSummary nests a step\'s own headings under its step heading and marks an empty summary', () => {
  const fallback = stitchFallbackSummary({
    ...INPUT,
    stepSummaries: [
      { stepName: 'Code Review', summary: '**TL;DR:** Issues.\n\n### Issues\n\n| Severity | Where |\n| --- | --- |\n| major | `a.ts:3` |' },
      { stepName: 'Lint', summary: '  ' },
    ],
  });
  assert.match(fallback.whatWasDeveloped, /^### Code Review\n\n\*\*TL;DR:\*\* Issues\.\n\n#### Issues\n\n\| Severity \| Where \|/);
  assert.match(fallback.whatWasDeveloped, /### Lint\n\n\(no summary recorded\)$/);
});

test('the completion report built from the fallback is structured: TL;DR first, then one heading per step under What was developed', () => {
  const report = buildCompletionReport(stitchFallbackSummary(INPUT), null);
  assert.match(report, /^\*\*TL;DR:\*\* The run finished\./);
  assert.match(report, /## What was developed\n### Development\n\n[\s\S]*### Code Review\n\n[\s\S]*### Docs & Retro\n\n/);
  assert.match(report, /## Review highlights\nSee the \*\*Code Review\*\* step summary above\./);
});

test('nestHeadingsUnder shifts headings so the shallowest sits below the parent, keeps relative depth, caps at h6 and ignores code fences', () => {
  assert.equal(nestHeadingsUnder('## A\ntext\n### B', 3), '#### A\ntext\n##### B');
  assert.equal(nestHeadingsUnder('#### Already deep', 3), '#### Already deep', 'never promotes a heading');
  assert.equal(nestHeadingsUnder('# A\n###### B', 3), '#### A\n###### B', 'capped at six levels');
  assert.equal(nestHeadingsUnder('```sh\n# a comment\n```\n## Real', 3), '```sh\n# a comment\n```\n#### Real');
  assert.equal(nestHeadingsUnder('#hashtag and plain text', 3), '#hashtag and plain text', 'a # with no space is not a heading');
});

test('the summarizer is briefed with the house style and a TL;DR field, and never told to emit its own top-level headings', async () => {
  const { deps, calls } = fakeDeps({ sessionId: 's1', status: 'done', message: 'ok', extra: { ...SUMMARY }, raw: { type: 'result' } });
  await summarizeWorkflowRun(INPUT, deps);
  const system = calls[0]?.appendSystemPrompt ?? '';
  assert.ok(system.includes(SUMMARY_HOUSE_STYLE), 'the shared style reaches the summarizer verbatim');
  assert.match(system, /never start a field with a heading of its own/);
  assert.ok((WORKFLOW_SUMMARY_SCHEMA.required as readonly string[]).includes('tldr'));
  assert.match(WORKFLOW_SUMMARY_SCHEMA.properties.whatWasDeveloped.description, /table/);
});

test('stitchFallbackSummary falls back to placeholders when there is nothing to stitch (no steps ran)', () => {
  const fallback = stitchFallbackSummary({ ...INPUT, stepSummaries: [] });
  assert.equal(fallback.whatWasDeveloped, 'No steps ran.');
  assert.equal(fallback.reviewHighlights, 'No issues raised');
  assert.equal(fallback.docsUpdated, 'None');
  assert.equal(fallback.retroUpdates, 'None');
});

test('buildCompletionReport includes the PR link when one was created', () => {
  const report = buildCompletionReport(SUMMARY, 'https://github.com/owner/repo/pull/1');
  assert.match(report, /^\*\*TL;DR:\*\* Users can now export their data as CSV; review passed after one fix\.\n\n## What was developed/);
  assert.match(report, /An export button and CSV builder\./);
  assert.match(report, /## Pull request/);
  assert.match(report, /https:\/\/github\.com\/owner\/repo\/pull\/1/);
});

test('buildCompletionReport keeps the PR error text when creation failed, instead of losing it', () => {
  const report = buildCompletionReport(SUMMARY, null, 'gh: command not found');
  assert.match(report, /Could not be created automatically: gh: command not found/);
});

test('buildCompletionReport has no PR section for a repository-less project (no url, no error)', () => {
  const report = buildCompletionReport(SUMMARY, null);
  assert.doesNotMatch(report, /## Pull request/);
});

test('buildPrBody leads with the TL;DR, then exactly the three required sections', () => {
  const body = buildPrBody(SUMMARY);
  assert.match(body, /^\*\*TL;DR:\*\* Users can now export/);
  assert.equal(body.match(/^## /gm)?.length, 3);
  assert.match(body, /## Requirement/);
  assert.match(body, /## What's done/);
  assert.match(body, /## Review highlights/);
  assert.match(body, /Export data as CSV\./);
});
