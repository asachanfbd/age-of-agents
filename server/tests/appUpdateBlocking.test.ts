import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import type { TaskRecord, WorkflowRunRecord } from '../src/domain/types.ts';

// Cases 15-21 from task 7.001's test plan: the five independently-zero blocking counts, and `isIdle`.

let root: string;
let blocking: typeof import('../src/appUpdate/appUpdateBlocking.ts');
let collections: typeof import('../src/db/collections.ts');
// Imported inside `before` too: terminalSessionManager pulls in config.ts, which fixes DATA_DIR at import time.
let TerminalSessionManager: typeof import('../src/terminal/terminalSessionManager.ts').TerminalSessionManager;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'app-update-blocking-'));
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  blocking = await import('../src/appUpdate/appUpdateBlocking.ts');
  collections = await import('../src/db/collections.ts');
  ({ TerminalSessionManager } = await import('../src/terminal/terminalSessionManager.ts'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A registry that's never live and has a fixed `count()` — the default "nothing in the terminal registry" case. */
function fakeSessions(liveTaskIds: string[] = [], registrySize = 0): { has(taskId: string): boolean; count(): number } {
  return { has: (taskId) => liveTaskIds.includes(taskId), count: () => registrySize };
}

let seq = 0;
function fakeTask(overrides: Partial<TaskRecord> & { id?: string }): TaskRecord {
  const now = new Date().toISOString();
  seq += 1;
  return {
    id: `blk-task-${seq}`,
    projectId: `blk-project-${seq}`,
    templateId: 'builder', executorId: 'test-claude-cli', description: 'Task', autonomy: 'auto', manager: false,
    kind: 'execute', status: 'developing', runtimeStatus: 'starting', planItemId: null, sessionId: null,
    blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: null,
    ...overrides,
  };
}

function fakeRun(overrides: Partial<WorkflowRunRecord> & { id?: string }): WorkflowRunRecord {
  const now = new Date().toISOString();
  seq += 1;
  return {
    id: `blk-run-${seq}`, projectId: `blk-project-${seq}`, planItemId: 'some-item', workflowId: 'software-development',
    workflowSnapshot: { id: 'software-development', name: 'x', description: 'x', enabled: true, steps: [] },
    status: 'running', currentStepId: null, executorId: 'test-claude-cli',
    prUrl: null, completionReport: null, attentionReason: null, loopRoundAllowance: 0,
    createdAt: now, updatedAt: now, completedAt: null,
    ...overrides,
  };
}

test('ZERO counts and isIdle agree on a freshly empty state', async () => {
  const counts = await blocking.computeBlockingCounts(fakeSessions());
  assert.deepEqual(counts, blocking.ZERO_APP_UPDATE_BLOCKING);
  assert.equal(blocking.isIdle(counts), true);
});

test('15: stored Task and WorkflowRun rows never block — only a live process does (regression: a stale "running" row from a test left an update held forever)', async () => {
  const task = await collections.tasksDb.insert(fakeTask({ kind: 'execute', runtimeStatus: 'starting' }));
  const plan = await collections.tasksDb.insert(fakeTask({ kind: 'plan', status: 'developing', runtimeStatus: 'starting' }));
  const run = await collections.workflowRunsDb.insert(fakeRun({ status: 'running' }));
  const counts = await blocking.computeBlockingCounts(fakeSessions([task.id, plan.id]));
  assert.deepEqual(counts, blocking.ZERO_APP_UPDATE_BLOCKING);
  assert.equal(blocking.isIdle(counts), true);
  await collections.tasksDb.delete(task.id);
  await collections.tasksDb.delete(plan.id);
  await collections.workflowRunsDb.delete(run.id);
});

test('18: a queued/running TestRun blocks; passed/failed/error/stopped do not', async () => {
  const baseRun = {
    id: 'blk-test-run', projectId: 'blk-project', batchId: null,
    suite: { id: 'unit', label: 'Unit', kind: 'unit' as const },
    action: { id: 'unit:test', label: 'test', purpose: 'result' as const, command: 'npm test', workingDirectory: '.', collectors: [] },
    trigger: 'manual' as const, taskId: null, executionRoot: '/tmp', cwd: null, branch: null, commit: null,
    exitCode: null, queuedAt: new Date().toISOString(), startedAt: null, completedAt: null, durationMs: null,
    outputTruncated: false, summary: null, diagnostics: [], artifactDir: null,
  };
  for (const status of ['queued', 'running'] as const) {
    const run = await collections.testRunsDb.insert({ ...baseRun, id: `blk-test-run-${status}`, status });
    const counts = await blocking.computeBlockingCounts(fakeSessions());
    assert.equal(counts.testRuns, 1, `${status} must block`);
    await collections.testRunsDb.delete(run.id);
  }
  for (const status of ['passed', 'failed', 'error', 'stopped'] as const) {
    const run = await collections.testRunsDb.insert({ ...baseRun, id: `blk-test-run-${status}`, status });
    const counts = await blocking.computeBlockingCounts(fakeSessions());
    assert.equal(counts.testRuns, 0, `${status} must not block`);
    await collections.testRunsDb.delete(run.id);
  }
});

test('19: a running CommandRun blocks regardless of origin (incl. "sync"); settled ones do not', async () => {
  const base = {
    projectId: 'blk-project', commandId: 'blk-cmd', commandName: 'Build', commandText: 'npm run build',
    exitCode: null, output: '', startedAt: new Date().toISOString(), completedAt: null,
  };
  for (const origin of ['saved', 'sync', 'adhoc'] as const) {
    const run = await collections.commandRunsDb.insert({ ...base, id: `blk-cmd-run-${origin}`, origin, status: 'running' });
    const counts = await blocking.computeBlockingCounts(fakeSessions());
    assert.equal(counts.commands, 1, `a running ${origin} run must block`);
    await collections.commandRunsDb.delete(run.id);
  }
  const settled = await collections.commandRunsDb.insert({ ...base, id: 'blk-cmd-run-settled', origin: 'saved', status: 'success' });
  const counts = await blocking.computeBlockingCounts(fakeSessions());
  assert.equal(counts.commands, 0);
  await collections.commandRunsDb.delete(settled.id);
});

test('20: an open interactive terminal session (registry count()) blocks even when its Task row looks otherwise idle', async () => {
  // No running TestRun/CommandRun — only the raw registry size is nonzero,
  // simulating an ad-hoc inspect session (reportHooks: false) whose Task row never moved.
  const counts = await blocking.computeBlockingCounts(fakeSessions([], 1));
  assert.equal(counts.terminalSessions, 1);
  assert.equal(blocking.isIdle(counts), false);
});

test('20b: the REAL TerminalSessionManager.count() reports only live sessions — an ended PTY must not stay counted forever (regression: Code Review round 1, the map entry is only ever marked ended, never deleted)', async () => {
  const sessions = new TerminalSessionManager();
  assert.equal(sessions.count(), 0);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('PTY process did not exit')), 2_000);
    sessions.start({
      taskId: 'real-blocking-session', kind: 'claude-cli', bin: '/bin/echo', cwd: process.cwd(), env: {},
      prompt: 'app-update-blocking-test', systemPrompt: '', autonomy: 'approval',
      onExit: () => { clearTimeout(timeout); resolve(); },
    });
    assert.equal(sessions.count(), 1, 'a just-started session is counted immediately, not just once attached');
  });
  // The session's map entry is still there (marked ended, never deleted) — count() must not keep
  // counting it, or a real daemon's `terminalSessions` blocking count would only ever grow and a
  // 'server'-classified update would never auto-fire again after the first Task this process ever ran.
  assert.equal(sessions.count(), 0, 'an ended session must not still be counted');
  const counts = await blocking.computeBlockingCounts(sessions);
  assert.equal(counts.terminalSessions, 0);
});

test('21: idle requires every one of the three counts to read zero individually, not just their sum', async () => {
  for (const only of ['testRuns', 'commands', 'terminalSessions'] as const) {
    const counts = { ...blocking.ZERO_APP_UPDATE_BLOCKING, [only]: 1 };
    assert.equal(blocking.isIdle(counts), false, `${only} alone must block`);
  }
  assert.equal(blocking.isIdle(blocking.ZERO_APP_UPDATE_BLOCKING), true);
});
