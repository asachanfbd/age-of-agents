import assert from 'node:assert/strict';
import { settledExecute } from './helpers/startRun.ts';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ClaudeTurnResult, RunClaudeTurnOptions } from '../src/worker/claudeProcess.ts';
import type { WorkerEvent } from '../src/worker/workerManager.ts';
import { ZERO_TOKEN_USAGE } from '../src/domain/types.ts';
import type { TerminalSessionHost, TerminalSessionStart } from '../src/terminal/terminalSessionManager.ts';
import { installDocsRetroFixture } from './fixtures/docsRetroFixture.ts';

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let collections: typeof import('../src/db/collections.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let planModule: typeof import('../src/projects/plan.ts');
let catalogService: typeof import('../src/catalog/catalogService.ts');
let notificationService: typeof import('../src/notifications/notificationService.ts');
let workflowService: typeof import('../src/catalog/workflowService.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'worker-manager-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  // Isolated from the real repo's catalog/ (and never touches .claude/ either) — see catalogService.test.ts's fixture doc comment.
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  await installDocsRetroFixture(process.env.AGENT_VISUAL_OS_CATALOG_DIR);
  projectService = await import('../src/projects/projectService.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  collections = await import('../src/db/collections.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  planModule = await import('../src/projects/plan.ts');
  catalogService = await import('../src/catalog/catalogService.ts');
  notificationService = await import('../src/notifications/notificationService.ts');
  workflowService = await import('../src/catalog/workflowService.ts');

  // Two Catalog Skills for the folding/validation tests below — the fixture's catalog-index.json
  // seeds no skills at all (see catalogService.test.ts's "listSkills starts empty in the fixture"),
  // so these are created the same way any other test file adds a skill to its own isolated catalog/.
  await catalogService.createSkill({
    id: 'lint-rules',
    name: 'Lint Rules',
    description: 'House linting conventions.',
    body: 'Always run the linter before finishing a Task.',
  });
  await catalogService.createSkill({
    id: 'commit-style',
    name: 'Commit Style',
    description: 'House commit message conventions.',
    body: 'Write commit messages in the imperative mood.',
  });
  await catalogService.createSkill({
    id: 'retired-skill',
    name: 'Retired Skill',
    description: 'No longer usable.',
    body: 'This should never be folded into a Worker.',
    enabled: false,
  });
});

after(async () => {
  // Retries: a settle still in flight from the last test can write into the data dir mid-delete (ENOTEMPTY).
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * A workflow run's Complete stage runs its own headless summarizer turn through the very same
 * `runClaudeTurn` a step/execute Task uses (see workerManager.ts's `completeWorkflowRun` /
 * worker/workflowSummarizer.ts's `SUMMARIZER_INSTRUCTIONS`) — every test file's fixed
 * `fakeRunClaudeTurn` queue below was sized for real step turns only, long before Workflows
 * existed, so a summarizer call must never silently consume one of those queued entries (it would
 * hand the wrong canned result to whatever real turn was actually waiting on it next). Detected by
 * its distinctive system prompt, entirely independent of `queue`.
 */
const SUMMARIZER_SYSTEM_PROMPT_MARKER = 'You write GitHub pull request descriptions';
function isSummarizerCall(options: RunClaudeTurnOptions): boolean {
  return (options.appendSystemPrompt ?? '').includes(SUMMARIZER_SYSTEM_PROMPT_MARKER);
}
const FAKE_SUMMARIZER_RESULT: ClaudeTurnResult = {
  sessionId: 'fake-summarizer-session',
  status: 'done',
  message: 'ok',
  extra: { tldr: 'Done.', requirement: 'req', whatWasDeveloped: 'dev', reviewHighlights: 'No issues raised', docsUpdated: 'None', retroUpdates: 'None' },
  raw: { type: 'result' },
};

/** A scripted fake for runClaudeTurn: each call consumes the next queued result (or throws the queued error). */
function fakeRunClaudeTurn(queue: Array<ClaudeTurnResult | Error>) {
  const calls: RunClaudeTurnOptions[] = [];
  const fn = async (options: RunClaudeTurnOptions): Promise<ClaudeTurnResult> => {
    calls.push(options);
    if (isSummarizerCall(options)) return FAKE_SUMMARIZER_RESULT;
    const next = queue.shift();
    if (!next) throw new Error('fakeRunClaudeTurn: no more queued results');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

/**
 * Builds a WorkerManager that drives each plan-item's (single-step) WorkflowRun through the
 * interactive-CLI path: once a step's fake terminal session "starts," `fn` is called with its
 * `prompt` and own `taskId` — mirroring the shape the old structured-turn harness's callback had
 * (return a `'done'` result to call `complete_step` with its `message` as the summary, exactly as a
 * live session's own MCP tool call would; throw to simulate the session ending without ever
 * producing one — task 3.012's "ended without completing" incomplete-attempt path, exercised
 * directly in workflowRunEngine.test.ts; or return a promise that never resolves to leave the step
 * "still running"). Every plan item here runs a single-step Workflow, so — like the old harness's
 * own prompt-substring matching — `fn` tells items apart by which title appears in `prompt`, since
 * the step id alone (always "development") never would.
 */
function createStepTestManager(fn: (options: { prompt: string; taskId: string }) => Promise<ClaudeTurnResult>) {
  const managerBox: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const starts: TerminalSessionStart[] = [];
  const host: TerminalSessionHost = {
    start(input) {
      starts.push(input);
      void (async () => {
        let result: ClaudeTurnResult;
        try {
          result = await fn({ prompt: input.prompt, taskId: input.taskId });
        } catch {
          input.onExit(1); // mirrors a structured turn's spawn/turn failure: an incomplete attempt.
          return;
        }
        if (result.status === 'done') await managerBox.current!.completeStep(input.taskId, { summary: result.message }).catch(() => undefined);
      })();
    },
    attach: () => () => undefined,
    write() {},
    resize() {},
    stop(taskId) {
      const start = [...starts].reverse().find((s) => s.taskId === taskId);
      if (start) start.onExit(0, undefined, start.sessionId ?? undefined);
      return true;
    },
    has: () => true,
    isAttached: () => false,
    count: () => 0,
  };
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: host });
  managerBox.current = manager;
  return manager;
}

function fakeTerminalHost(attached = true, live = true) {
  const starts: TerminalSessionStart[] = [];
  const writes: string[] = [];
  const stops: string[] = [];
  const host: TerminalSessionHost = {
    start(input) { starts.push(input); },
    attach() { return () => undefined; },
    write(_taskId, data) { writes.push(data); },
    resize() {},
    stop(taskId) { stops.push(taskId); return live; },
    has() { return live; },
    isAttached() { return attached; },
    count() { return 0; },
  };
  return { host, starts, writes, stops };
}

/**
 * A manager for `resumeInterruptedTasks` tests. That call settles *every* 'developing' Task in the
 * shared test database, including ones other tests left behind, so every CLI path is faked here —
 * a regression that relaunched one would otherwise reach a real node-pty terminal or `codex` CLI.
 * The fake terminal host is what a caller inspects to prove nothing was (re)started.
 */
function resumeTestManager() {
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({
    runClaudeTurn: async () => { throw new Error('resumeTestManager: no structured turn is ever run any more'); },
    runCodexTurn: async () => { throw new Error('resumeTestManager: no real codex in tests'); },
    terminalSessions: terminal.host,
  });
  return { manager, terminal };
}

// 3s, not 1s: `node --test tests/*.test.ts` runs every file concurrently, and under that CPU
// contention a fake turn's chain of awaits (settle*, syncPlanItem, etc.) can occasionally take
// noticeably longer than it does running this file alone — a tight timeout here reads as a
// flaky test, not real breakage.
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('startTask starts an interactive-CLI session and settles the project+task once it exits, then to "done" once marked completed', async () => {
  const project = await projectService.createProject({ name: 'Done Flow', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Build the thing' });
  assert.equal(task.status, 'developing');
  assert.equal(terminal.starts[0]?.autonomy, 'auto');
  assert.match(terminal.starts[0]?.prompt ?? '', /Build the thing/);

  terminal.starts[0]?.onExit(0, undefined, 'sess-1');
  // Wait on the *project*, not just the task: settle* always writes the task record before the
  // project record, so polling only the task leaves a real (if narrow) window where the project
  // hasn't caught up yet — see the comment on the next test for the failure this caused.
  await waitUntil(async () => (await projectService.getProject(project.id)).status !== 'developing');
  const resolved = await manager.getTask(task.id);
  assert.equal(resolved.status, 'stopped', 'a plain CLI exit only pauses the Task — see runTerminalTask\'s onExit handler');
  assert.equal(resolved.sessionId, 'sess-1');
  assert.equal(resolved.completedAt, null);

  const completed = await manager.completeTerminalTask(task.id);
  assert.equal(completed.status, 'done');
  assert.ok(completed.completedAt);

  const projectAfter = await projectService.getProject(project.id);
  assert.equal(projectAfter.status, 'idle');
  assert.equal(projectAfter.activeTaskId, null);
  assert.equal(projectAfter.taskCount, 1);

  // Settling "done" raises a task.completed Notification (milestone-5-notification-system.md) — the
  // non-attention-needing info severity, unlike the warning/critical a "needs_input"/"failed" raises.
  const completedNotifications = await notificationService.listNotifications({ projectId: project.id });
  assert.equal(completedNotifications.length, 1);
  assert.equal(completedNotifications[0]?.kind, 'task.completed');
  assert.equal(completedNotifications[0]?.severity, 'info');
});

test('Claude CLI tasks launch a PTY session with the predefined prompt and settle when it exits', async () => {
  const project = await projectService.createProject({ name: 'Interactive CLI Flow', position: null });
  const structured = fakeRunClaudeTurn([]);
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: structured.fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Implement the feature', executorId: 'test-claude-cli' });
  assert.equal(task.executionMode, 'terminal');
  assert.equal(structured.calls.length, 0);
  await waitUntil(async () => terminal.starts.length === 1);
  assert.equal(terminal.starts.length, 1);
  assert.equal(terminal.starts[0]?.kind, 'claude-cli');
  assert.match(terminal.starts[0]?.sessionId ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(terminal.starts[0]?.resume, false);
  assert.match(terminal.starts[0]?.prompt ?? '', /Implement the feature/);

  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
  assert.equal((await manager.getTask(task.id)).sessionId, terminal.starts[0]?.sessionId);
  assert.equal((await projectService.getProject(project.id)).status, 'idle');
});

test('stopping a workflow step Task\'s own session directly (not via stopWorkflowRun) settles the Task itself, but leaves its run needing attention since complete_step was never called', async () => {
  const project = await projectService.createProject({ name: 'Interactive CLI Stop', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Pause me', description: '' });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await settledExecute(manager)(item.id, { executorId: 'test-claude-cli' });
  const sessionId = terminal.starts[0]?.sessionId;
  assert.ok(sessionId);

  await manager.stopTask(task.id);
  terminal.starts[0]?.onExit(0, undefined, sessionId);
  // Wait on the *PlanItem*, the last write in the settle chain (settleStopped sets the Task
  // 'stopped' first, then finalizeWorkflowStepTask marks the run needs-attention, and only then
  // syncPlanItemForRun syncs the PlanItem) — polling an earlier write would observe it before the
  // later ones in the same chain have landed.
  await waitUntil(async () => (await planItemService.getPlanItem(item.id)).status === 'blocked');

  const stopped = await manager.getTask(task.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.failureReason, null);
  // The step itself never called complete_step, so its run — not just its Task — needs attention:
  // needs-attention maps to 'blocked' on the PlanItem, and raises a critical Notification (task 3.012).
  assert.equal((await planItemService.getPlanItem(item.id)).status, 'blocked');
  const detail = await manager.getWorkflowRunDetail(task.workflowRunId!);
  assert.equal(detail.run.status, 'needs-attention');
  assert.match(detail.run.attentionReason ?? '', /ended without completing/);
  assert.equal((await notificationService.listNotifications({ projectId: project.id })).length, 1);
});

test('a completed terminal Task can continue the same persisted CLI session in a fresh PTY', async () => {
  const project = await projectService.createProject({ name: 'Interactive CLI Resume', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const first = await manager.startTask({ projectId: project.id, description: 'Implement the feature', executorId: 'test-claude-cli' });
  const sessionId = terminal.starts[0]?.sessionId;
  assert.ok(sessionId);
  terminal.starts[0]?.onExit(0, undefined, sessionId);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  // Seed all three task.* kinds for this conversation — a follow-up starting should resolve every one.
  const conversationSubject = { type: 'task' as const, projectId: project.id, conversationId: first.id, taskId: first.id };
  const seeded = await Promise.all((['task.needs_input', 'task.failed', 'task.completed'] as const).map((kind) =>
    notificationService.raiseNotification({ kind, subject: conversationSubject, title: 't', description: 'd' }),
  ));

  const followUp = await manager.followUpTask(first.id, 'Now add tests');
  assert.equal(followUp.executionMode, 'terminal');
  assert.equal(terminal.starts.length, 2);
  assert.equal(terminal.starts[1]?.resume, true);
  assert.equal(terminal.starts[1]?.sessionId, sessionId);
  assert.match(terminal.starts[1]?.prompt ?? '', /Now add tests/);

  for (const notification of seeded) {
    assert.ok((await notificationService.getNotification(notification.id)).resolvedAt, `${notification.kind} resolved by the follow-up starting`);
  }

  terminal.starts[1]?.onExit(0, undefined, sessionId);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('a settled terminal Task resumes the same session without sending another prompt', async () => {
  const project = await projectService.createProject({ name: 'Interactive CLI Reopen', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const first = await manager.startTask({ projectId: project.id, description: 'Implement the feature', executorId: 'test-claude-cli' });
  const sessionId = terminal.starts[0]?.sessionId;
  assert.ok(sessionId);
  terminal.starts[0]?.onExit(0, undefined, sessionId);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  const resumed = await manager.resumeTerminalTask(first.id);
  assert.notEqual(resumed.id, first.id);
  assert.equal(resumed.executorId, first.executorId, 'resume must stay on the executor that owns the saved session');
  assert.equal(resumed.conversationId, sessionId);
  assert.equal(terminal.starts.length, 2);
  assert.equal(terminal.starts[1]?.kind, terminal.starts[0]?.kind);
  assert.equal(terminal.starts[1]?.bin, terminal.starts[0]?.bin);
  assert.equal(terminal.starts[1]?.resume, true);
  assert.equal(terminal.starts[1]?.sessionId, sessionId);
  assert.equal(terminal.starts[1]?.prompt, '');
  assert.deepEqual((await manager.getTaskTranscript(resumed.id))?.turns, []);

  terminal.starts[1]?.onExit(0, undefined, sessionId);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('planning and coding resumes keep launch permissions, tools and saved instructions for Claude and Codex', async () => {
  const { interactiveCliArgs } = await import('../src/terminal/terminalSessionManager.ts');
  for (const executorId of ['test-claude-cli', 'test-codex-cli']) for (const kind of ['plan', 'execute'] as const) {
    const project = await projectService.createProject({ name: `Resume setup ${executorId} ${kind}`, position: null });
    const terminal = fakeTerminalHost();
    const manager = workerManagerModule.createWorkerManager({ terminalSessions: terminal.host });
    const first = await manager.startTask({ projectId: project.id, description: 'Do work', executorId, kind, autonomy: 'approval', templateId: 'builder', skillIds: ['lint-rules', 'commit-style'], preloadSkillIds: ['lint-rules', 'commit-style'] });
    const launch = terminal.starts[0]!;
    const sessionId = launch.sessionId ?? `codex-${first.id}`;
    launch.onExit(0, undefined, sessionId);
    await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
    const resumed = await manager.resumeTerminalTask(first.id);
    const next = terminal.starts[1]!;
    assert.equal(next.prompt, '');
    assert.equal(next.resume, true);
    assert.equal(next.sessionId, sessionId);
    for (const key of ['kind', 'bin', 'cwd', 'env', 'autonomy', 'systemPrompt', 'readOnly', 'disallowedTools'] as const) {
      assert.deepEqual(next[key], launch[key], `${executorId} ${kind}: ${key}`);
    }
    assert.deepEqual(next.mcpServers?.map(({ name, tools }) => ({ name, tools })), launch.mcpServers?.map(({ name, tools }) => ({ name, tools })));
    assert.match(next.systemPrompt, /Write commit messages in the imperative mood\.[\s\S]*Always run the linter before finishing a Task\./);
    assert.deepEqual(next.mcpServers?.map((server) => server.name), kind === 'plan' ? ['agent_visual_os'] : ['agent_visual_os_tests']);
    const args = interactiveCliArgs(next);
    if (executorId === 'test-claude-cli') {
      assert.ok(args.includes('--resume'));
      assert.ok(args.includes('--mcp-config'));
      assert.ok(args.includes('--append-system-prompt'));
    } else {
      assert.equal(args[0], 'resume');
      assert.ok(args.includes('tui.resume_cwd="current"'));
      assert.ok(args.some((arg) => arg.includes('developer_instructions=')));
      assert.ok(args.some((arg) => arg.includes('mcp_servers.')));
      assert.ok(args.includes(kind === 'plan' ? 'read-only' : 'workspace-write'));
    }
    next.onExit(0, undefined, sessionId);
    await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
    assert.equal(resumed.sessionSetup?.systemPrompt, launch.systemPrompt);
  }
});

test('a resume retains the originally loaded skill body after its Catalog file changes', async () => {
  const project = await projectService.createProject({ name: 'Frozen Resume Skill', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ terminalSessions: terminal.host });
  const first = await manager.startTask({ projectId: project.id, description: 'Plan', kind: 'plan', executorId: 'test-codex-cli', skillIds: ['lint-rules'], preloadSkillIds: ['lint-rules'] });
  const originalPrompt = terminal.starts[0]!.systemPrompt;
  terminal.starts[0]!.onExit(0, undefined, 'frozen-skill-session');
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
  try {
    await catalogService.updateSkill('lint-rules', { body: 'Changed after launch.' });
    const resumed = await manager.resumeTerminalTask(first.id);
    assert.equal(terminal.starts[1]!.systemPrompt, originalPrompt);
    assert.equal(terminal.starts[1]!.systemPrompt.includes('Changed after launch.'), false);
    terminal.starts[1]!.onExit(0, undefined, 'frozen-skill-session');
    await waitUntil(async () => (await manager.getTask(resumed.id)).status === 'stopped');
  } finally {
    await catalogService.updateSkill('lint-rules', { body: 'Always run the linter before finishing a Task.' });
  }
});

test('concurrent planning resumes never start two CLI processes on one conversation', async () => {
  const project = await projectService.createProject({ name: 'One Planning Conversation', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ terminalSessions: terminal.host });
  const first = await manager.startTask({ projectId: project.id, description: 'Plan', kind: 'plan', executorId: 'test-claude-cli' });
  terminal.starts[0]!.onExit(0, undefined, terminal.starts[0]!.sessionId ?? undefined);
  await waitUntil(async () => (await manager.getTask(first.id)).status === 'stopped');
  const results = await Promise.allSettled([manager.resumeTerminalTask(first.id), manager.resumeTerminalTask(first.id)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(terminal.starts.length, 2);
  terminal.starts[1]!.onExit(0, undefined, terminal.starts[1]!.sessionId ?? undefined);
});

test('a plain CLI exit pauses an interactive coding Task ("stopped"), never settles it "done" on its own', async () => {
  const project = await projectService.createProject({ name: 'Interactive CLI Plain Exit', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Implement the feature', executorId: 'test-claude-cli' });
  const sessionId = terminal.starts[0]?.sessionId;
  assert.ok(sessionId);
  terminal.starts[0]?.onExit(0, undefined, sessionId);
  await waitUntil(async () => (await manager.getTask(task.id)).status === 'stopped');

  const paused = await manager.getTask(task.id);
  assert.equal(paused.status, 'stopped');
  assert.equal(paused.completedAt, null, 'only a confirmed completion sets completedAt');
});

test('completeTerminalTask settles a paused planning session "done" immediately', async () => {
  const project = await projectService.createProject({ name: 'Complete Plan Session', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Plan it', executorId: 'test-claude-cli', kind: 'plan' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(task.id)).status === 'stopped');

  const completed = await manager.completeTerminalTask(task.id);
  assert.equal(completed.status, 'done');
  assert.equal(terminal.starts.length, 1, 'no confirmation turn is asked any more — the docs-and-retro pass is now a Workflow step');
});

test('completeTerminalTask settles a paused coding session "done" immediately too — no confirmation question', async () => {
  const project = await projectService.createProject({ name: 'Complete Coding Session', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Implement the feature', executorId: 'test-claude-cli' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(task.id)).status === 'stopped');

  const completed = await manager.completeTerminalTask(task.id);
  assert.equal(completed.status, 'done');
  assert.ok(completed.completedAt);
  assert.equal(terminal.starts.length, 1, 'no further CLI turn is started');

  const projectAfter = await projectService.getProject(project.id);
  assert.equal(projectAfter.status, 'idle');
  assert.deepEqual(projectAfter.activeTaskIds, []);
});

test('a Project drops active-task ids whose Tasks already left development, and goes idle once none remain', async () => {
  const project = await projectService.createProject({ name: 'Stale Active Task', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const first = await manager.startTask({ projectId: project.id, description: 'First' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(first.id)).status === 'stopped');
  const second = await manager.startTask({ projectId: project.id, description: 'Second' });
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'developing');
  // Simulate a stale membership record: the settled Task (and a deleted one) still listed as active.
  await projectService.patchProjectWith(project.id, () => ({ activeTaskIds: [first.id, 'missing-task', second.id] }));

  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(second.id)).status === 'stopped');
  await waitUntil(async () => (await projectService.getProject(project.id)).status !== 'developing');

  const projectAfter = await projectService.getProject(project.id);
  assert.equal(projectAfter.status, 'idle');
  assert.deepEqual(projectAfter.activeTaskIds, []);
  assert.equal(projectAfter.activeTaskId, null);
});

test('completeTerminalTask rejects a Task that is not a paused interactive CLI session', async () => {
  const project = await projectService.createProject({ name: 'Complete Guard', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const doneTask = await manager.startTask({ projectId: project.id, description: 'Already done' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(doneTask.id)).status === 'stopped');
  const completed = await manager.completeTerminalTask(doneTask.id);
  assert.equal(completed.status, 'done');
  await assert.rejects(() => manager.completeTerminalTask(doneTask.id), workerManagerModule.TaskNotPausedError, 'a Task already marked done has nothing left to complete');

  const runningTask = await manager.startTask({ projectId: project.id, description: 'Still going', executorId: 'test-claude-cli' });
  await assert.rejects(() => manager.completeTerminalTask(runningTask.id), workerManagerModule.TaskNotPausedError);
  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(runningTask.id)).status === 'stopped');
});

test('completeTerminalTask rejects a legacy structured (non-terminal) Task even while "stopped"', async () => {
  const project = await projectService.createProject({ name: 'Legacy Structured Guard', position: null });
  const now = new Date().toISOString();
  await collections.tasksDb.insert({
    id: 'legacy-structured-stopped',
    projectId: project.id,
    templateId: 'builder',
    executorId: 'test-claude-cli',
    executionMode: 'structured',
    description: 'Old structured task',
    status: 'stopped',
    autonomy: 'auto',
    manager: false,
    kind: 'execute',
    planItemId: null,
    sessionId: 'sess-legacy',
    blockedQuestion: null,
    failureReason: null,
    tokenUsage: ZERO_TOKEN_USAGE,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: async () => { throw new Error('must not run'); } });
  await assert.rejects(() => manager.completeTerminalTask('legacy-structured-stopped'), workerManagerModule.TaskNotPausedError);
});

test('interimCommitTask rejects an ongoing Task on a Project with no repository', async () => {
  const project = await projectService.createProject({ name: 'Interim No Repo', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const task = await manager.startTask({ projectId: project.id, description: 'Still going', executorId: 'test-claude-cli' });
  await assert.rejects(() => manager.interimCommitTask(task.id), workerManagerModule.TaskNotInterimCommittableError);
});

test('a new terminal task starts at zero token usage (interactive-CLI Tasks have no live usage extraction)', async () => {
  const project = await projectService.createProject({ name: 'Token Usage Flow', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Build the thing' });
  assert.deepEqual(task.tokenUsage, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 });

  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status !== 'developing');
  const resolved = await manager.getTask(task.id);
  assert.deepEqual(resolved.tokenUsage, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 });
});

test('answerTask rejects when the task is not blocked', async () => {
  const project = await projectService.createProject({ name: 'Not Blocked', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Quick task' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  await assert.rejects(() => manager.answerTask(task.id, 'anything'), workerManagerModule.TaskNotBlockedError);
});

test('answerTask resumes a legacy blocked Task\'s CLI session in place, on its own executor, once it has an answer', async () => {
  // 'blocked' is a TaskStatus a live Task can no longer reach (only the removed structured/headless
  // contract ever produced it — see settleBlocked's history) — but a Task record from before that
  // removal can still be sitting in the store this way, and answerTask now continues it the same way
  // every other Task runs: through the interactive CLI, resuming the same session in place rather
  // than starting a fresh one.
  const project = await projectService.createProject({ name: 'Legacy Blocked Resume', position: null });
  const now = new Date().toISOString();
  await collections.tasksDb.insert({
    id: 'legacy-blocked-task',
    projectId: project.id,
    templateId: 'builder',
    executorId: 'test-claude-cli-alt',
    description: 'Build a UI',
    status: 'blocked',
    autonomy: 'auto',
    manager: false,
    kind: 'execute',
    planItemId: null,
    sessionId: 'sess-legacy-blocked',
    blockedQuestion: 'Which framework?',
    failureReason: null,
    tokenUsage: ZERO_TOKEN_USAGE,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
  await collections.taskContextsDb.insert({ id: 'legacy-blocked-task', taskId: 'legacy-blocked-task', turns: [] });
  await projectService.patchProject(project.id, { status: 'blocked', activeTaskId: 'legacy-blocked-task', activeTaskIds: ['legacy-blocked-task'] });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: async () => { throw new Error('must not run'); }, terminalSessions: terminal.host });

  // A prior "waiting for input" alert for this same conversation — answerTask should resolve it.
  const needsInput = await notificationService.raiseNotification({
    kind: 'task.needs_input',
    subject: { type: 'task', projectId: project.id, conversationId: 'legacy-blocked-task', taskId: 'legacy-blocked-task' },
    title: 'Needs your input: Build a UI',
    description: 'Which framework?',
  });

  const answered = await manager.answerTask('legacy-blocked-task', 'Use React');
  assert.equal(answered.status, 'developing');
  assert.equal(answered.blockedQuestion, null);
  assert.equal(answered.executionMode, 'terminal', 'answering now always continues via the interactive CLI');

  assert.ok((await notificationService.getNotification(needsInput.id)).resolvedAt, 'answerTask resolves the conversation\'s task.needs_input');

  assert.equal(terminal.starts.length, 1);
  assert.equal(terminal.starts[0]?.bin, 'claude-alt', "must resume on the Task's own executor, not the default");
  assert.equal(terminal.starts[0]?.env.CLAUDE_CONFIG_DIR, '/tmp/does-not-matter');
  assert.equal(terminal.starts[0]?.sessionId, 'sess-legacy-blocked');
  assert.equal(terminal.starts[0]?.resume, true);
  assert.equal(terminal.starts[0]?.prompt, 'Use React');

  const transcript = await manager.getTaskTranscript('legacy-blocked-task');
  assert.deepEqual(transcript!.turns.map((t) => t.role), ['answer'], 'the answer is transcribed distinctly from an ordinary "prompt"');

  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask('legacy-blocked-task')).status === 'stopped');
});

test('answerTask rejects when the Task\'s own executor is no longer a supported interactive CLI', async () => {
  const project = await projectService.createProject({ name: 'Legacy Blocked Unsupported', position: null });
  const now = new Date().toISOString();
  await collections.tasksDb.insert({
    id: 'legacy-blocked-unsupported',
    projectId: project.id,
    templateId: 'builder',
    executorId: 'test-unsupported',
    description: 'Build a UI',
    status: 'blocked',
    autonomy: 'auto',
    manager: false,
    kind: 'execute',
    planItemId: null,
    sessionId: 'sess-legacy',
    blockedQuestion: 'Which framework?',
    failureReason: null,
    tokenUsage: ZERO_TOKEN_USAGE,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
  await collections.taskContextsDb.insert({ id: 'legacy-blocked-unsupported', taskId: 'legacy-blocked-unsupported', turns: [] });
  await projectService.patchProject(project.id, { status: 'blocked', activeTaskId: 'legacy-blocked-unsupported', activeTaskIds: ['legacy-blocked-unsupported'] });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: async () => { throw new Error('must not run'); } });

  await assert.rejects(() => manager.answerTask('legacy-blocked-unsupported', 'anything'), workerManagerModule.ExecutorNotSupportedError);
});

test('startTask rejects when the project already has an active task', async () => {
  const project = await projectService.createProject({ name: 'Busy Project', position: null });
  // The terminal session is left open deliberately, so the first task stays "developing" for the
  // conflict check below, then closed before the test ends so it doesn't leak a permanently-
  // "developing" task into later tests (resumeInterruptedTasks, in particular, scans every task
  // still "developing").
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  await manager.startTask({ projectId: project.id, description: 'First task' });
  await assert.rejects(
    () => manager.startTask({ projectId: project.id, description: 'Second task' }),
    workerManagerModule.TaskConflictError,
  );

  terminal.starts[0]?.onExit(0);
  // Wait for the project (not just the task) to fully settle before the test ends, so this
  // project's now-finished task can never be mistaken for one still "developing" by a later test.
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('a spawn failure settles the task as "failed" with the error message, and frees the project', async () => {
  const project = await projectService.createProject({ name: 'Errors Out', position: null });
  const host = {
    start: () => { throw new Error('spawn claude ENOENT'); },
    attach: () => () => undefined,
    write() {}, resize() {}, stop: () => true, has: () => true, isAttached: () => false, count: () => 0,
  };
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: host });

  const task = await manager.startTask({ projectId: project.id, description: 'Doomed task' });
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  const failed = await manager.getTask(task.id);
  assert.match(failed.failureReason ?? '', /ENOENT/);

  const projectAfter = await projectService.getProject(project.id);
  assert.equal(projectAfter.status, 'idle');
  assert.equal(projectAfter.activeTaskId, null);

  const notifications = await notificationService.listNotifications({ projectId: project.id });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.severity, 'critical');
  assert.equal(notifications[0]?.kind, 'task.failed');
  assert.match(notifications[0]?.description ?? '', /ENOENT/);
});

test('the transcript records the prompt and result turns in order', async () => {
  const project = await projectService.createProject({ name: 'Transcribed', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Do the work' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  const transcript = await manager.getTaskTranscript(task.id);
  assert.ok(transcript);
  assert.deepEqual(transcript!.turns.map((t) => t.role), ['prompt', 'result']);
  assert.match(transcript!.turns[0]!.content, /Do the work/);
  assert.equal(transcript!.turns[1]!.content, 'Interactive CLI session paused.');
});

test('resumeInterruptedTasks never relaunches a pre-workflow "developing" task after a restart — it pauses it, resumable by hand', async () => {
  const project = await projectService.createProject({ name: 'Interrupted With Session', position: null });
  const now = new Date().toISOString();
  const task = {
    id: 'interrupted-task-1',
    projectId: project.id,
    templateId: 'builder',
    executorId: 'test-claude-cli',
    executionMode: 'terminal' as const,
    description: 'Original task description',
    status: 'developing' as const,
    autonomy: 'auto' as const,
    manager: false,
    kind: 'execute' as const,
    planItemId: null,
    sessionId: 'sess-before-restart',
    blockedQuestion: null,
    failureReason: null,
    tokenUsage: ZERO_TOKEN_USAGE,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  await collections.tasksDb.insert(task);
  await collections.taskContextsDb.insert({ id: task.id, taskId: task.id, turns: [] });
  await projectService.patchProject(project.id, { status: 'developing', activeTaskId: task.id, activeTaskIds: [task.id] });

  const { manager, terminal } = resumeTestManager();

  // Called twice: each daemon restart (e.g. every `node --watch` reload) must leave it alone.
  await manager.resumeInterruptedTasks();
  await manager.resumeInterruptedTasks();

  assert.ok(terminal.starts.every((s) => s.taskId !== task.id), 'an old-type Task must never auto-restart');
  const settled = await manager.getTask(task.id);
  assert.equal(settled.status, 'stopped');
  assert.equal(settled.sessionId, 'sess-before-restart', 'its session is kept so a person can resume it by hand');
  const projectAfter = await projectService.getProject(project.id);
  assert.equal(projectAfter.status, 'idle');
  assert.deepEqual(projectAfter.activeTaskIds, []);
});

test('resumeInterruptedTasks fails a "developing" task that never got a CLI session id recorded, rather than silently restarting it', async () => {
  const project = await projectService.createProject({ name: 'Interrupted No Session', position: null });
  const now = new Date().toISOString();
  const task = {
    id: 'interrupted-task-2',
    projectId: project.id,
    templateId: 'builder',
    executorId: 'test-claude-cli',
    description: 'Scaffold a Node project',
    status: 'developing' as const,
    autonomy: 'auto' as const,
    manager: false,
    kind: 'execute' as const,
    planItemId: null,
    sessionId: null,
    blockedQuestion: null,
    failureReason: null,
    tokenUsage: ZERO_TOKEN_USAGE,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  await collections.tasksDb.insert(task);
  await collections.taskContextsDb.insert({ id: task.id, taskId: task.id, turns: [] });
  await projectService.patchProject(project.id, { status: 'developing', activeTaskId: task.id });

  const { manager, terminal } = resumeTestManager();

  await manager.resumeInterruptedTasks();
  await waitUntil(async () => (await manager.getTask(task.id)).status === 'failed');

  assert.ok(terminal.starts.every((s) => s.taskId !== task.id), 'no session is ever started for a Task with no recorded CLI session id');
  assert.match((await manager.getTask(task.id)).failureReason ?? '', /CLI session id was recorded/);
});

test('resumeInterruptedTasks leaves blocked tasks alone', async () => {
  const project = await projectService.createProject({ name: 'Stays Blocked', position: null });
  const now = new Date().toISOString();
  const task = {
    id: 'blocked-task-1',
    projectId: project.id,
    templateId: 'builder',
    executorId: 'test-claude-cli',
    description: 'Needs a decision',
    status: 'blocked' as const,
    autonomy: 'auto' as const,
    manager: false,
    kind: 'execute' as const,
    planItemId: null,
    sessionId: 'sess-blocked',
    blockedQuestion: 'Which framework?',
    failureReason: null,
    tokenUsage: ZERO_TOKEN_USAGE,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  await collections.tasksDb.insert(task);
  await collections.taskContextsDb.insert({ id: task.id, taskId: task.id, turns: [] });
  await projectService.patchProject(project.id, { status: 'blocked', activeTaskId: task.id });

  const { manager, terminal } = resumeTestManager();

  await manager.resumeInterruptedTasks();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(terminal.starts.every((s) => s.taskId !== task.id));
  assert.equal((await manager.getTask(task.id)).status, 'blocked');
});

test('onWorkerEvent observes project and task updates as a task runs to completion', async () => {
  const project = await projectService.createProject({ name: 'Observed', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const seenTypes: string[] = [];
  manager.onWorkerEvent((event) => seenTypes.push(event.type));

  await manager.startTask({ projectId: project.id, description: 'Watched task' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  assert.ok(seenTypes.includes('project'));
  assert.ok(seenTypes.includes('task'));
  assert.ok(seenTypes.includes('log'));
});

test('planning is CLI-only: an executor whose kind is no longer a supported interactive CLI is refused before any Task exists', async () => {
  const project = await projectService.createProject({ name: 'Planned', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  await assert.rejects(
    manager.startTask({ projectId: project.id, description: 'Draft the specs', executorId: 'test-unsupported', kind: 'plan' }),
    workerManagerModule.PlanningRequiresCliError,
  );
  assert.equal(terminal.starts.length, 0);
  assert.deepEqual(await manager.listTasksForProject(project.id), []);
  assert.equal((await projectService.getProject(project.id)).status, 'idle');
});

test('with no executor chosen, a planning session runs on the first interactive CLI configured', async () => {
  const project = await projectService.createProject({ name: 'Planned Default CLI', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Draft the specs', kind: 'plan' });

  assert.equal(task.executorId, 'test-claude-cli', 'the default executor');
  assert.equal(task.executionMode, 'terminal');
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('a planning Task whose executor is no longer a supported interactive CLI fails on follow-up instead of running', async () => {
  const project = await projectService.createProject({ name: 'Legacy Structured Planning', position: null });
  const now = new Date().toISOString();
  await collections.tasksDb.insert({
    id: 'legacy-structured-plan',
    projectId: project.id,
    templateId: 'builder',
    executorId: 'test-unsupported',
    description: 'Old planning chat',
    status: 'done',
    autonomy: 'auto',
    manager: false,
    kind: 'plan',
    planItemId: null,
    sessionId: 'sess-legacy-plan',
    blockedQuestion: null,
    failureReason: null,
    tokenUsage: ZERO_TOKEN_USAGE,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });
  await collections.taskContextsDb.insert({ id: 'legacy-structured-plan', taskId: 'legacy-structured-plan', turns: [] });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const followUp = await manager.followUpTask('legacy-structured-plan', 'Keep planning');
  await waitUntil(async () => (await manager.getTask(followUp.id)).status === 'failed');

  assert.equal(terminal.starts.length, 0, 'no terminal session is ever started for an unsupported executor kind');
  assert.match((await manager.getTask(followUp.id)).failureReason ?? '', /cannot run this kind of Task/);
});

test('startTask({autonomy: "approval"}) overrides the Template\'s default and actually runs the session gated, not just bypassed', async () => {
  // The Builder Template's own defaultAutonomy is 'auto' (catalog/catalog-index.json) — this proves an
  // explicit per-Task override wins over that default and is threaded all the way to the CLI's
  // own autonomy flag, not merely accepted-and-ignored (docs/roadmap.md's "test the... toggle").
  const project = await projectService.createProject({ name: 'Approval Override', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Build the thing', autonomy: 'approval' });
  assert.equal(task.autonomy, 'approval');
  assert.equal(terminal.starts[0]?.autonomy, 'approval', 'an "approval" autonomy Task must run the CLI\'s gated default permission mode, not bypassPermissions');
  assert.equal((await manager.getTask(task.id)).autonomy, 'approval', 'the override must persist on the settled TaskRecord too');
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status !== 'developing');
});

test('startTask with no autonomy input falls back to the Template\'s defaultAutonomy, unaffected by an unrelated Task\'s override', async () => {
  const project = await projectService.createProject({ name: 'Default Autonomy', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Build another thing' });
  assert.equal(task.autonomy, 'auto', "must fall back to the Builder Template's defaultAutonomy ('auto') when no override is given");
  assert.equal(terminal.starts[0]?.autonomy, 'auto');
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status !== 'developing');
});

test('an ordinary ("execute") Task never disallows the Task tool, so native sub-agent delegation is never blocked by default', async () => {
  const project = await projectService.createProject({ name: 'Ordinary Execute', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  await manager.startTask({ projectId: project.id, description: 'Build the thing' });
  assert.equal(terminal.starts[0]?.disallowedTools, undefined, 'an execute-kind Task must not disallow any tools, including Task, today');
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('a Manager Template\'s Task is flagged manager:true on the TaskRecord and never gets the Task tool disallowed', async () => {
  const project = await projectService.createProject({ name: 'Managed Project', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Ship the feature', templateId: 'manager' });
  assert.equal(task.templateId, 'manager');
  assert.equal(task.manager, true, 'manager must be copied from the Catalog Template onto the running TaskRecord');

  const disallowed = terminal.starts[0]?.disallowedTools ?? [];
  assert.ok(!disallowed.includes('Task'), 'a manager-flagged Task must always retain access to the native delegation (Task) tool');
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('the seeded Builder Template\'s Task is flagged manager:false', async () => {
  const project = await projectService.createProject({ name: 'Builder Project', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Build the thing', templateId: 'builder' });
  assert.equal(task.manager, false);
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

// ---- Catalog Skills folded into a Task's Worker (server-daemon-architect Task 2) ----

test('startTask persists chosen skillIds on the TaskRecord and folds each always-load Skill body into the system prompt, after the persona, in skill-id order', async () => {
  const project = await projectService.createProject({ name: 'Skilled Project', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  // Passed out of alphabetical order on purpose — the fold must still land in *skill-id* order
  // ("commit-style" before "lint-rules"), independent of the order they were requested in.
  const task = await manager.startTask({
    projectId: project.id,
    description: 'Ship the feature',
    templateId: 'builder',
    skillIds: ['lint-rules', 'commit-style'],
    preloadSkillIds: ['lint-rules', 'commit-style'],
  });
  assert.deepEqual(task.skillIds, ['lint-rules', 'commit-style'], 'the TaskRecord keeps skillIds exactly as requested');

  const prompt = terminal.starts[0]?.systemPrompt ?? '';
  assert.match(prompt, /Builder/, 'the persona must still be present');
  const personaIndex = prompt.indexOf('Builder');
  const commitIndex = prompt.indexOf('Write commit messages in the imperative mood.');
  const lintIndex = prompt.indexOf('Always run the linter before finishing a Task.');
  assert.ok(personaIndex >= 0 && commitIndex > personaIndex, 'skill content must come after the persona');
  assert.ok(lintIndex > personaIndex, 'skill content must come after the persona');
  assert.ok(commitIndex < lintIndex, 'skills must be folded in skill-id order (commit-style before lint-rules), not request order');
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('each folded Skill is headed by its id, an "already loaded" note, and its absolute SKILL.md path, so the agent never reports it as missing', async () => {
  const project = await projectService.createProject({ name: 'Loaded Skill Project', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  await manager.startTask({ projectId: project.id, description: 'Ship it', templateId: 'builder', skillIds: ['commit-style'], preloadSkillIds: ['commit-style'] });

  const prompt = terminal.starts[0]?.systemPrompt ?? '';
  assert.match(prompt, /## Skill: .+ \(`commit-style`\)/, 'the heading must carry the skill id the task description refers to');
  assert.match(prompt, /This skill is already loaded/);
  assert.ok(prompt.includes(path.join(process.env.AGENT_VISUAL_OS_CATALOG_DIR!, 'skills', 'commit-style', 'SKILL.md')), 'the absolute SKILL.md path must be named');
  assert.ok(prompt.indexOf('already loaded') < prompt.indexOf('Write commit messages in the imperative mood.'), 'the note must precede the skill body');
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('startTask with no skillIds behaves exactly as before: the system prompt is just the persona', async () => {
  const project = await projectService.createProject({ name: 'Skill-less Project', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Build the thing', templateId: 'builder' });
  assert.equal(task.skillIds, undefined, 'skillIds stays undefined, the same shape an older TaskRecord has');

  const builderPersona = await catalogService.readAgentPersona((await catalogService.getAgent('builder'))!);
  assert.ok(terminal.starts[0]?.systemPrompt.startsWith(`${builderPersona}\n\n## Running this project's tests\n`), 'the persona, plus the testing instructions every coding session gets');
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('startTask rejects an unknown skillId with SkillNotFoundError and a disabled skillId with SkillDisabledError — neither persists a Task', async () => {
  const project = await projectService.createProject({ name: 'Bad Skills Project', position: null });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: async () => { throw new Error('must not run'); } });

  await assert.rejects(
    () => manager.startTask({ projectId: project.id, description: 'x', skillIds: ['does-not-exist'] }),
    catalogService.SkillNotFoundError,
  );
  await assert.rejects(
    () => manager.startTask({ projectId: project.id, description: 'x', skillIds: ['retired-skill'] }),
    workerManagerModule.SkillDisabledError,
  );

  const tasks = await manager.listTasksForProject(project.id);
  assert.deepEqual(tasks, [], 'a Task referencing an invalid skillId must never be created');
});

test('startTask rejects an unknown templateId with AgentNotFoundError and a disabled templateId with TemplateDisabledError', async () => {
  const project = await projectService.createProject({ name: 'Bad Template Project', position: null });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: async () => { throw new Error('must not run'); } });

  await assert.rejects(
    () => manager.startTask({ projectId: project.id, description: 'x', templateId: 'does-not-exist' }),
    catalogService.AgentNotFoundError,
  );

  await catalogService.setAgentEnabled('builder', false);
  try {
    await assert.rejects(
      () => manager.startTask({ projectId: project.id, description: 'x', templateId: 'builder' }),
      workerManagerModule.TemplateDisabledError,
    );
  } finally {
    await catalogService.setAgentEnabled('builder', true);
  }

  const tasks = await manager.listTasksForProject(project.id);
  assert.deepEqual(tasks, [], 'a Task referencing an invalid/disabled templateId must never be created');
});

test('followUpTask carries the prior Task\'s skillIds forward, and folds them into the follow-up session\'s system prompt', async () => {
  const project = await projectService.createProject({ name: 'Skilled Follow-up Project', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const first = await manager.startTask({
    projectId: project.id,
    description: 'Ship the feature',
    templateId: 'builder',
    skillIds: ['lint-rules'],
    preloadSkillIds: ['lint-rules'],
  });
  terminal.starts[0]?.onExit(0);
  // settleStopped writes the Task before removing it from Project.activeTaskIds; follow-up must wait
  // for that second write too or this test can race itself under full-suite CPU contention.
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  const followUp = await manager.followUpTask(first.id, 'Now add tests');
  assert.deepEqual(followUp.skillIds, ['lint-rules']);
  assert.deepEqual(followUp.preloadSkillIds, ['lint-rules']);
  assert.match(terminal.starts[1]?.systemPrompt ?? '', /Always run the linter before finishing a Task\./);
  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(followUp.id)).status === 'stopped');
});

test('even a hypothetical manager-flagged "plan" Task keeps the Task tool available while still disallowing the shell tools', async () => {
  // Defensive coverage for resolveDisallowedTools: today only 'plan' Tasks set
  // disallowedTools at all, and PLAN_DISALLOWED_TOOLS never includes 'Task' —
  // but a Manager Template is expected to always run 'execute', so this proves
  // the guarantee holds independent of `kind` too, in case that ever changes.
  const project = await projectService.createProject({ name: 'Managed Planning', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  await manager.startTask({ projectId: project.id, description: 'Draft a plan', templateId: 'manager', executorId: 'test-claude-cli', kind: 'plan' });

  const disallowed = terminal.starts[0]?.disallowedTools ?? [];
  assert.deepEqual(disallowed, planModule.PLAN_DISALLOWED_TOOLS, 'PLAN_DISALLOWED_TOOLS as-is contains no delegation tool, so nothing should be filtered out of it');
  assert.ok(!disallowed.includes('Task'));
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('followUpTask carries the manager flag forward from the Catalog Template, not just the prior Task', async () => {
  const project = await projectService.createProject({ name: 'Managed Follow-up', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const first = await manager.startTask({ projectId: project.id, description: 'Ship the feature', templateId: 'manager' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  const followUp = await manager.followUpTask(first.id, 'Now also handle the edge case');
  assert.equal(followUp.manager, true);
  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(followUp.id)).status === 'stopped');
});

test('executePlanItem starts a WorkflowRun whose first step\'s Task is linked back to the item, and completes it once the run finishes', async () => {
  const project = await projectService.createProject({ name: 'Breakdown Runner', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Add login form', description: 'Email + password fields.' });
  const manager = createStepTestManager(async (options) => ({ sessionId: `sess-${options.taskId}`, status: 'done', message: 'Added it', raw: { type: 'result' } }));

  const events: WorkerEvent[] = [];
  manager.onWorkerEvent((e) => events.push(e));

  const task = await settledExecute(manager)(item.id);
  assert.equal(task.kind, 'execute');
  assert.equal(task.planItemId, item.id);
  assert.ok(task.workflowRunId, 'the item is now run through its Workflow, not a bare Task');

  const itemAfterStart = await planItemService.getPlanItem(item.id);
  assert.equal(itemAfterStart.status, 'developing');
  assert.deepEqual(itemAfterStart.taskIds, [task.id], 'the step Task is still recorded on the item, same as any other linked Task');

  await waitUntil(async () => events.some((e) => e.type === 'planItem' && e.planItem.status === 'done'));
  const itemAfterDone = await planItemService.getPlanItem(item.id);
  assert.equal(itemAfterDone.status, 'done');
});

test('executePlanItem runs each WorkflowStep with its own agent, skills and autonomy', async () => {
  const project = await projectService.createProject({ name: 'Breakdown Runner With Skill', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Set up docs', description: '' });
  const manager = createStepTestManager(async (options) => ({ sessionId: `sess-${options.taskId}`, status: 'done', message: 'done', raw: { type: 'result' } }));

  // The fixture Workflow's one step uses the `builder` agent with no skills.
  const task = await settledExecute(manager)(item.id);
  assert.equal(task.templateId, 'builder');
  assert.deepEqual(task.skillIds, undefined);
  assert.equal(task.autonomy, 'auto');
  await waitUntil(async () => (await manager.getTask(task.id)).status === 'done');
});

test('executePlanItem records the run\'s executor on an unassigned item', async () => {
  const project = await projectService.createProject({ name: 'Breakdown Records Worker', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Record the worker', description: '' });
  const manager = createStepTestManager(async (options) => ({ sessionId: `sess-${options.taskId}`, status: 'done', message: 'ok', raw: { type: 'result' } }));

  const events: WorkerEvent[] = [];
  manager.onWorkerEvent((e) => events.push(e));
  const task = await settledExecute(manager)(item.id, { executorId: 'test-claude-cli-alt' });

  assert.equal(task.executorId, 'test-claude-cli-alt');
  await waitUntil(async () => events.some((e) => e.type === 'planItem' && e.planItem.status === 'done'));
  const after = await planItemService.getPlanItem(item.id);
  assert.equal(after.executorId, 'test-claude-cli-alt', 'the first run records its worker on the item');
});

// A stale `executorId` saved on the item (an old assignment, or a value some other caller wrote
// directly) must never win over what's chosen when the task actually starts — see collections.planItemsDb
// below, which stands in for that stale state since there's no longer any "assign worker" action to set it.
test('before an item first runs, a caller-supplied worker wins over its saved one; once it has run, its locked worker wins', async () => {
  const project = await projectService.createProject({ name: 'Breakdown Saved Worker', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Use the chosen worker', description: '' });
  await collections.planItemsDb.update(item.id, { executorId: 'test-codex-cli' });
  const manager = createStepTestManager(async (options) => ({ sessionId: `sess-${options.taskId}`, status: 'done', message: 'ok', raw: { type: 'result' } }));

  const first = await settledExecute(manager)(item.id, { executorId: 'test-claude-cli' });
  assert.equal(first.executorId, 'test-claude-cli', 'the start dialog\'s choice');
  await waitUntil(async () => (await planItemService.getPlanItem(item.id)).status === 'done');
  await waitUntil(async () => (await manager.getTask(first.id)).status === 'done');
  assert.equal((await planItemService.getPlanItem(item.id)).executorId, 'test-claude-cli', 'recorded, and now locked');

  const rerun = await settledExecute(manager)(item.id, { executorId: 'test-codex-cli' });
  assert.equal(rerun.executorId, 'test-claude-cli', 'a re-run keeps the locked worker');
  await waitUntil(async () => (await manager.getTask(rerun.id)).status === 'done');
});

test('with no worker chosen, executePlanItem uses the item\'s saved one', async () => {
  const project = await projectService.createProject({ name: 'Breakdown Default Worker', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Use the saved worker', description: '' });
  await collections.planItemsDb.update(item.id, { executorId: 'test-codex-cli' });
  const manager = createStepTestManager(async (options) => ({ sessionId: `sess-${options.taskId}`, status: 'done', message: 'ok', raw: { type: 'result' } }));

  const task = await settledExecute(manager)(item.id);
  assert.equal(task.executorId, 'test-codex-cli');
  await waitUntil(async () => (await manager.getTask(task.id)).status === 'done');
});

test('executePlanItem runs the chosen workflowId instead of the Project\'s, and 404s an unknown one', async () => {
  await workflowService.createWorkflow({
    id: 'quick-fix', name: 'Quick Fix', description: 'One review step.',
    steps: [{ id: 'review', name: 'Review', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'Review it.' }],
  });
  const project = await projectService.createProject({ name: 'Chosen Workflow', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Pick a workflow', description: '' });
  const manager = createStepTestManager(async (options) => ({ sessionId: `sess-${options.taskId}`, status: 'done', message: 'ok', raw: { type: 'result' } }));

  await assert.rejects(() => settledExecute(manager)(item.id, { workflowId: 'no-such-workflow' }), workflowService.WorkflowNotFoundError);
  const task = await settledExecute(manager)(item.id, { workflowId: 'quick-fix' });
  assert.equal(task.workflowStepId, 'review');
  const run = await collections.workflowRunsDb.get(task.workflowRunId!);
  assert.equal(run?.workflowId, 'quick-fix');
  await waitUntil(async () => (await planItemService.getPlanItem(item.id)).status === 'done');
});

test('createBranch:false refuses (ProjectFolderBusyError) while a coding Task already works in the project folder; createBranch:true needs a repository', async () => {
  const project = await projectService.createProject({ name: 'In Place Conflict', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Run in place', description: '' });
  const manager = createStepTestManager(async () => new Promise<never>(() => undefined));

  await assert.rejects(() => settledExecute(manager)(item.id, { createBranch: true }), workerManagerModule.BranchRequiresRepositoryError);

  const first = await settledExecute(manager)(item.id, { createBranch: false });
  assert.equal(first.worktreePath, undefined, 'works in the project folder');
  const run = await collections.workflowRunsDb.get(first.workflowRunId!);
  assert.equal(run?.worktreePath, undefined);
  assert.equal(run?.branch, undefined, 'no repository, so no branch at all');

  // The step is still running, and it holds the folder — the Project's one slot is taken, so the
  // concurrency cap answers first; with the cap out of the way (an awaiting-approval run holds no
  // Task), the folder check does.
  const second = await planItemService.createPlanItem({ projectId: project.id, title: 'Also in place', description: '' });
  await assert.rejects(() => settledExecute(manager)(second.id, { createBranch: false }), workerManagerModule.TaskConflictError);
  await manager.stopWorkflowRun(first.workflowRunId!);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
  await collections.workflowRunsDb.update(first.workflowRunId!, { status: 'awaiting-approval' });
  await assert.rejects(() => settledExecute(manager)(second.id, { createBranch: false }), workerManagerModule.ProjectFolderBusyError);
  await collections.workflowRunsDb.update(first.workflowRunId!, { status: 'stopped' });
});

test('followUpTask resumes a settled Task\'s session with a fresh instruction, as a new linked Task', async () => {
  const project = await projectService.createProject({ name: 'Follow Up Flow', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const first = await manager.startTask({ projectId: project.id, description: 'Add a login form' });
  terminal.starts[0]?.onExit(0, undefined, 'sess-followup-1');
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  const followUp = await manager.followUpTask(first.id, 'Also add a remember-me checkbox');
  assert.notEqual(followUp.id, first.id, 'a follow-up is a new Task, not a mutation of the finished one');
  assert.equal(followUp.description, 'Also add a remember-me checkbox');

  assert.equal(terminal.starts[1]?.resume, true, 'must resume the original session, not start a fresh one');
  assert.equal(terminal.starts[1]?.sessionId, 'sess-followup-1');
  assert.match(terminal.starts[1]?.prompt ?? '', /Also add a remember-me checkbox/);

  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(followUp.id)).status === 'stopped');
});

test('followUpTask rejects a still-active (developing) Task — use stopTask instead', async () => {
  const project = await projectService.createProject({ name: 'Follow Up Rejected', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Build a UI' });

  await assert.rejects(() => manager.followUpTask(task.id, 'never mind'), workerManagerModule.TaskNotFollowableError);
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(task.id)).status === 'stopped');
});

test('followUpTask rejects when the project already has a different active Task', async () => {
  const project = await projectService.createProject({ name: 'Follow Up Conflict', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const first = await manager.startTask({ projectId: project.id, description: 'First' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  await manager.startTask({ projectId: project.id, description: 'Second, still running' });

  await assert.rejects(() => manager.followUpTask(first.id, 'follow up'), workerManagerModule.TaskConflictError);

  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('a planning session can start and follow up while a coding Task holds the Project\'s only slot', async () => {
  const project = await projectService.createProject({ name: 'Plan Beside Coding', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  await manager.startTask({ projectId: project.id, description: 'Code, still running' });

  const planning = await manager.startTask({ projectId: project.id, description: 'Plan meanwhile', executorId: 'test-claude-cli', kind: 'plan' });
  assert.equal(planning.worktreePath, undefined, 'a planning session reads the Project directory, never a worktree');
  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(planning.id)).status !== 'developing');

  const followUp = await manager.followUpTask(planning.id, 'Refine it');
  assert.equal(followUp.kind, 'plan');
  terminal.starts[2]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(followUp.id)).status !== 'developing');

  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('a coding Task can start while a planning session runs, and still takes the Project directory', async () => {
  const project = await projectService.createProject({ name: 'Coding Beside Plan', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  await manager.startTask({ projectId: project.id, description: 'Plan, still running', executorId: 'test-claude-cli', kind: 'plan' });

  const coding = await manager.startTask({ projectId: project.id, description: 'Code meanwhile' });
  assert.equal(coding.worktreePath, undefined);
  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(coding.id)).status === 'stopped');

  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('a failed step Task is reflected as a blocked PlanItem, via its WorkflowRun needing attention', async () => {
  const project = await projectService.createProject({ name: 'Breakdown Blocked', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Needs a decision', description: '' });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  await settledExecute(manager)(item.id);
  terminal.starts[0]?.onExit(1);
  await waitUntil(async () => (await planItemService.getPlanItem(item.id)).status === 'blocked');
});

test('planning follow-ups stay in one session and archive/restore persist for every turn', async () => {
  const project = await projectService.createProject({ name: 'Planning Sessions', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const first = await manager.startTask({ projectId: project.id, description: 'Plan the feature', executorId: 'test-claude-cli', kind: 'plan' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
  const next = await manager.followUpTask(first.id, 'Refine the plan');
  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
  assert.equal(next.kind, 'plan');
  assert.equal(next.conversationId, first.sessionId);
  assert.equal(terminal.starts[1]?.sessionId, first.sessionId);
  assert.equal(terminal.starts[1]?.resume, true);

  // One notification keyed to the original task's own identity, one to the follow-up's (its
  // conversationId, first.sessionId) — archiving the whole session should resolve both.
  const onFirst = await notificationService.raiseNotification({
    kind: 'task.needs_input', subject: { type: 'task', projectId: project.id, conversationId: first.id, taskId: first.id }, title: 't', description: 'd',
  });
  const onNext = await notificationService.raiseNotification({
    kind: 'task.failed', subject: { type: 'task', projectId: project.id, conversationId: first.sessionId!, taskId: next.id }, title: 't', description: 'd',
  });

  await manager.archiveSession(next.id, true);
  assert.ok((await manager.listTasksForProject(project.id)).every(task => task.archived));
  assert.ok((await manager.getTask(next.id)).planningCompletedAt, 'archiving a planning conversation uses planning completion');
  assert.ok((await notificationService.getNotification(onFirst.id)).resolvedAt, 'archiving resolves the original task\'s own identity');
  assert.ok((await notificationService.getNotification(onNext.id)).resolvedAt, 'archiving resolves the follow-up\'s conversation identity');

  await manager.archiveSession(first.id, false);
  assert.ok((await manager.listTasksForProject(project.id)).every(task => task.archived === false));
});

test('a planning follow-up keeps the session\'s generated title, and deleteSession removes every turn and its transcript but refuses a live one', async () => {
  const project = await projectService.createProject({ name: 'Deleted Planning Session', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const first = await manager.startTask({ projectId: project.id, description: 'Plan the feature', executorId: 'test-claude-cli', kind: 'plan' });
  await assert.rejects(() => manager.deleteSession(first.id), workerManagerModule.TaskConflictError);
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
  await collections.tasksDb.update(first.id, { title: 'Plan the whole feature' });
  const next = await manager.followUpTask(first.id, 'Refine the plan');
  assert.equal(next.title, 'Plan the whole feature');

  const events: unknown[] = [];
  manager.onWorkerEvent((event) => events.push(event));
  await manager.renameSession(first.id, 'Renamed while live');
  assert.ok((await manager.listTasksForProject(project.id)).every((task) => task.title === 'Renamed while live'), 'every turn, even while one is live');
  assert.equal(events.length, 2);
  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  const onConversation = await notificationService.raiseNotification({
    kind: 'task.completed', subject: { type: 'task', projectId: project.id, conversationId: first.sessionId!, taskId: next.id }, title: 't', description: 'd',
  });

  await manager.deleteSession(next.id);
  assert.deepEqual(await manager.listTasksForProject(project.id), []);
  assert.equal(await collections.taskContextsDb.get(first.id), undefined);
  assert.equal(await collections.taskContextsDb.get(next.id), undefined);
  assert.ok((await notificationService.getNotification(onConversation.id)).resolvedAt, 'deleteSession resolves the conversation\'s task.* notifications');
});

test('active planning sessions cannot be archived', async () => {
  const project = await projectService.createProject({ name: 'Active Planning Session', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const task = await manager.startTask({ projectId: project.id, description: 'Plan', executorId: 'test-claude-cli', kind: 'plan' });
  await assert.rejects(() => manager.archiveSession(task.id, true), (error: unknown) => {
    assert.ok(error instanceof workerManagerModule.SessionStillRunningError);
    assert.deepEqual([error.code, error.details.taskId], ['session_still_running', task.id]);
    assert.match(error.message, /^This planning session is still running/);
    return true;
  });
  await assert.rejects(() => manager.completePlanningSession(task.id), workerManagerModule.SessionStillRunningError);
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('completing or archiving an already archived planning session succeeds without change, and restoring one that is not archived is a no-op', async () => {
  const project = await projectService.createProject({ name: 'Idempotent Planning Session', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const task = await manager.startTask({ projectId: project.id, description: 'Plan', executorId: 'test-claude-cli', kind: 'plan' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  await manager.archiveSession(task.id, false);
  assert.equal((await manager.getTask(task.id)).archived ?? false, false);
  await manager.completePlanningSession(task.id);
  assert.equal((await manager.getTask(task.id)).archived, true);
  await manager.completePlanningSession(task.id);
  await manager.archiveSession(task.id, true);
  assert.equal((await manager.getTask(task.id)).archived, true);
});

test('listAllTasks returns every Task across every project — the source data for the footer\'s per-executor usage totals', async () => {
  const projectA = await projectService.createProject({ name: 'Usage Aggregation A', position: null });
  const projectB = await projectService.createProject({ name: 'Usage Aggregation B', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const taskA = await manager.startTask({ projectId: projectA.id, description: 'Do A' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(projectA.id)).status === 'idle');
  const taskB = await manager.startTask({ projectId: projectB.id, description: 'Do B' });
  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(projectB.id)).status === 'idle');

  const all = await manager.listAllTasks();
  const ids = all.map((t) => t.id);
  assert.ok(ids.includes(taskA.id));
  assert.ok(ids.includes(taskB.id));
});

test('two different Projects can each run an active Task at the same time, fully independently of each other', async () => {
  // Regression coverage for "Support multiple Projects registered and being worked on
  // simultaneously" (docs/roadmap.md). Unlike the single-Project conflict test above
  // ('startTask rejects when the project already has an active task'), withProjectLock and
  // activeTaskId are keyed per-project (see projects/git.ts, projects/projectService.ts) — there
  // is no global lock serializing every Project onto one active Task. This test starts Tasks on
  // two separate Projects on the *same* WorkerManager instance before either settles, and proves
  // each Project's state — activeTaskId, status, and transcript — is kept independent: stopping one
  // must not affect the other, and settling one must not affect the other either.
  const projectA = await projectService.createProject({ name: 'Concurrent A', position: null });
  const projectB = await projectService.createProject({ name: 'Concurrent B', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const taskA = await manager.startTask({ projectId: projectA.id, description: 'Task A' });
  const taskB = await manager.startTask({ projectId: projectB.id, description: 'Task B' });

  assert.notEqual(taskA.id, taskB.id);
  assert.equal((await projectService.getProject(projectA.id)).activeTaskId, taskA.id);
  assert.equal((await projectService.getProject(projectB.id)).activeTaskId, taskB.id);
  assert.equal((await projectService.getProject(projectA.id)).status, 'developing');
  assert.equal((await projectService.getProject(projectB.id)).status, 'developing');

  // stopTask only stops the terminal session registered under that exact taskId — proving the two
  // in-flight Tasks have independent sessions, not a shared single slot.
  await manager.stopTask(taskA.id);
  assert.deepEqual(terminal.stops, [taskA.id], "stopping Task A's session must never reach Task B's");
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(taskA.id)).status === 'stopped');
  assert.equal((await projectService.getProject(projectB.id)).activeTaskId, taskB.id, "Project B's active task must be untouched by Project A settling");
  assert.equal((await projectService.getProject(projectB.id)).status, 'developing');
  assert.equal((await manager.getTask(taskB.id)).status, 'developing');

  // Settling B (a plain clean exit) must not touch A's already-stopped state.
  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(taskB.id)).status === 'stopped');
  assert.equal((await projectService.getProject(projectA.id)).status, 'idle', "Project A's already-settled state must be untouched by Project B settling");
  assert.equal((await projectService.getProject(projectA.id)).activeTaskId, null);

  // Independent transcripts too — no cross-talk between the two Tasks' turn logs.
  const transcriptA = await manager.getTaskTranscript(taskA.id);
  const transcriptB = await manager.getTaskTranscript(taskB.id);
  assert.ok(transcriptA!.turns.every((t) => !t.content.includes('Task B')));
  assert.ok(transcriptB!.turns.every((t) => !t.content.includes('Task A')));
});

test('interactive CLI lifecycle hooks map to running and waiting states', () => {
  const map = workerManagerModule.terminalRuntimeFromHook;
  assert.deepEqual(map({ hook_event_name: 'SessionStart' }), { status: 'running', reason: null });
  assert.deepEqual(map({ hook_event_name: 'PreToolUse' }), { status: 'running', reason: null });
  assert.deepEqual(map({ hook_event_name: 'PermissionRequest' }), { status: 'waiting_input', reason: 'Waiting for approval' });
  assert.deepEqual(
    map({ hook_event_name: 'Notification', notification_type: 'agent_needs_input' }),
    { status: 'waiting_input', reason: 'Waiting for your input' },
  );
  assert.deepEqual(map({ hook_event_name: 'Stop' }), { status: 'waiting_input', reason: 'Waiting for your next instruction' });
  assert.deepEqual(map({ hook_event_name: 'SessionEnd' }), { status: 'completed', reason: null });
  assert.equal(map({ hook_event_name: 'UnknownEvent' }), null);
});

test('a terminal waiting hook propagates to project and open task, and only notifies when its terminal view is closed', async () => {
  const closedProject = await projectService.createProject({ name: 'Closed Waiting Terminal', position: null });
  const closedItem = await planItemService.createPlanItem({ projectId: closedProject.id, title: 'Needs input', description: '' });
  const closedTerminal = fakeTerminalHost(false);
  const closedManager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: closedTerminal.host });
  const closedTask = await closedManager.startTask({ projectId: closedProject.id, description: 'Needs input', executorId: 'test-claude-cli', planItemId: closedItem.id });

  await closedManager.handleTerminalHook(closedTask.id, { hook_event_name: 'Stop' });

  assert.equal((await closedManager.getTask(closedTask.id)).runtimeStatus, 'waiting_input');
  assert.equal((await projectService.getProject(closedProject.id)).status, 'blocked');
  assert.equal((await planItemService.getPlanItem(closedItem.id)).status, 'blocked');
  const notifications = await notificationService.listNotifications({ projectId: closedProject.id });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.kind, 'task.needs_input');
  assert.match(notifications[0]!.title, /needs your input/i);

  await closedManager.handleTerminalHook(closedTask.id, { hook_event_name: 'UserPromptSubmit' });
  assert.equal((await projectService.getProject(closedProject.id)).status, 'developing');
  assert.equal((await planItemService.getPlanItem(closedItem.id)).status, 'developing');
  closedTerminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await closedManager.getTask(closedTask.id)).status === 'stopped');

  const openProject = await projectService.createProject({ name: 'Open Waiting Terminal', position: null });
  const openTerminal = fakeTerminalHost(true);
  const openManager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: openTerminal.host });
  const openTask = await openManager.startTask({ projectId: openProject.id, description: 'Visible terminal', executorId: 'test-claude-cli' });

  await openManager.handleTerminalHook(openTask.id, { hook_event_name: 'Stop' });
  assert.deepEqual(await notificationService.listNotifications({ projectId: openProject.id }), []);
  openTerminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await openManager.getTask(openTask.id)).status === 'stopped');
});

/** A workflow step Task running in a closed terminal view (the case that would otherwise notify), for the step-hook tests below. */
async function startStepTaskWithHooks(name: string) {
  const project = await projectService.createProject({ name, position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Do the thing', description: '' });
  const terminal = fakeTerminalHost(false);
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const task = await settledExecute(manager)(item.id, { executorId: 'test-claude-cli' });
  const runOf = async () => (await manager.getWorkflowRunDetail(task.workflowRunId!)).run;
  const notificationsOf = () => notificationService.listNotifications({ projectId: project.id });
  return { project, item, terminal, manager, task, runOf, notificationsOf };
}

test('a step\'s Stop hook after complete_step already resolved its round is suppressed — no false "needs your input" alarm', async () => {
  // Regression coverage for "whenever a step completes, I get false alarms of it needs my input":
  // the CLI's Stop hook fires the instant the turn that called complete_step ends, before the
  // daemon's endStepSession has torn the session down.
  const { project, manager, task, runOf, notificationsOf } = await startStepTaskWithHooks('Step Stop After Complete');
  await manager.completeStep(task.id, { summary: 'Done.' });
  const runBefore = await runOf();
  const notificationsBefore = (await notificationsOf()).length;

  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });
  await manager.handleTerminalHook(task.id, { hook_event_name: 'PermissionRequest' });

  assert.equal((await manager.getTask(task.id)).runtimeStatus, 'running', 'teardown residue reads as an ordinary running tick');
  assert.equal((await manager.getTask(task.id)).runtimeWaitingReason, null);
  assert.equal((await runOf()).status, runBefore.status, 'the run is untouched by it');
  assert.equal((await notificationsOf()).length, notificationsBefore, 'no false "waiting for input" notification');
  assert.notEqual((await projectService.getProject(project.id)).status, 'blocked');
});

test('a step\'s Stop hook while its round is still unresolved is a genuine question: the run needs attention until the person answers', async () => {
  const { project, item, manager, task, runOf, notificationsOf } = await startStepTaskWithHooks('Step Genuine Question');

  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });

  assert.equal((await manager.getTask(task.id)).runtimeStatus, 'waiting_input');
  const waitingRun = await runOf();
  assert.equal(waitingRun.status, 'needs-attention');
  assert.equal(waitingRun.attentionReason, 'Waiting for your next instruction');
  assert.equal((await planItemService.getPlanItem(item.id)).status, 'blocked');
  assert.equal((await projectService.getProject(project.id)).status, 'blocked');
  const raised = await notificationsOf();
  assert.equal(raised.length, 1, 'exactly one notification — the run\'s, not a second Task-level one');
  assert.equal(raised[0]!.kind, 'workflow.needs_attention');
  assert.equal(raised[0]!.severity, 'critical');

  // A repeated wait signal for the same question doesn't raise another notification.
  await manager.handleTerminalHook(task.id, { hook_event_name: 'Notification', notification_type: 'idle_prompt' });
  assert.equal((await notificationsOf()).length, 1);

  // The person answers in the step's live session — the run goes back to running and its alert resolves.
  await manager.handleTerminalHook(task.id, { hook_event_name: 'UserPromptSubmit' });
  const resumedRun = await runOf();
  assert.equal(resumedRun.status, 'running');
  assert.equal(resumedRun.attentionReason, null);
  assert.ok((await notificationsOf())[0]!.resolvedAt);
  assert.equal((await planItemService.getPlanItem(item.id)).status, 'developing');

  // A further running tick with nothing pending leaves the run alone.
  await manager.handleTerminalHook(task.id, { hook_event_name: 'PreToolUse' });
  assert.equal((await runOf()).status, 'running');

  // …and the step still reports normally afterwards.
  await manager.completeStep(task.id, { summary: 'Done after answering.' });
  await waitUntil(async () => (await planItemService.getPlanItem(item.id)).status === 'done');
});

test('a step\'s question uses the CLI Notification hook\'s own message as the run\'s attention reason', async () => {
  const { manager, task, runOf } = await startStepTaskWithHooks('Step Question Message');

  await manager.handleTerminalHook(task.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: '  Claude needs your permission to use Bash  ' });

  assert.equal((await runOf()).attentionReason, 'Claude needs your permission to use Bash');
  await manager.completeStep(task.id, { summary: 'Done.' });
});

test('a step session that exits while its question is unanswered replaces the question with why it ended', async () => {
  const { terminal, manager, task, runOf, notificationsOf } = await startStepTaskWithHooks('Step Question Then Exit');
  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });
  const questionNotification = (await notificationsOf())[0]!;
  assert.equal(questionNotification.resolvedAt, null);

  terminal.starts[0]!.onExit(1, undefined, terminal.starts[0]!.sessionId ?? undefined);
  await waitUntil(async () => /ended without completing/.test((await runOf()).attentionReason ?? ''));

  const run = await runOf();
  assert.equal(run.status, 'needs-attention');
  const notifications = await notificationsOf();
  assert.ok(notifications.find((n) => n.id === questionNotification.id)?.resolvedAt, 'the stale question alert is resolved, not leaked');
  assert.equal(notifications.filter((n) => n.resolvedAt === null).length, 1);
});

test('stepQuestionFromHook falls back to the waiting reason, then a generic question', () => {
  const { stepQuestionFromHook } = workerManagerModule;
  assert.equal(stepQuestionFromHook({ message: 'Which DB?' }, 'Waiting for your input'), 'Which DB?');
  assert.equal(stepQuestionFromHook({ message: '   ' }, 'Waiting for your input'), 'Waiting for your input');
  assert.equal(stepQuestionFromHook({ message: 42 }, null), 'The step is waiting for your input.');
});

const stepRunStub = (createdAt: string, completedAt: string | null) => ({ createdAt, completedAt }) as never;

test('priorRoundsMs is zero for a step\'s first-ever round (no earlier rounds at all)', () => {
  const { priorRoundsMs } = workerManagerModule;
  assert.equal(priorRoundsMs([]), 0);
});

test('priorRoundsMs sums only settled rounds strictly before the newest one — every round passed in, each one\'s completedAt - createdAt', () => {
  const { priorRoundsMs } = workerManagerModule;
  const rounds = [
    stepRunStub('2026-09-26T00:00:00.000Z', '2026-09-26T00:02:00.000Z'),
    stepRunStub('2026-09-26T01:00:00.000Z', '2026-09-26T01:05:00.000Z'),
  ];
  assert.equal(priorRoundsMs(rounds), 120_000 + 300_000);
});

test('priorRoundsMs uses only completedAt - createdAt, ignoring a round with no completedAt rather than throwing', () => {
  const { priorRoundsMs } = workerManagerModule;
  const rounds = [stepRunStub('2026-09-26T00:00:00.000Z', '2026-09-26T00:02:00.000Z'), stepRunStub('2026-09-26T01:00:00.000Z', null)];
  assert.equal(priorRoundsMs(rounds), 120_000, 'the round with no completedAt contributes nothing');
});

test('a planning session runs in a terminal with only the user prompt, the planning instructions, and shell tools denied', async () => {
  const project = await projectService.createProject({ name: 'Terminal Planning', position: null });
  await planItemService.createPlanItem({ projectId: project.id, title: 'Existing breakdown item', description: '' });
  const structured = fakeRunClaudeTurn([]);
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: structured.fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Plan the login flow', executorId: 'test-claude-cli', kind: 'plan' });

  assert.equal(task.kind, 'plan');
  assert.equal(task.executionMode, 'terminal');
  assert.equal(structured.calls.length, 0);
  const start = terminal.starts[0]!;
  assert.equal(start.kind, 'claude-cli');
  const workflow = (await workflowService.getDefaultWorkflow())!;
  assert.equal(start.prompt, `Plan the login flow\n\n${planModule.buildPlanInstructions(workflow)}`);
  assert.doesNotMatch(start.prompt, /Existing breakdown item/, 'the existing breakdown is no longer injected');
  assert.deepEqual(start.disallowedTools, planModule.PLAN_DISALLOWED_TOOLS);
  assert.equal(start.readOnly, true, 'a planning session never changes project files');
  assert.deepEqual(start.mcpServers?.map((server) => server.name), ['agent_visual_os'], 'only the task-management API: a planning session runs no tests');
  assert.equal(start.mcpServers?.[0]?.env.AGENT_VISUAL_OS_TASK_ID, task.id, 'the session gets the task-creation API, scoped to itself');
  assert.doesNotMatch(start.systemPrompt, /list_test_actions/);
  assert.match(start.prompt, /create_task/);
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('createPlanningTask adds an open task to a running planning session\'s Project and broadcasts it', async () => {
  const project = await projectService.createProject({ name: 'Planning Creates Tasks', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const events: WorkerEvent[] = [];
  manager.onWorkerEvent((event) => events.push(event));

  const task = await manager.startTask({ projectId: project.id, description: 'Plan it', executorId: 'test-claude-cli', kind: 'plan' });
  const item = await manager.createPlanningTask(task.id, { title: 'Add login', description: 'Email + password' });

  assert.equal(item.projectId, project.id);
  assert.equal(item.title, '1.001: Add login');
  assert.deepEqual(item.planningRef, { session: 1, task: 1 });
  assert.equal(item.description, 'Email + password');
  assert.equal(item.status, 'pending');
  assert.equal(item.milestoneId, null);
  assert.deepEqual((await planItemService.listPlanItems(project.id)).map((i) => i.id), [item.id]);
  assert.ok(events.some((event) => event.type === 'planItem' && event.planItem.id === item.id));

  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(task.id)).status === 'stopped');
  await assert.rejects(manager.createPlanningTask(task.id, { title: 'Late', description: '' }), workerManagerModule.TaskNotPlanningSessionError, 'a paused session can no longer create tasks');
});

test('planning completion is eligible only after task creation and defers while the planning turn is live', async () => {
  const project = await projectService.createProject({ name: 'Deferred Planning Completion', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const planning = await manager.startTask({ projectId: project.id, description: 'Plan it', kind: 'plan' });
  const linked = await manager.createPlanningTask(planning.id, { title: 'Only task', description: '' });

  await manager.deletePlanningTask(planning.id, linked.id);
  assert.equal((await manager.getTask(planning.id)).archived, undefined, 'a live planning turn is never interrupted');

  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => !!(await manager.getTask(planning.id)).planningCompletedAt);
  const completed = await manager.getTask(planning.id);
  assert.equal(completed.archived, true);
  assert.equal(completed.planningCreatedTaskCount, 1);
});

test('a zero-task planning session stays in Planning, while manual completion releases and restoration regroups ready work', async () => {
  const project = await projectService.createProject({ name: 'Manual Planning Completion', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const empty = await manager.startTask({ projectId: project.id, description: 'No tasks yet', kind: 'plan' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(empty.id)).status === 'stopped');
  assert.equal((await manager.getTask(empty.id)).archived, undefined);

  const resumed = await manager.followUpTask(empty.id, 'Create work');
  const linked = await manager.createPlanningTask(resumed.id, { title: 'Ready work', description: '' });
  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(resumed.id)).status === 'stopped');
  await manager.completePlanningSession(resumed.id);
  assert.ok((await manager.listTasksForProject(project.id)).every((member) => member.archived));
  assert.equal((await planItemService.getPlanItem(linked.id)).status, 'pending', 'manual completion never changes linked work');
  assert.equal(typeof (await planItemService.getPlanItem(linked.id)).planningQueueOrder, 'number', 'released placement is durable even if the parent is later deleted');

  await manager.archiveSession(resumed.id, false);
  const restored = await manager.getTask(resumed.id);
  assert.equal(restored.archived, false);
  assert.equal(restored.planningCompletedAt, null);
  assert.equal(restored.planningAutoCompleteArmed, true, 'restored ready work remains eligible when its final task leaves Planning');
});

test('released children retain their queue positions after planning-session deletion and database reload', async () => {
  const project = await projectService.createProject({ name: 'Durable Released Planning Order', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const planning = await manager.startTask({ projectId: project.id, description: 'Plan', kind: 'plan' });
  const first = await manager.createPlanningTask(planning.id, { title: 'First', description: '' });
  const standalone = await planItemService.createPlanItem({ projectId: project.id, title: 'Standalone', description: '' });
  const second = await manager.createPlanningTask(planning.id, { title: 'Second', description: '' });
  await manager.reorderPlanningQueue(project.id, [{ kind: 'session', id: planning.id }, { kind: 'task', id: standalone.id }]);
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(planning.id)).status === 'stopped');

  await manager.completePlanningSession(planning.id);
  await manager.deleteSession(planning.id);
  const { FileDatabase } = await import('../src/db/FileDatabase.ts');
  const persisted = await new FileDatabase<import('../src/domain/types.ts').PlanItemRecord>(path.join(process.env.AGENT_VISUAL_OS_DATA_DIR!, 'plan-items.json')).all();
  const ordered = persisted.filter((item) => [first.id, second.id, standalone.id].includes(item.id))
    .sort((a, b) => a.planningQueueOrder! - b.planningQueueOrder!);
  assert.deepEqual(ordered.map((item) => item.id), [first.id, second.id, standalone.id]);
  assert.ok(ordered.every((item) => item.planningQueueOrder !== undefined));
  assert.ok(ordered.slice(0, 2).every((item) => item.planningRef?.session === planning.planningSessionNumber));
});

test('starting the final linked item through its WorkflowRun completes an idle planning session', async () => {
  const project = await projectService.createProject({ name: 'Planning Workflow Start', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const planning = await manager.startTask({ projectId: project.id, description: 'Plan', kind: 'plan' });
  const linked = await manager.createPlanningTask(planning.id, { title: 'Run this', description: '' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(planning.id)).status === 'stopped');

  const started = await settledExecute(manager)(linked.id, { executorId: 'test-claude-cli' });
  assert.ok(started.workflowRunId);
  assert.equal((await planItemService.getPlanItem(linked.id)).status, 'developing');
  assert.equal((await manager.getTask(planning.id)).planningCompletedAt !== null, true);
  assert.equal((await manager.getTask(planning.id)).archived, true);
  terminal.starts[1]?.onExit(0);
});

test('a pre-feature planning conversation with linked work auto-completes when its final task starts', async () => {
  const project = await projectService.createProject({ name: 'Legacy Planning Completion', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const planning = await manager.startTask({ projectId: project.id, description: 'Old plan', kind: 'plan' });
  const linked = await manager.createPlanningTask(planning.id, { title: 'Old linked work', description: '' });
  await collections.tasksDb.update(planning.id, { planningCreatedTaskCount: undefined, planningAutoCompleteArmed: undefined });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(planning.id)).status === 'stopped');
  await settledExecute(manager)(linked.id, { executorId: 'test-claude-cli' });
  assert.equal((await manager.getTask(planning.id)).archived, true);
  terminal.starts[1]?.onExit(0);
});

test('deleting the final linked task preserves a pre-feature session\'s completion eligibility', async () => {
  const project = await projectService.createProject({ name: 'Legacy Planning Delete Completion', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const planning = await manager.startTask({ projectId: project.id, description: 'Old plan', kind: 'plan' });
  const linked = await manager.createPlanningTask(planning.id, { title: 'Delete me', description: '' });
  await collections.tasksDb.update(planning.id, { planningCreatedTaskCount: undefined, planningAutoCompleteArmed: undefined });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(planning.id)).status === 'stopped');
  await manager.deletePlanItem(linked.id);
  assert.equal((await manager.getTask(planning.id)).archived, true);
});

test('a failed planning-completion write reports an error without rejecting an accepted execution start', async () => {
  const project = await projectService.createProject({ name: 'Accepted Start Completion Failure', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const planning = await manager.startTask({ projectId: project.id, description: 'Plan', kind: 'plan' });
  const linked = await manager.createPlanningTask(planning.id, { title: 'Run it', description: '' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(planning.id)).status === 'stopped');
  const events: WorkerEvent[] = [];
  manager.onWorkerEvent((event) => events.push(event));
  const original = collections.tasksDb.updateMany.bind(collections.tasksDb);
  collections.tasksDb.updateMany = async () => { throw new Error('archive storage unavailable'); };
  let started;
  try {
    started = await settledExecute(manager)(linked.id, { executorId: 'test-claude-cli' });
  } finally {
    collections.tasksDb.updateMany = original;
  }
  assert.ok(started.workflowRunId);
  assert.equal((await planItemService.getPlanItem(linked.id)).status, 'developing');
  assert.equal((await manager.getTask(planning.id)).archived, undefined);
  assert.ok(events.some((event) => event.type === 'planningCompletionError' && event.message.includes('archive storage unavailable')));
  terminal.starts[1]?.onExit(0);
});

test('completed planning conversations require restoration before either follow-up or resume', async () => {
  const project = await projectService.createProject({ name: 'Restore Before Planning Resume', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const planning = await manager.startTask({ projectId: project.id, description: 'Plan', kind: 'plan' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(planning.id)).status === 'stopped');
  await manager.completePlanningSession(planning.id);
  await assert.rejects(manager.followUpTask(planning.id, 'More work'), workerManagerModule.PlanningSessionArchivedError);
  await assert.rejects(manager.resumeTerminalTask(planning.id), workerManagerModule.PlanningSessionArchivedError);
  assert.equal((await manager.listTasksForProject(project.id)).length, 1);
  await manager.archiveSession(planning.id, false);
  const resumed = await manager.resumeTerminalTask(planning.id);
  assert.equal(resumed.archived, undefined);
  terminal.starts[1]?.onExit(0);
});

test('starting the final linked item defers completion until its live planning turn settles', async () => {
  const project = await projectService.createProject({ name: 'Live Planning Workflow Start', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const planning = await manager.startTask({ projectId: project.id, description: 'Plan', kind: 'plan' });
  const linked = await manager.createPlanningTask(planning.id, { title: 'Run this', description: '' });
  await settledExecute(manager)(linked.id, { executorId: 'test-claude-cli' });
  assert.equal((await manager.getTask(planning.id)).archived, undefined);
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => !!(await manager.getTask(planning.id)).planningCompletedAt);
  terminal.starts[1]?.onExit(0);
});

test('failed planning completion leaves the session and ready children unchanged without publishing archive events', async () => {
  const project = await projectService.createProject({ name: 'Planning Completion Failure', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const planning = await manager.startTask({ projectId: project.id, description: 'Plan', kind: 'plan' });
  const linked = await manager.createPlanningTask(planning.id, { title: 'Ready', description: '' });
  const events: WorkerEvent[] = [];
  manager.onWorkerEvent((event) => events.push(event));
  terminal.starts[0]?.onExit(0);
  // settleStopped stores status 'stopped' before emitting its project and task events; wait for that
  // final task event so the exit settle's own emits are not counted as completion events.
  await waitUntil(async () => events.some((event) => event.type === 'task' && event.task.id === planning.id && event.task.status === 'stopped'));
  events.length = 0;
  const original = collections.tasksDb.updateMany.bind(collections.tasksDb);
  collections.tasksDb.updateMany = async () => { throw new Error('persist failed'); };
  try {
    await assert.rejects(() => manager.completePlanningSession(planning.id), /persist failed/);
  } finally {
    collections.tasksDb.updateMany = original;
  }
  assert.equal((await manager.getTask(planning.id)).archived, undefined);
  assert.equal((await planItemService.getPlanItem(linked.id)).planningQueueOrder, undefined);
  assert.equal((await planItemService.getPlanItem(linked.id)).status, 'pending');
  assert.equal(events.length, 0);
});

test('the mixed Planning queue persists session and standalone task order and rejects nested task ids', async () => {
  const project = await projectService.createProject({ name: 'Mixed Planning Order', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const planning = await manager.startTask({ projectId: project.id, description: 'Plan', kind: 'plan' });
  const nested = await manager.createPlanningTask(planning.id, { title: 'Nested', description: '' });
  const standalone = await planItemService.createPlanItem({ projectId: project.id, title: 'Standalone', description: '' });

  await manager.reorderPlanningQueue(project.id, [{ kind: 'task', id: standalone.id }, { kind: 'session', id: planning.id }]);
  assert.equal((await planItemService.getPlanItem(standalone.id)).planningQueueOrder, 0);
  assert.equal((await manager.getTask(planning.id)).planningQueueOrder, 1);
  await assert.rejects(manager.reorderPlanningQueue(project.id, [{ kind: 'task', id: nested.id }, { kind: 'session', id: planning.id }]), planItemService.PlanItemNotFoundError);

  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(planning.id)).status === 'stopped');
});

test('a planning group\'s ready tasks reorder only among themselves, and new or unpositioned tasks join the end', async () => {
  const project = await projectService.createProject({ name: 'Planning Group Order', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const planning = await manager.startTask({ projectId: project.id, description: 'Plan', kind: 'plan' });
  const other = await manager.startTask({ projectId: project.id, description: 'Other plan', kind: 'plan' });
  const first = await manager.createPlanningTask(planning.id, { title: 'First', description: '' });
  const second = await manager.createPlanningTask(planning.id, { title: 'Second', description: '' });
  const third = await manager.createPlanningTask(planning.id, { title: 'Third', description: '' });
  const foreign = await manager.createPlanningTask(other.id, { title: 'Foreign', description: '' });
  const standalone = await planItemService.createPlanItem({ projectId: project.id, title: 'Standalone', description: '' });
  const events: WorkerEvent[] = [];
  manager.onWorkerEvent((event) => events.push(event));

  await manager.reorderPlanningGroup(project.id, planning.id, [third.id, first.id, second.id]);
  const saved = await Promise.all([third, first, second].map((item) => planItemService.getPlanItem(item.id)));
  assert.deepEqual(saved.map((item) => item.planningGroupOrder), [0, 1, 2]);
  assert.deepEqual(saved.map((item) => item.title), [third.title, first.title, second.title], 'titles and numbers are unchanged');
  assert.deepEqual(saved.map((item) => item.planningRef?.task), [3, 1, 2]);
  assert.equal(events.filter((event) => event.type === 'planItem').length, 3);

  const refused = [
    [third.id, first.id, second.id, foreign.id],
    [third.id, first.id, standalone.id],
    [third.id, first.id],
    [third.id, first.id, first.id],
  ];
  for (const ids of refused) await assert.rejects(manager.reorderPlanningGroup(project.id, planning.id, ids), workerManagerModule.PlanningQueueConflictError);
  await assert.rejects(manager.reorderPlanningGroup(project.id, planning.id, [third.id, 'unknown']), planItemService.PlanItemNotFoundError);
  await assert.rejects(manager.reorderPlanningGroup(project.id, 'unknown', []), workerManagerModule.TaskNotFoundError);
  await assert.rejects(manager.reorderPlanningGroup('other-project', planning.id, []), workerManagerModule.TaskNotFoundError);
  assert.equal((await planItemService.getPlanItem(third.id)).planningGroupOrder, 0, 'refusals change nothing');

  const fourth = await manager.createPlanningTask(planning.id, { title: 'Fourth', description: '' });
  assert.equal((await planItemService.getPlanItem(fourth.id)).planningGroupOrder, undefined);
  const group = (await planItemService.listPlanItems(project.id)).filter((item) => item.planningRef?.session === planning.planningSessionNumber)
    .sort(planItemService.comparePlanningGroupOrder);
  assert.deepEqual(group.map((item) => item.id), [third.id, first.id, second.id, fourth.id], 'a later task joins the end');

  await planItemService.updatePlanItem(first.id, { status: 'developing' });
  await assert.rejects(manager.reorderPlanningGroup(project.id, planning.id, [first.id, third.id, second.id, fourth.id]), workerManagerModule.PlanningQueueConflictError, 'a started task has left the group');
  await manager.reorderPlanningGroup(project.id, planning.id, [fourth.id, second.id, third.id]);

  for (const start of terminal.starts) start.onExit(0);
  await waitUntil(async () => (await manager.getTask(planning.id)).status === 'stopped' && (await manager.getTask(other.id)).status === 'stopped');
  await manager.completePlanningSession(planning.id);
  await assert.rejects(manager.reorderPlanningGroup(project.id, planning.id, []), workerManagerModule.PlanningQueueConflictError, 'a completed conversation has no group');
  const released = await Promise.all([fourth, second, third].map((item) => planItemService.getPlanItem(item.id)));
  assert.ok(released[0]!.planningQueueOrder! < released[1]!.planningQueueOrder! && released[1]!.planningQueueOrder! < released[2]!.planningQueueOrder!, 'completion releases tasks in the custom order');
  assert.deepEqual(released.map((item) => item.planningGroupOrder), [0, 1, 2], 'the group order is kept for restoration');
});

test('a blocked legacy item outside Planning does not prevent mixed-queue reordering', async () => {
  const project = await projectService.createProject({ name: 'Planning Order With Blocked Legacy Work', position: null });
  const blocked = await planItemService.createPlanItem({ projectId: project.id, title: 'Needs input', description: '' });
  await planItemService.updatePlanItem(blocked.id, { status: 'blocked' });
  const first = await planItemService.createPlanItem({ projectId: project.id, title: 'First', description: '' });
  const second = await planItemService.createPlanItem({ projectId: project.id, title: 'Second', description: '' });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: fakeTerminalHost().host });
  await manager.reorderPlanningQueue(project.id, [{ kind: 'task', id: second.id }, { kind: 'task', id: first.id }]);
  assert.equal((await planItemService.getPlanItem(second.id)).planningQueueOrder, 0);
  assert.equal((await planItemService.getPlanItem(blocked.id)).status, 'blocked');
});

test('a failed later mixed-queue write restores every slot and publishes no partial reorder', async () => {
  const project = await projectService.createProject({ name: 'Planning Order Write Failure', position: null });
  const first = await planItemService.createPlanItem({ projectId: project.id, title: 'First', description: '' });
  const second = await planItemService.createPlanItem({ projectId: project.id, title: 'Second', description: '' });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: fakeTerminalHost().host });
  const events: WorkerEvent[] = [];
  manager.onWorkerEvent((event) => events.push(event));
  const original = collections.planItemsDb.update.bind(collections.planItemsDb);
  let writes = 0;
  collections.planItemsDb.update = async (...args) => {
    if (++writes === 2) throw new Error('later queue write failed');
    return original(...args);
  };
  try {
    await assert.rejects(manager.reorderPlanningQueue(project.id, [{ kind: 'task', id: first.id }, { kind: 'task', id: second.id }]), /later queue write failed/);
  } finally {
    collections.planItemsDb.update = original;
  }
  assert.equal((await planItemService.getPlanItem(first.id)).planningQueueOrder, first.planningQueueOrder);
  assert.equal((await planItemService.getPlanItem(second.id)).planningQueueOrder, second.planningQueueOrder);
  assert.equal(events.length, 0);
});

test('a rejected workflow start keeps its linked task in Planning and does not complete its session', async () => {
  const project = await projectService.createProject({ name: 'Planning Rejected Starts', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const planning = await manager.startTask({ projectId: project.id, description: 'Plan', kind: 'plan' });
  const linked = await manager.createPlanningTask(planning.id, { title: 'Still ready', description: '' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager.getTask(planning.id)).status === 'stopped');

  await catalogService.createSkill({ id: 'ephemeral-start-skill', name: 'Ephemeral', description: 'Only for start validation.', body: 'Check.' });
  await workflowService.createWorkflow({
    id: 'missing-start-skill', name: 'Missing Start Skill', description: 'Invalid first step.',
    steps: [{ id: 'build', name: 'Build', agentId: 'builder', skillIds: ['ephemeral-start-skill'], canEditCode: true, requiresApproval: false, instructions: 'Build.' }],
  });
  await catalogService.deleteSkill('ephemeral-start-skill');
  await assert.rejects(settledExecute(manager)(linked.id, { workflowId: 'missing-start-skill' }));
  assert.equal((await planItemService.getPlanItem(linked.id)).status, 'pending');
  assert.equal((await manager.getTask(planning.id)).archived, undefined);

  // A failure after the start was accepted is not a rejection: the run fails at its step and the item stays out of Planning.
  const launch = terminal.host.start;
  terminal.host.start = () => { throw new Error('terminal launch failed'); };
  try {
    const run = await manager.executePlanItem(linked.id, { executorId: 'test-claude-cli' });
    await manager.whenStartupSettled(run.id);
  } finally {
    terminal.host.start = launch;
  }
  const failedItem = await planItemService.getPlanItem(linked.id);
  assert.equal(failedItem.status, 'failed');
  assert.deepEqual(failedItem.taskIds, []);
  assert.equal(failedItem.planningRef?.session, planning.planningSessionNumber);
  assert.equal((await manager.getTask(planning.id)).archived, true, 'the accepted start left Planning, so its session completes as it does for any started item');
  const [failedRun] = await collections.workflowRunsDb.find((run) => run.planItemId === linked.id);
  assert.equal(failedRun!.status, 'failed');
  assert.deepEqual(failedRun!.startup!.steps.find((step) => step.state === 'failed'), { id: 'launch', name: 'Launching agent', state: 'failed', reason: 'terminal launch failed' });
});

test('a planning session can list, edit, and delete its Project\'s tasks, broadcasting each change', async () => {
  const project = await projectService.createProject({ name: 'Planning Manages Tasks', position: null });
  const other = await projectService.createProject({ name: 'Planning Manages Tasks Elsewhere', position: null });
  const foreign = await planItemService.createPlanItem({ projectId: other.id, title: 'Not yours', description: '' });
  const manual = await planItemService.createPlanItem({ projectId: project.id, title: 'Hand-made', description: 'old' });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const events: WorkerEvent[] = [];
  manager.onWorkerEvent((event) => events.push(event));
  const task = await manager.startTask({ projectId: project.id, description: 'Plan it', executorId: 'test-claude-cli', kind: 'plan' });
  const created = await manager.createPlanningTask(task.id, { title: 'Schema', description: 'v1' });

  assert.deepEqual((await manager.listPlanningTasks(task.id)).map((i) => i.id), [manual.id, created.id], 'only this Project\'s tasks, in display order');

  const renamed = await manager.updatePlanningTask(task.id, created.id, { title: 'Database schema' });
  assert.equal(renamed.title, '1.001: Database schema', 'a numbered task keeps its number');
  assert.equal(renamed.description, 'v1');
  const edited = await manager.updatePlanningTask(task.id, manual.id, { title: 'Still hand-made', description: 'new' });
  assert.deepEqual([edited.title, edited.description], ['Still hand-made', 'new']);
  assert.ok(events.some((event) => event.type === 'planItem' && event.planItem.id === manual.id && event.planItem.description === 'new'));

  await manager.deletePlanningTask(task.id, created.id);
  assert.deepEqual((await planItemService.listPlanItems(project.id)).map((i) => i.id), [manual.id]);
  assert.ok(events.some((event) => event.type === 'planItemDeleted' && event.id === created.id && event.projectId === project.id));

  await assert.rejects(manager.updatePlanningTask(task.id, foreign.id, { title: 'Hijacked' }), planItemService.PlanItemNotFoundError);
  await assert.rejects(manager.deletePlanningTask(task.id, foreign.id), planItemService.PlanItemNotFoundError);
  assert.equal((await planItemService.getPlanItem(foreign.id)).title, 'Not yours');

  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
  await assert.rejects(manager.listPlanningTasks(task.id), workerManagerModule.TaskNotPlanningSessionError);
  await assert.rejects(manager.updatePlanningTask(task.id, manual.id, { title: 'Late' }), workerManagerModule.TaskNotPlanningSessionError);
  await assert.rejects(manager.deletePlanningTask(task.id, manual.id), workerManagerModule.TaskNotPlanningSessionError);
});

test('a planning session cannot repurpose a completed task as new open work — it must create a new task instead', async () => {
  // The reported case: 1.001 had already run to completion before a later turn of the session
  // "edited" it into a new task and deleted 1.002–1.006. A done task only ever shows under
  // Completed, so the edited task vanished from the open Tasks list.
  const project = await projectService.createProject({ name: 'Planning Edits A Done Task', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const task = await manager.startTask({ projectId: project.id, description: 'Plan it', executorId: 'test-claude-cli', kind: 'plan' });
  const created = [];
  for (const n of [1, 2, 3, 4, 5, 6]) created.push(await manager.createPlanningTask(task.id, { title: `Step ${n}`, description: `d${n}` }));
  const [first, ...rest] = created;
  await collections.planItemsDb.update(first!.id, { status: 'done', taskIds: ['finished-run'] });

  await assert.rejects(
    manager.updatePlanningTask(task.id, first!.id, { title: 'Redesign', description: 'x'.repeat(20_000) }),
    planItemService.PlanItemCompletedError,
  );
  assert.equal((await planItemService.getPlanItem(first!.id)).title, '1.001: Step 1', 'the completed task is left as it was');
  for (const item of rest) await manager.deletePlanningTask(task.id, item.id);

  const replacement = await manager.createPlanningTask(task.id, { title: 'Redesign', description: 'x'.repeat(20_000) });
  assert.equal(replacement.status, 'pending');
  assert.deepEqual((await manager.listPlanningTasks(task.id)).map((i) => [i.title, i.status]), [['1.001: Step 1', 'done'], ['1.002: Redesign', 'pending']]);

  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('createPlanningTask refuses coding tasks and unknown task ids', async () => {
  const project = await projectService.createProject({ name: 'Coding Cannot Create Tasks', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Implement it', executorId: 'test-claude-cli' });
  await assert.rejects(manager.createPlanningTask(task.id, { title: 'Sneaky', description: '' }), workerManagerModule.TaskNotPlanningSessionError);
  await assert.rejects(manager.createPlanningTask('no-such-task', { title: 'X', description: '' }), workerManagerModule.TaskNotFoundError);
  assert.deepEqual(await planItemService.listPlanItems(project.id), []);

  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('a Codex CLI can run a planning session too', async () => {
  const project = await projectService.createProject({ name: 'Terminal Planning Codex', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Plan the API', executorId: 'test-codex-cli', kind: 'plan', autonomy: 'approval' });

  assert.equal(task.executionMode, 'terminal');
  assert.equal(terminal.starts[0]?.kind, 'codex-cli');
  assert.equal(terminal.starts[0]?.autonomy, 'approval');
  assert.equal(terminal.starts[0]?.readOnly, true, 'Codex has no per-tool deny flag, so its sandbox keeps the session read-only');
  assert.match(terminal.starts[0]?.prompt ?? '', /PLANNING session/);
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('an interactive coding task keeps every tool available', async () => {
  const project = await projectService.createProject({ name: 'Terminal Execute Tools', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  await manager.startTask({ projectId: project.id, description: 'Implement it', executorId: 'test-claude-cli' });

  assert.equal(terminal.starts[0]?.disallowedTools, undefined);
  assert.equal(terminal.starts[0]?.readOnly, false);
  assert.deepEqual(terminal.starts[0]?.mcpServers?.map((server) => server.name), ['agent_visual_os_tests'], 'only planning sessions can create tasks; coding sessions get the testing tools');
  assert.doesNotMatch(terminal.starts[0]?.prompt ?? '', /PLANNING session/);
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('planning sessions are numbered per Project, and a follow-up keeps its session\'s number', async () => {
  const project = await projectService.createProject({ name: 'Numbered Sessions', position: null });
  const other = await projectService.createProject({ name: 'Numbered Sessions Elsewhere', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });

  const first = await manager.startTask({ projectId: project.id, description: 'Plan one', executorId: 'test-claude-cli', kind: 'plan' });
  assert.equal(first.planningSessionNumber, 1);
  await manager.createPlanningTask(first.id, { title: 'A', description: '' });
  await manager.createPlanningTask(first.id, { title: 'B', description: '' });
  terminal.starts.at(-1)?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  const coding = await manager.startTask({ projectId: project.id, description: 'Code it', executorId: 'test-claude-cli' });
  assert.equal(coding.planningSessionNumber, undefined, 'only planning sessions are numbered');
  terminal.starts.at(-1)?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  const second = await manager.startTask({ projectId: project.id, description: 'Plan two', executorId: 'test-claude-cli', kind: 'plan' });
  assert.equal(second.planningSessionNumber, 2);
  await manager.createPlanningTask(second.id, { title: 'C', description: '' });
  terminal.starts.at(-1)?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  const followUp = await manager.followUpTask(first.id, 'One more thing');
  assert.equal(followUp.planningSessionNumber, 1);
  await manager.createPlanningTask(followUp.id, { title: 'D', description: '' });
  terminal.starts.at(-1)?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');

  const elsewhere = await manager.startTask({ projectId: other.id, description: 'Plan elsewhere', executorId: 'test-claude-cli', kind: 'plan' });
  assert.equal(elsewhere.planningSessionNumber, 1, 'numbering is per Project');
  terminal.starts.at(-1)?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(other.id)).status === 'idle');

  assert.deepEqual((await planItemService.listPlanItems(project.id)).map((i) => i.title), ['1.001: A', '1.002: B', '2.001: C', '1.003: D']);
});

test('concurrent create_task calls from one session still get distinct, sequential numbers', async () => {
  const project = await projectService.createProject({ name: 'Concurrent Planning Tasks', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const task = await manager.startTask({ projectId: project.id, description: 'Plan it', executorId: 'test-claude-cli', kind: 'plan' });

  await Promise.all(['A', 'B', 'C'].map((title) => manager.createPlanningTask(task.id, { title, description: '' })));

  const titles = (await planItemService.listPlanItems(project.id)).map((i) => i.title);
  assert.deepEqual(titles.map((t) => t.split(':')[0]), ['1.001', '1.002', '1.003']);
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('a planning session that predates numbering gets the next session number when it first creates a task', async () => {
  const project = await projectService.createProject({ name: 'Legacy Planning Session', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const events: WorkerEvent[] = [];
  manager.onWorkerEvent((event) => events.push(event));
  const numbered = await manager.startTask({ projectId: project.id, description: 'Plan one', executorId: 'test-claude-cli', kind: 'plan' });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
  const legacy = await manager.startTask({ projectId: project.id, description: 'Plan two', executorId: 'test-claude-cli', kind: 'plan' });
  await collections.tasksDb.update(legacy.id, { planningSessionNumber: undefined });

  const item = await manager.createPlanningTask(legacy.id, { title: 'Late', description: '' });

  assert.equal(item.title, '2.001: Late');
  assert.equal((await manager.getTask(legacy.id)).planningSessionNumber, 2);
  assert.ok(events.some((event) => event.type === 'task' && event.task.id === legacy.id && event.task.planningSessionNumber === 2));
  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('retargetPrimaryTasks moves only unsettled Tasks in the primary directory on the old branch, emitting each update', async () => {
  const project = await projectService.createProject({ name: 'Retarget Branch', position: null });
  const other = await projectService.createProject({ name: 'Retarget Other', position: null });
  const now = new Date().toISOString();
  const base = {
    templateId: 'builder', executorId: 'test-claude-cli', description: 'work', autonomy: 'auto' as const, manager: false,
    kind: 'execute' as const, planItemId: null, sessionId: null, blockedQuestion: null, failureReason: null,
    tokenUsage: ZERO_TOKEN_USAGE, createdAt: now, updatedAt: now, completedAt: null,
  };
  const tasks = [
    { ...base, id: 'retarget-blocked', projectId: project.id, status: 'blocked' as const, branch: 'main' },
    { ...base, id: 'retarget-stopped', projectId: project.id, status: 'stopped' as const, branch: 'main' },
    { ...base, id: 'retarget-done', projectId: project.id, status: 'done' as const, branch: 'main' },
    { ...base, id: 'retarget-failed', projectId: project.id, status: 'failed' as const, branch: 'main' },
    { ...base, id: 'retarget-worktree', projectId: project.id, status: 'blocked' as const, branch: 'main', worktreePath: '/tmp/wt' },
    { ...base, id: 'retarget-other-branch', projectId: project.id, status: 'blocked' as const, branch: 'develop' },
    { ...base, id: 'retarget-other-project', projectId: other.id, status: 'blocked' as const, branch: 'main' },
  ];
  for (const task of tasks) await collections.tasksDb.insert(task);

  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: async () => { throw new Error('unused'); } });
  const events: WorkerEvent[] = [];
  const unsubscribe = manager.onWorkerEvent((event) => { events.push(event); });
  await manager.retargetPrimaryTasks(project.id, 'main', 'fix/forgot-to-branch');
  unsubscribe();

  const branchOf = async (id: string) => (await collections.tasksDb.get(id))?.branch;
  assert.equal(await branchOf('retarget-blocked'), 'fix/forgot-to-branch');
  assert.equal(await branchOf('retarget-stopped'), 'fix/forgot-to-branch');
  for (const id of ['retarget-done', 'retarget-failed', 'retarget-worktree', 'retarget-other-project']) assert.equal(await branchOf(id), 'main', id);
  assert.equal(await branchOf('retarget-other-branch'), 'develop');
  assert.deepEqual(events.map((event) => event.type === 'task' ? event.task.id : event.type).sort(), ['retarget-blocked', 'retarget-stopped']);
});

// ---- Real liveness vs. a stale stored status ----

/** Links a minimal WorkflowRun in `status` to a plan item (inserting or re-statusing it) — enough for the liveness guards and the startup self-heal, which only read the run's status. */
async function linkRunWithStatus(item: { id: string; projectId: string }, status: 'running' | 'completed'): Promise<void> {
  const runId = `run-${item.id}`;
  if (await collections.workflowRunsDb.get(runId)) {
    await collections.workflowRunsDb.update(runId, { status });
  } else {
    const now = new Date().toISOString();
    await collections.workflowRunsDb.insert({
      id: runId, projectId: item.projectId, planItemId: item.id, workflowId: 'flow', status,
      workflowSnapshot: { id: 'flow', name: 'Flow', description: '', enabled: true, steps: [] },
      currentStepId: null, executorId: 'test-claude-cli', prUrl: null, completionReport: null,
      attentionReason: null, loopRoundAllowance: 0, createdAt: now, updatedAt: now, completedAt: null,
    } as unknown as Parameters<typeof collections.workflowRunsDb.insert>[0]);
  }
  await collections.planItemsDb.update(item.id, { workflowRunId: runId });
}

test('archive and mark-complete refuse a plan item whose session is really live, naming it by title, but not one whose "developing" status is stale', async () => {
  const project = await projectService.createProject({ name: 'Live Item Guards', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Guarded work', description: '' });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  await manager.startTask({ projectId: project.id, description: 'Do it', planItemId: item.id });

  await assert.rejects(manager.archivePlanItem(item.id, true), (error: Error) =>
    error instanceof planItemService.PlanItemHasActiveTaskError && /^Task "Guarded work" is still running/.test(error.message));
  await assert.rejects(manager.completePlanItem(item.id), planItemService.PlanItemNotCompletableError);
  assert.equal((await manager.archivePlanItem(item.id, false)).archived, false, 'restoring is never refused');

  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
  await collections.planItemsDb.update(item.id, { status: 'developing' }); // left stale, e.g. by a late hook
  assert.equal((await manager.archivePlanItem(item.id, true)).archived, true);
  assert.equal((await manager.completePlanItem(item.id)).status, 'done');
});

test('archivePlanItem refuses an item whose WorkflowRun is still running, and allows it once the run completed', async () => {
  const project = await projectService.createProject({ name: 'Live Run Guard', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Run-backed', description: '' });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: fakeTerminalHost().host });
  await linkRunWithStatus(item, 'running');
  await assert.rejects(manager.archivePlanItem(item.id, true), planItemService.PlanItemHasActiveTaskError);
  await linkRunWithStatus(item, 'completed');
  await collections.planItemsDb.update(item.id, { status: 'developing' });
  assert.equal((await manager.archivePlanItem(item.id, true)).archived, true, 'the reported bug: a completed run\'s item left "developing" archives');
});

test('a planning session may not edit or delete a task whose work is really running', async () => {
  const project = await projectService.createProject({ name: 'Planning Live Guard', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Busy one', description: '' });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const planner = await manager.startTask({ projectId: project.id, description: 'Plan', executorId: 'test-claude-cli', kind: 'plan' });
  await linkRunWithStatus(item, 'running');
  await assert.rejects(manager.updatePlanningTask(planner.id, item.id, { title: 'x' }), /Task "Busy one" is still running — stop or wait for it before editing it$/);
  await assert.rejects(manager.deletePlanningTask(planner.id, item.id), /before deleting it/);
  await linkRunWithStatus(item, 'completed');
  assert.equal((await manager.updatePlanningTask(planner.id, item.id, { title: 'Settled one' })).title, 'Settled one');
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('a Task left "developing" with no live CLI session holds no concurrency slot', async () => {
  const project = await projectService.createProject({ name: 'Stale Slot', position: null }); // no repository: one Task at a time
  let sessionAlive = true;
  const host: TerminalSessionHost = { ...fakeTerminalHost().host, has: () => sessionAlive };
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: host });
  const first = await manager.startTask({ projectId: project.id, description: 'First' });
  await collections.tasksDb.update(first.id, { runtimeStatus: 'running' });
  await assert.rejects(manager.startTask({ projectId: project.id, description: 'Too soon' }), workerManagerModule.TaskConflictError);
  sessionAlive = false; // its session vanished without the exit ever settling it
  const second = await manager.startTask({ projectId: project.id, description: 'Second' });
  assert.equal(second.status, 'developing');
});

test('reconcileStalePlanItems settles an item left "developing" after its run completed or its Task settled, and leaves live ones alone', async () => {
  const project = await projectService.createProject({ name: 'Self Heal', position: null });
  const { manager, terminal } = resumeTestManager();
  const runDone = await planItemService.createPlanItem({ projectId: project.id, title: 'Run finished', description: '' });
  await linkRunWithStatus(runDone, 'completed');
  await collections.planItemsDb.update(runDone.id, { status: 'developing' });
  const runLive = await planItemService.createPlanItem({ projectId: project.id, title: 'Run live', description: '' });
  await linkRunWithStatus(runLive, 'running');
  await collections.planItemsDb.update(runLive.id, { status: 'developing' });
  const plain = await planItemService.createPlanItem({ projectId: project.id, title: 'Plain task', description: '' });
  await manager.startTask({ projectId: project.id, description: 'Do it', planItemId: plain.id });
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
  await manager.completeTerminalTask((await planItemService.getPlanItem(plain.id)).taskIds[0]!);
  await collections.planItemsDb.update(plain.id, { status: 'developing' });

  await manager.reconcileStalePlanItems();

  assert.equal((await planItemService.getPlanItem(runDone.id)).status, 'done');
  assert.equal((await planItemService.getPlanItem(runLive.id)).status, 'developing', 'a running run is left alone');
  assert.equal((await planItemService.getPlanItem(plain.id)).status, 'done', 'mirrors its settled Task');
});

// --- Turn-end while the agent waits on a Test Run it started (B.015) ---

const TURN_END_EVENTS = [
  { hook_event_name: 'Stop' },
  { hook_event_name: 'Notification', notification_type: 'idle_prompt' },
];
const GRACE_MS = 30;

function testRunRecord(over: Partial<import('../src/domain/types.ts').TestRunRecord> & { id: string; projectId: string }): import('../src/domain/types.ts').TestRunRecord {
  return {
    batchId: null,
    suite: { id: 'web', label: 'Web', kind: 'unit' },
    action: { id: 'run', label: 'Run', purpose: 'result', command: 'x', workingDirectory: '.', collectors: [] },
    trigger: 'agent', taskId: null, executionRoot: '/tmp', cwd: null, branch: null, commit: null,
    status: 'running', exitCode: null, queuedAt: new Date().toISOString(), startedAt: null, completedAt: null,
    durationMs: null, outputTruncated: false, summary: null, diagnostics: [], artifactDir: null,
    ...over,
  };
}

async function startStepTaskWithTestEvents(name: string, graceMs = GRACE_MS) {
  const project = await projectService.createProject({ name, position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Do the thing', description: '' });
  const listeners = new Set<(event: import('../src/testing/testRunner.ts').TestRunEvent) => void>();
  const manager = workerManagerModule.createWorkerManager({
    runClaudeTurn: fakeRunClaudeTurn([]).fn,
    terminalSessions: fakeTerminalHost(false).host,
    onTestEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    testRunGraceMs: graceMs,
  });
  const task = await settledExecute(manager)(item.id, { executorId: 'test-claude-cli' });
  const runOf = async () => (await manager.getWorkflowRunDetail(task.workflowRunId!)).run;
  const notificationsOf = () => notificationService.listNotifications({ projectId: project.id });
  /** Registers a Test Run the task's tool waited on, in the given state. */
  const awaitRun = async (id: string, status: 'running' | 'passed', over: Partial<import('../src/domain/types.ts').TestRunRecord> = {}) => {
    const run = await collections.testRunsDb.insert(testRunRecord({ id, projectId: project.id, status, completedAt: status === 'running' ? null : new Date().toISOString(), ...over }));
    await manager.recordAwaitedTestRuns(task.id, [id]);
    return run;
  };
  const finishRun = async (id: string, status: 'passed' | 'failed' | 'error' | 'stopped' = 'passed') => {
    const run = (await collections.testRunsDb.update(id, { status, completedAt: new Date().toISOString() }))!;
    for (const listener of listeners) listener({ type: 'testRun', run });
    return run;
  };
  return { project, item, manager, task, runOf, notificationsOf, awaitRun, finishRun };
}

test('isTurnEndCoveredByTestRun covers only turn-ends with an awaited active (or just-finished) run', () => {
  const { isTurnEndCoveredByTestRun: covered } = workerManagerModule;
  const now = Date.parse('2026-01-01T00:00:10Z');
  const active = { id: 'r1', status: 'running' as const, completedAt: null };
  const queued = { id: 'r1', status: 'queued' as const, completedAt: null };
  const old = { id: 'r1', status: 'passed' as const, completedAt: '2026-01-01T00:00:00Z' };
  const fresh = { id: 'r1', status: 'failed' as const, completedAt: '2026-01-01T00:00:08Z' };
  for (const event of TURN_END_EVENTS) {
    assert.equal(covered(event, ['r1'], [active], now), true);
    assert.equal(covered(event, ['r1'], [queued], now), true);
    assert.equal(covered(event, ['r1'], [fresh], now), true, 'finished moments ago still covers a Stop that lands late');
    assert.equal(covered(event, ['r1'], [old], now), false);
    assert.equal(covered(event, ['other'], [active], now), false, 'run not awaited by this task');
    assert.equal(covered(event, [], [active], now), false);
    assert.equal(covered(event, undefined, [active], now), false);
    assert.equal(covered(event, ['r1'], [], now), false);
  }
  for (const event of [
    { hook_event_name: 'PermissionRequest' },
    { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
    { hook_event_name: 'Notification', notification_type: 'agent_needs_input' },
    { hook_event_name: 'Interrupt' },
    { hook_event_name: 'PreToolUse' },
  ]) assert.equal(covered(event, ['r1'], [active], now), false, JSON.stringify(event));
});

test('a step\'s turn-end while its awaited Test Run is active is not a question: running, no attention, no notification', async () => {
  const { manager, task, runOf, notificationsOf, awaitRun } = await startStepTaskWithTestEvents('Step Waits On Test Run');
  await awaitRun('tr-active', 'running');

  for (const event of TURN_END_EVENTS) await manager.handleTerminalHook(task.id, event);

  const live = await manager.getTask(task.id);
  assert.equal(live.runtimeStatus, 'running');
  assert.equal(live.runtimeWaitingReason, 'Waiting on a test run');
  assert.equal(live.runtimeDeferredWait, true);
  assert.equal((await runOf()).status, 'running');
  assert.equal((await runOf()).attentionReason ?? null, null);
  assert.equal((await notificationsOf()).length, 0);
  manager.dispose();
});

test('a turn-end is still a wait when the run is not one the task awaited, or the hook is an approval request', async () => {
  const { project, manager, task, runOf, notificationsOf, awaitRun } = await startStepTaskWithTestEvents('Step Uncovered Waits');
  // Another task's / a manual run that this task's tool never handed back.
  await collections.testRunsDb.insert(testRunRecord({ id: 'tr-foreign', projectId: project.id, status: 'running', taskId: 'someone-else' }));
  await collections.testRunsDb.insert(testRunRecord({ id: 'tr-manual', projectId: project.id, status: 'running', trigger: 'manual' }));
  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });
  assert.equal((await manager.getTask(task.id)).runtimeStatus, 'waiting_input');
  assert.equal((await runOf()).status, 'needs-attention');
  assert.equal((await notificationsOf()).length, 1);

  // An approval request is real even while an awaited run is active.
  await manager.handleTerminalHook(task.id, { hook_event_name: 'UserPromptSubmit' });
  await awaitRun('tr-awaited', 'running');
  await manager.handleTerminalHook(task.id, { hook_event_name: 'PermissionRequest' });
  assert.equal((await manager.getTask(task.id)).runtimeStatus, 'waiting_input');
  assert.equal((await manager.getTask(task.id)).runtimeDeferredWait, false);
  manager.dispose();
});

test('a joined foreign run (manual or another task\'s) recorded for the task covers its turn-end', async () => {
  const { manager, task, runOf, notificationsOf, awaitRun } = await startStepTaskWithTestEvents('Step Joined Foreign Run');
  await awaitRun('tr-joined', 'running', { trigger: 'manual', taskId: null });

  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });

  assert.equal((await manager.getTask(task.id)).runtimeStatus, 'running');
  assert.equal((await runOf()).status, 'running');
  assert.equal((await notificationsOf()).length, 0);
  manager.dispose();
});

test('recordAwaitedTestRuns dedupes and keeps only the most recent runs', async () => {
  const { manager, task } = await startStepTaskWithTestEvents('Step Awaited Bound');
  await manager.recordAwaitedTestRuns(task.id, ['a', 'b']);
  await manager.recordAwaitedTestRuns(task.id, ['b', 'c']);
  assert.deepEqual((await manager.getTask(task.id)).awaitedTestRunIds, ['a', 'b', 'c']);
  await manager.recordAwaitedTestRuns(task.id, Array.from({ length: 25 }, (_, i) => `n${i}`));
  const ids = (await manager.getTask(task.id)).awaitedTestRunIds!;
  assert.equal(ids.length, 20);
  assert.equal(ids.at(-1), 'n24');
  manager.dispose();
});

test('a covered turn-end while the task was already waiting resolves to running without a new notification', async () => {
  const { manager, task, runOf, notificationsOf, awaitRun } = await startStepTaskWithTestEvents('Step Covered After Wait');
  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });
  assert.equal((await notificationsOf()).length, 1);
  await awaitRun('tr-late', 'running');

  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });

  assert.equal((await manager.getTask(task.id)).runtimeStatus, 'running');
  assert.equal((await runOf()).status, 'running');
  assert.equal((await notificationsOf()).length, 1);
  manager.dispose();
});

test('the run ends and the CLI resumes within the grace period: never flagged', async () => {
  const { manager, task, runOf, notificationsOf, awaitRun, finishRun } = await startStepTaskWithTestEvents('Step Resumes In Grace');
  await awaitRun('tr-resume', 'running');
  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });

  await finishRun('tr-resume');
  await manager.handleTerminalHook(task.id, { hook_event_name: 'PreToolUse' });
  await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3));

  const live = await manager.getTask(task.id);
  assert.equal(live.runtimeStatus, 'running');
  assert.equal(live.runtimeDeferredWait, false);
  assert.equal((await runOf()).status, 'running');
  assert.equal((await notificationsOf()).length, 0);
  manager.dispose();
});

for (const finalStatus of ['passed', 'failed', 'error', 'stopped'] as const) {
  test(`the run ends ${finalStatus} and the CLI stays idle past the grace period: flagged once`, async () => {
    const { manager, task, runOf, notificationsOf, awaitRun, finishRun } = await startStepTaskWithTestEvents(`Step Idle After ${finalStatus}`);
    await awaitRun(`tr-idle-${finalStatus}`, 'running');
    await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });
    assert.equal((await notificationsOf()).length, 0);

    await finishRun(`tr-idle-${finalStatus}`, finalStatus);
    await waitUntil(async () => (await runOf()).status === 'needs-attention');

    const live = await manager.getTask(task.id);
    assert.equal(live.runtimeStatus, 'waiting_input');
    assert.equal(live.runtimeWaitingReason, 'Waiting for your next instruction');
    assert.equal(live.runtimeDeferredWait, false);
    assert.equal((await notificationsOf()).length, 1);

    // A second completion event for the same run finds the hold already released: still one notification.
    await finishRun(`tr-idle-${finalStatus}`, finalStatus);
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3));
    assert.equal((await notificationsOf()).length, 1);
    manager.dispose();
  });
}

test('a batch of awaited runs is flagged only after the last one ends', async () => {
  const { manager, task, runOf, notificationsOf, awaitRun, finishRun } = await startStepTaskWithTestEvents('Step Batch Of Runs');
  await awaitRun('tr-b1', 'running');
  await awaitRun('tr-b2', 'running');
  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });

  await finishRun('tr-b1');
  await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3));
  assert.equal((await runOf()).status, 'running', 'the second run is still active');

  await finishRun('tr-b2');
  await waitUntil(async () => (await runOf()).status === 'needs-attention');
  assert.equal((await notificationsOf()).length, 1);
  manager.dispose();
});

test('a Stop that lands just after the awaited run ended is covered, then flagged after the grace period', async () => {
  const { manager, task, runOf, notificationsOf, awaitRun, finishRun } = await startStepTaskWithTestEvents('Step Stop After Run Ended', 400);
  await awaitRun('tr-fast', 'running');
  await finishRun('tr-fast');

  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });
  assert.equal((await manager.getTask(task.id)).runtimeStatus, 'running');
  assert.equal((await notificationsOf()).length, 0);

  await waitUntil(async () => (await runOf()).status === 'needs-attention', 5000);
  assert.equal((await notificationsOf()).length, 1);
  manager.dispose();
});

test('a later uncovered Stop applies the wait normally and clears the hold', async () => {
  const { manager, task, runOf, awaitRun } = await startStepTaskWithTestEvents('Step Later Uncovered Stop');
  await awaitRun('tr-old', 'passed', { completedAt: '2020-01-01T00:00:00Z' });
  await manager.recordAwaitedTestRuns(task.id, ['tr-old']);
  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });
  assert.equal((await manager.getTask(task.id)).runtimeDeferredWait, false);
  assert.equal((await runOf()).status, 'needs-attention');
  manager.dispose();
});

test('a plain terminal task\'s covered Stop raises no task.needs_input, and an idle CLI after the run raises exactly one', async () => {
  const project = await projectService.createProject({ name: 'Plain Waits On Test Run', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Plain', description: '' });
  const listeners = new Set<(event: import('../src/testing/testRunner.ts').TestRunEvent) => void>();
  const manager = workerManagerModule.createWorkerManager({
    runClaudeTurn: fakeRunClaudeTurn([]).fn,
    terminalSessions: fakeTerminalHost(false).host,
    onTestEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    testRunGraceMs: GRACE_MS,
  });
  const task = await manager.startTask({ projectId: project.id, description: 'Plain', executorId: 'test-claude-cli', planItemId: item.id });
  await collections.testRunsDb.insert(testRunRecord({ id: 'tr-plain', projectId: project.id, status: 'running', taskId: task.id }));
  await manager.recordAwaitedTestRuns(task.id, ['tr-plain']);

  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });
  assert.equal((await manager.getTask(task.id)).runtimeStatus, 'running');
  assert.equal((await manager.getTask(task.id)).runtimeWaitingReason, 'Waiting on a test run');
  assert.equal((await planItemService.getPlanItem(item.id)).status, 'developing');
  assert.equal((await notificationService.listNotifications({ projectId: project.id })).length, 0);

  const run = (await collections.testRunsDb.update('tr-plain', { status: 'passed', completedAt: new Date().toISOString() }))!;
  for (const listener of listeners) listener({ type: 'testRun', run });
  await waitUntil(async () => (await notificationService.listNotifications({ projectId: project.id })).length > 0);
  assert.equal((await manager.getTask(task.id)).runtimeStatus, 'waiting_input');
  const notifications = await notificationService.listNotifications({ projectId: project.id });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.kind, 'task.needs_input');
  manager.dispose();
});

test('dispose cancels pending grace timers and stops listening', async () => {
  const { manager, task, runOf, notificationsOf, awaitRun, finishRun } = await startStepTaskWithTestEvents('Step Dispose Timers');
  await awaitRun('tr-dispose', 'running');
  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });
  await finishRun('tr-dispose');
  await new Promise((resolve) => setImmediate(resolve));

  manager.dispose();
  await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3));

  assert.equal((await runOf()).status, 'running');
  assert.equal((await notificationsOf()).length, 0);
});

test('a restart drops a stale held-back wait without raising attention, even for a task that is not developing', async () => {
  const { manager, task, notificationsOf, awaitRun } = await startStepTaskWithTestEvents('Step Restart Stale Wait');
  await awaitRun('tr-restart', 'running');
  await manager.handleTerminalHook(task.id, { hook_event_name: 'Stop' });
  const stopped = await collections.tasksDb.insert({
    ...(await manager.getTask(task.id)), id: 'stale-stopped-task', status: 'stopped', workflowRunId: null,
    runtimeStatus: 'running', runtimeWaitingReason: 'Waiting on a test run', runtimeDeferredWait: true, awaitedTestRunIds: ['tr-restart'],
  });

  await manager.resumeInterruptedTasks();

  for (const id of [task.id, stopped.id]) {
    const live = await manager.getTask(id);
    assert.equal(live.runtimeDeferredWait, false);
    assert.deepEqual(live.awaitedTestRunIds, []);
    assert.notEqual(live.runtimeWaitingReason, 'Waiting on a test run');
    assert.notEqual(live.runtimeStatus, 'waiting_input');
  }
  assert.equal((await notificationsOf()).filter((n) => n.kind === 'task.needs_input').length, 0);
  manager.dispose();
});

// ---- On-demand Catalog skills: an index in the prompt, full bodies only for "always load" (task 29.002) ----

const COMMIT_BODY = 'Write commit messages in the imperative mood.';
const LINT_BODY = 'Always run the linter before finishing a Task.';
const skillPath = (id: string) => path.join(process.env.AGENT_VISUAL_OS_CATALOG_DIR!, 'skills', id, 'SKILL.md');

async function builderPrompt(skillIds: string[] | undefined, preloadSkillIds?: string[]): Promise<string> {
  return workerManagerModule.buildAppendSystemPrompt((await catalogService.getAgent('builder'))!, skillIds, preloadSkillIds);
}

test('buildAppendSystemPrompt: no skills, or only an empty preload list, gives the persona alone', async () => {
  const persona = await catalogService.readAgentPersona((await catalogService.getAgent('builder'))!);
  assert.equal(await builderPrompt(undefined), persona);
  assert.equal(await builderPrompt([], []), persona);
});

test('buildAppendSystemPrompt: on-demand skills get an index with name, id, description and absolute path, and no body', async () => {
  const prompt = await builderPrompt(['lint-rules', 'commit-style']);
  assert.match(prompt, /## Available skills \(read on demand\)/);
  for (const rule of ['not installed in this project', 'check each description', 'Read that SKILL.md in full', 'Resolve any relative path', "Do not read skills whose description doesn't apply", 'list which skills you read']) {
    assert.ok(prompt.includes(rule), `instructions must carry: ${rule}`);
  }
  for (const id of ['lint-rules', 'commit-style']) {
    const skill = (await catalogService.getSkill(id))!;
    assert.ok(prompt.includes(`${skill.name} (\`${id}\`): ${skill.description}`));
    assert.ok(prompt.includes(`SKILL.md: ${skillPath(id)}`));
  }
  assert.ok(!prompt.includes(COMMIT_BODY) && !prompt.includes(LINT_BODY), 'no SKILL.md body is pasted in');
  assert.ok(!prompt.includes('## Skill:'));
  assert.ok(prompt.indexOf('`commit-style`') < prompt.indexOf('`lint-rules`'), 'index entries are in id order');
});

test('buildAppendSystemPrompt: always-load only reproduces the previous section exactly: header plus full body', async () => {
  const persona = await catalogService.readAgentPersona((await catalogService.getAgent('builder'))!);
  const skill = (await catalogService.getSkill('commit-style'))!;
  const dir = path.dirname(skillPath('commit-style'));
  const expected = `${persona}\n\n## Skill: ${skill.name} (\`commit-style\`)\n\nThis skill is already loaded: its full SKILL.md follows. It is supplied by the runner, not installed in this project, so do not look for it among installed skills or report it as missing. Its SKILL.md is at ${skillPath('commit-style')}; resolve any relative path it references, such as \`references/...\`, against ${dir}.\n\n${await catalogService.readSkillBody(skill)}`;
  assert.equal(await builderPrompt(['commit-style'], ['commit-style']), expected);
});

test('buildAppendSystemPrompt: a mix has both sections, each in id order whatever order the ids were stored in', async () => {
  const a = await builderPrompt(['lint-rules', 'commit-style'], ['lint-rules']);
  const b = await builderPrompt(['commit-style', 'lint-rules'], ['lint-rules', 'lint-rules']);
  assert.equal(a, b, 'stored order and duplicate preload ids do not change the output');
  assert.ok(a.includes(LINT_BODY) && !a.includes(COMMIT_BODY));
  assert.ok(a.indexOf('## Skill:') < a.indexOf('## Available skills'));
  assert.ok(a.includes(`SKILL.md: ${skillPath('commit-style')}`));
  assert.ok(!a.includes(`SKILL.md: ${skillPath('lint-rules')}`), 'an always-load skill is not repeated in the index');
  const both = await builderPrompt(['lint-rules', 'commit-style'], ['lint-rules', 'commit-style']);
  assert.ok(both.indexOf(COMMIT_BODY) < both.indexOf(LINT_BODY), 'always-load sections are in id order');
});

test('buildAppendSystemPrompt: a preload id outside skillIds is ignored', async () => {
  const prompt = await builderPrompt(['commit-style'], ['lint-rules']);
  assert.ok(!prompt.includes(LINT_BODY));
});

test('buildAppendSystemPrompt: a skill deleted after validation is skipped, and no empty index header remains', async () => {
  const persona = await catalogService.readAgentPersona((await catalogService.getAgent('builder'))!);
  assert.equal(await builderPrompt(['gone-skill']), persona);
  assert.equal(await builderPrompt(['gone-skill'], ['gone-skill']), persona);
  const prompt = await builderPrompt(['gone-skill', 'commit-style']);
  assert.ok(prompt.includes('`commit-style`') && !prompt.includes('gone-skill'));
});

test('buildAppendSystemPrompt: an empty description still gets an entry marked "(no description)"', async () => {
  await catalogService.createSkill({ id: 'blank-desc-skill', name: 'Blank Desc', description: 'temporary', body: 'x' });
  const file = skillPath('blank-desc-skill');
  await writeFile(file, '---\nname: blank-desc-skill\ndescription:\n---\nbody text\n');
  try {
    const prompt = await builderPrompt(['blank-desc-skill']);
    assert.ok(prompt.includes('Blank Desc (`blank-desc-skill`): (no description)'));
    assert.ok(prompt.includes(`SKILL.md: ${file}`));
  } finally {
    await catalogService.deleteSkill('blank-desc-skill');
  }
});

test('startTask: on-demand skills persist an index-only sessionSetup and always-load ones the full body; spawn gets skill read dirs', async () => {
  const project = await projectService.createProject({ name: 'On Demand Spawn', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  const task = await manager.startTask({ projectId: project.id, description: 'Work', templateId: 'builder', skillIds: ['lint-rules', 'commit-style'], preloadSkillIds: ['lint-rules'] });
  assert.deepEqual(task.preloadSkillIds, ['lint-rules']);
  const start = terminal.starts[0]!;
  assert.ok(start.systemPrompt.includes(LINT_BODY) && !start.systemPrompt.includes(COMMIT_BODY));
  assert.equal((await manager.getTask(task.id)).sessionSetup?.systemPrompt, start.systemPrompt);
  const catalog = process.env.AGENT_VISUAL_OS_CATALOG_DIR!;
  assert.deepEqual(start.readOnlyDirs, [path.join(catalog, 'skills', 'commit-style'), path.join(catalog, 'skills', 'lint-rules')], 'no workflow run: only the skill dirs, own skills only');
  start.onExit(0);
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
});

test('startTask without preloadSkillIds stores none; a resumed task keeps its stored prompt and still gets the skill read dirs', async () => {
  const project = await projectService.createProject({ name: 'On Demand Resume', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ terminalSessions: terminal.host });
  const first = await manager.startTask({ projectId: project.id, description: 'Plan', kind: 'plan', executorId: 'test-codex-cli', skillIds: ['lint-rules'] });
  assert.equal(first.preloadSkillIds, undefined);
  const stored = terminal.starts[0]!.systemPrompt;
  assert.ok(stored.includes('## Available skills') && !stored.includes(LINT_BODY));
  terminal.starts[0]!.onExit(0, undefined, 'on-demand-resume');
  await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
  await catalogService.updateSkill('lint-rules', { description: 'Changed description' });
  try {
    const resumed = await manager.resumeTerminalTask(first.id);
    assert.equal(terminal.starts[1]!.systemPrompt, stored);
    assert.deepEqual(terminal.starts[1]!.readOnlyDirs, [path.join(process.env.AGENT_VISUAL_OS_CATALOG_DIR!, 'skills', 'lint-rules')]);
    terminal.starts[1]!.onExit(0, undefined, 'on-demand-resume');
    await waitUntil(async () => (await manager.getTask(resumed.id)).status === 'stopped');
  } finally {
    await catalogService.updateSkill('lint-rules', { description: (await catalogService.getSkill('commit-style'))!.description });
  }
});

test('startTask rejects a preloadSkillIds that is not a subset of skillIds and persists no Task', async () => {
  const project = await projectService.createProject({ name: 'Bad Preload', position: null });
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
  await assert.rejects(
    () => manager.startTask({ projectId: project.id, description: 'x', skillIds: ['lint-rules'], preloadSkillIds: ['commit-style'] }),
    (error: Error) => error instanceof workerManagerModule.InvalidPreloadSkillsError && /"commit-style" is not an attached skill/.test(error.message),
  );
  await assert.rejects(() => manager.startTask({ projectId: project.id, description: 'x', preloadSkillIds: ['commit-style'] }), workerManagerModule.InvalidPreloadSkillsError);
  assert.deepEqual(await manager.listTasksForProject(project.id), []);
});

test('a workflow step Task copies the step\'s preloadSkillIds, and omits the field when the step has none', async () => {
  for (const [id, preload] of [['preload-flow', ['lint-rules']], ['plain-flow', undefined]] as const) {
    const project = await projectService.createProject({ name: `Step Preload ${id}`, position: null });
    await workflowService.createWorkflow({
      id, name: id, description: 'd',
      steps: [{ id: 'build', name: 'Build', agentId: 'builder', skillIds: ['lint-rules', 'commit-style'], ...(preload ? { preloadSkillIds: [...preload] } : {}), canEditCode: true, requiresApproval: false, instructions: 'Build.' }],
    });
    const terminal = fakeTerminalHost();
    const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeRunClaudeTurn([]).fn, terminalSessions: terminal.host });
    const item = await planItemService.createPlanItem({ projectId: project.id, title: id, description: '' });
    const task = await settledExecute(manager)(item.id, { workflowId: id, executorId: 'test-claude-cli' });
    assert.deepEqual(task.preloadSkillIds, preload ? [...preload] : undefined);
    const prompt = terminal.starts[0]!.systemPrompt;
    assert.equal(prompt.includes(LINT_BODY), Boolean(preload));
    assert.ok(!prompt.includes(COMMIT_BODY));
    assert.ok(terminal.starts[0]!.readOnlyDirs!.includes(path.join(process.env.AGENT_VISUAL_OS_CATALOG_DIR!, 'skills', 'commit-style')), 'step output dir plus skill dirs');
    assert.equal(terminal.starts[0]!.readOnlyDirs!.length, 3);
  }
});
