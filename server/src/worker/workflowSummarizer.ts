import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runClaudeTurn as runClaudeTurnDefault, STATUS_SCHEMA } from './claudeProcess.ts';
import { runCodexTurn as runCodexTurnDefault } from './codexProcess.ts';
import { isCodex, selectLeastUsedExecutor, type LeastUsedExecutorDeps } from '../executors/leastUsedExecutor.ts';
import { untrackedTurn, type BackgroundTurnContext, type BackgroundTurnTracker } from '../analytics/activityRecorder.ts';
import { SUMMARY_HOUSE_STYLE } from './summaryStyle.ts';

/**
 * The Complete stage's headless "write the PR body and completion report from every step's summary"
 * turn — same pattern as projects/planItemTitler.ts's task-naming turn: a scratch directory, a
 * `--json-schema`-constrained turn on whichever configured executor has the most rate limit left, no
 * Task/Worker of its own. Never throws: `summarizeWorkflowRun` resolves `null` on any failure (spawn
 * error, bad JSON), and the caller falls back to `stitchFallbackSummary` instead of failing the run —
 * see workerManager.ts's `completeWorkflowRun`.
 */

export interface WorkflowSummary {
  tldr: string;
  requirement: string;
  whatWasDeveloped: string;
  reviewHighlights: string;
  docsUpdated: string;
  retroUpdates: string;
}

const SUMMARY_FIELDS = ['tldr', 'requirement', 'whatWasDeveloped', 'reviewHighlights', 'docsUpdated', 'retroUpdates'] as const;

export const WORKFLOW_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    ...STATUS_SCHEMA.properties,
    tldr: { type: 'string', description: 'One or two plain lines: what happened and the result (what changed, final review verdict). No heading, no "TL;DR:" prefix.' },
    requirement: { type: 'string', description: 'One or two sentences: what was asked for, as the user sees it.' },
    whatWasDeveloped: { type: 'string', description: 'Markdown: what was actually built or changed, user-visible behaviour first — a short list, or a table of file | change | why, with `###` subheadings only if it is long.' },
    reviewHighlights: { type: 'string', description: 'Markdown: the most important points raised across review rounds and how each was resolved, as a list; a blockquote for anything still open the reader must not miss. "No issues raised" if none.' },
    docsUpdated: { type: 'string', description: 'Markdown list of the docs the Docs & Retro step updated, or "None" if the run had no such step.' },
    retroUpdates: { type: 'string', description: 'Markdown list of the retro/learnings files updated, or "None" if the run had no such step.' },
  },
  required: ['status', 'message', ...SUMMARY_FIELDS],
} as const;

const SUMMARIZER_DISALLOWED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'];

const SUMMARIZER_INSTRUCTIONS = `You write GitHub pull request descriptions and completion reports for a software workflow that just finished. You are given the task's title/description and every one of its workflow steps' own summaries, in run order. Write these fields from them: "tldr" (one or two lines: what happened and the result), "requirement" (what was asked for), "whatWasDeveloped" (what was actually built), "reviewHighlights" (the most important points raised in review and how they were resolved — say "No issues raised" if none), "docsUpdated" and "retroUpdates" (from the Docs & Retro step's summary, if one ran — say "None" if it didn't). Each field is placed under its own \`##\` heading, so never start a field with a heading of its own. Do not invent anything the step summaries don't support. Do not use any tools. Respond only with your final JSON per the given schema.

Write every field in this house style for readable summaries:

${SUMMARY_HOUSE_STYLE}`;

export interface StepSummaryForPr {
  stepName: string;
  summary: string;
}

export interface SummarizeWorkflowRunInput {
  taskTitle: string;
  taskDescription: string;
  stepSummaries: StepSummaryForPr[];
}

function buildSummarizerPrompt(input: SummarizeWorkflowRunInput): string {
  const steps = input.stepSummaries.map((s) => `### ${s.stepName}\n${s.summary}`).join('\n\n');
  return `# Task: ${input.taskTitle}\n\n${input.taskDescription}\n\n# Step summaries\n\n${steps || '(no steps ran)'}`;
}

export interface WorkflowSummarizerDeps extends LeastUsedExecutorDeps {
  runClaudeTurn: typeof runClaudeTurnDefault;
  runCodexTurn: typeof runCodexTurnDefault;
  /** Records the summarizer turn as the run's Complete stage background work. */
  trackTurn?: BackgroundTurnTracker;
  turnContext?: Omit<BackgroundTurnContext, 'purpose'>;
}

/** Runs the headless summarizer turn. Resolves `null` on any failure — a bad process exit, a turn that didn't finish `done`, or a reply that doesn't parse as the expected JSON — never throws. */
export async function summarizeWorkflowRun(input: SummarizeWorkflowRunInput, deps: WorkflowSummarizerDeps): Promise<WorkflowSummary | null> {
  const executor = await selectLeastUsedExecutor(deps);
  if (!executor) return null;

  const scratchDir = await mkdtemp(path.join(tmpdir(), 'agent-visual-os-workflow-summary-'));
  try {
    const run = isCodex(executor) ? deps.runCodexTurn : deps.runClaudeTurn;
    const result = await (deps.trackTurn ?? untrackedTurn)(executor, { ...deps.turnContext, purpose: 'Completion summary' }, () => run({
      cwd: scratchDir,
      prompt: buildSummarizerPrompt(input),
      bin: executor.bin,
      env: executor.env,
      permissionMode: 'default',
      appendSystemPrompt: SUMMARIZER_INSTRUCTIONS,
      jsonSchema: WORKFLOW_SUMMARY_SCHEMA,
      disallowedTools: SUMMARIZER_DISALLOWED_TOOLS,
    }));
    if (result.status !== 'done') return null;
    const extra = result.extra ?? {};
    if (!SUMMARY_FIELDS.every((field) => typeof extra[field] === 'string')) return null;
    return Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, extra[field] as string])) as unknown as WorkflowSummary;
  } catch {
    return null;
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Stitches the step summaries together directly, with no LLM call — the fallback when
 * `summarizeWorkflowRun` returns null, so a Complete stage never fails just because the summarizer
 * did. Each step gets its own `###` heading; the review/docs/retro sections point back to those
 * steps rather than repeating them.
 */
export function stitchFallbackSummary(input: SummarizeWorkflowRunInput): WorkflowSummary {
  const stepNamed = (needle: string) => input.stepSummaries.find((s) => s.stepName.toLowerCase().includes(needle));
  const pointTo = (needle: string, none: string) => {
    const step = stepNamed(needle);
    return step ? `See the **${step.stepName}** step summary above.` : none;
  };
  const perStep = input.stepSummaries.map((s) => `### ${s.stepName}\n\n${nestHeadingsUnder(s.summary.trim(), 3) || '(no summary recorded)'}`);
  return {
    tldr: 'The run finished. The report writer was unavailable, so this report shows each step\'s own summary.',
    requirement: input.taskDescription || input.taskTitle,
    whatWasDeveloped: perStep.join('\n\n') || 'No steps ran.',
    reviewHighlights: pointTo('review', 'No issues raised'),
    docsUpdated: pointTo('docs', 'None'),
    retroUpdates: pointTo('retro', 'None'),
  };
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})(?=\s)/;

/** Pushes every Markdown heading in `markdown` (outside code fences) down so its shallowest one sits one level below `parentLevel`, capped at `######` — keeps a step's own sections nested under its per-step heading. */
export function nestHeadingsUnder(markdown: string, parentLevel: number): string {
  const lines = markdown.split('\n');
  let inFence = false;
  const headingLines = new Set<number>();
  lines.forEach((line, index) => {
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence && HEADING.test(line)) headingLines.add(index);
  });
  if (headingLines.size === 0) return markdown;
  const shallowest = Math.min(...[...headingLines].map((index) => HEADING.exec(lines[index]!)![1]!.length));
  const shift = Math.max(0, parentLevel + 1 - shallowest);
  return lines
    .map((line, index) => headingLines.has(index) ? line.replace(HEADING, (hashes) => '#'.repeat(Math.min(6, hashes.length + shift))) : line)
    .join('\n');
}

/** The completion report stored on WorkflowRunRecord.completionReport — built from a WorkflowSummary plus the PR link (or the error that kept one from being raised). */
export function buildCompletionReport(summary: WorkflowSummary, prUrl: string | null, prError?: string): string {
  const lines = [
    `**TL;DR:** ${summary.tldr}`,
    '',
    '## What was developed',
    summary.whatWasDeveloped,
    '',
    '## Review highlights',
    summary.reviewHighlights,
    '',
    '## Docs updated',
    summary.docsUpdated,
    '',
    '## Retro updates',
    summary.retroUpdates,
  ];
  if (prUrl) {
    lines.push('', `## Pull request`, prUrl);
  } else if (prError) {
    lines.push('', '## Pull request', `Could not be created automatically: ${prError}`);
  }
  return lines.join('\n');
}

/** The PR body — a TL;DR line and three sections, from a WorkflowSummary — see workerManager.ts's `completeWorkflowRun`. */
export function buildPrBody(summary: WorkflowSummary): string {
  return [
    `**TL;DR:** ${summary.tldr}`,
    '',
    '## Requirement',
    summary.requirement,
    '',
    "## What's done",
    summary.whatWasDeveloped,
    '',
    '## Review highlights',
    summary.reviewHighlights,
  ].join('\n');
}
