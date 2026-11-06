import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ClaudeTurnResult, RunClaudeTurnOptions } from '../src/worker/claudeProcess.ts';
import type { ExecutorLimits } from '../src/executors/executorLimits.ts';
import type { ExecutorProfile, PlanItemRecord, TaskRecord } from '../src/domain/types.ts';

let tempRoot: string;
let titler: typeof import('../src/projects/planItemTitler.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'plan-item-titler-test-'));
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  titler = await import('../src/projects/planItemTitler.ts');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const CLAUDE: ExecutorProfile = { id: 'claude', label: 'Claude', kind: 'claude-cli', bin: 'claude', env: {} };
const CODEX: ExecutorProfile = { id: 'codex', label: 'Codex', kind: 'codex-cli', bin: 'codex', env: {} };
const OTHER = { id: 'other', label: 'Other', kind: 'unsupported', bin: 'x', env: {} } as unknown as ExecutorProfile;

function limits(fiveHour: number | null, sevenDay: number | null = null): ExecutorLimits {
  const window = (used: number | null) => (used === null ? null : { usedPercentage: used, resetsAt: null });
  return { observedAt: 1, fiveHour: window(fiveHour), sevenDay: window(sevenDay) };
}

function item(overrides: Partial<PlanItemRecord> = {}): PlanItemRecord {
  return {
    id: 'item-1', projectId: 'p1', title: 'Fix the login bug', description: 'Fix the login bug\nUsers get logged out.', status: 'pending',
    order: 0, taskIds: [], milestoneId: null, createdAt: 'now', updatedAt: 'now', ...overrides,
  };
}

function titleResult(title: unknown, status: ClaudeTurnResult['status'] = 'done'): ClaudeTurnResult {
  return { sessionId: 's', status, message: 'named', extra: { title }, usage: null, raw: { type: 'result' } };
}

function fakeTurn(result: ClaudeTurnResult | Error) {
  const calls: RunClaudeTurnOptions[] = [];
  const fn = async (options: RunClaudeTurnOptions) => {
    calls.push(options);
    if (result instanceof Error) throw result;
    return result;
  };
  return { fn, calls };
}

/** A titler over an in-memory item, with one executor and scripted turns. */
function session(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { id: 'task-1', projectId: 'p1', description: 'Let us plan how notifications get delivered', kind: 'plan', ...overrides } as TaskRecord;
}

function setup(options: { stored?: PlanItemRecord | null; storedTask?: TaskRecord | null; claude?: ClaudeTurnResult | Error; codex?: ClaudeTurnResult | Error; executors?: ExecutorProfile[] } = {}) {
  let stored = options.stored === undefined ? item() : options.stored;
  let storedTask = options.storedTask === undefined ? session() : options.storedTask;
  const claude = fakeTurn(options.claude ?? titleResult('Fix login logout bug'));
  const codex = fakeTurn(options.codex ?? titleResult('Codex title'));
  const instance = titler.createPlanItemTitler({
    runClaudeTurn: claude.fn,
    runCodexTurn: codex.fn,
    listExecutors: async () => options.executors ?? [CLAUDE],
    getExecutorLimits: async () => null,
    getPlanItem: async () => {
      if (!stored) throw new Error('gone');
      return stored;
    },
    updatePlanItem: async (_id, patch) => (stored = { ...stored!, ...patch }),
    getTask: async () => storedTask ?? undefined,
    updateTask: async (_id, patch) => (storedTask ? (storedTask = { ...storedTask, ...patch }) : undefined),
  });
  const events: unknown[] = [];
  instance.onEvent((event) => events.push(event));
  return { instance, claude, codex, events, current: () => stored, currentTask: () => storedTask };
}

test('provisionalTitle uses the first line and cuts long ones with an ellipsis', () => {
  assert.equal(titler.provisionalTitle('  Fix the bug  \nmore detail'), 'Fix the bug');
  const long = titler.provisionalTitle('x'.repeat(200));
  assert.equal(long.length, titler.TITLE_MAX_LENGTH);
  assert.ok(long.endsWith('…'));
  assert.equal(titler.provisionalTitle(''), '');
});

test('cleanGeneratedTitle strips quotes, trailing periods and extra lines, and rejects non-strings', () => {
  assert.equal(titler.cleanGeneratedTitle('"Add retry to webhooks."\nsecond line'), 'Add retry to webhooks');
  assert.equal(titler.cleanGeneratedTitle('y'.repeat(120)).length, titler.TITLE_MAX_LENGTH);
  assert.equal(titler.cleanGeneratedTitle(42), '');
  assert.equal(titler.cleanGeneratedTitle(undefined), '');
});

test('selectLeastUsedExecutor picks the lowest 5-hour usage, breaks ties on 7-day usage, and skips unsupported kinds', async () => {
  const usage: Record<string, ExecutorLimits | null> = { claude: limits(30, 50), codex: limits(30, 10), other: null };
  const instance = titler.createPlanItemTitler({ listExecutors: async () => [OTHER, CLAUDE, CODEX], getExecutorLimits: async (e) => usage[e.id] ?? null });
  assert.equal((await instance.selectLeastUsedExecutor())?.id, 'codex');

  usage.claude = limits(5, 90);
  assert.equal((await instance.selectLeastUsedExecutor())?.id, 'claude');
});

test('selectLeastUsedExecutor treats a missing reading as unused and skips exhausted executors', async () => {
  const exhausted = titler.createPlanItemTitler({ listExecutors: async () => [CLAUDE, CODEX], getExecutorLimits: async (e) => (e.id === 'claude' ? limits(100) : limits(10, 100)) });
  assert.equal(await exhausted.selectLeastUsedExecutor(), null);

  const unknown = titler.createPlanItemTitler({ listExecutors: async () => [CLAUDE, CODEX], getExecutorLimits: async (e) => (e.id === 'claude' ? limits(20) : null) });
  assert.equal((await unknown.selectLeastUsedExecutor())?.id, 'codex');
});

test('titlePlanItem runs a tool-less JSON turn on the description and saves the generated title', async () => {
  const { instance, claude, events, current } = setup();
  const updated = await instance.titlePlanItem(item());

  assert.equal(updated?.title, 'Fix login logout bug');
  assert.equal(current()?.title, 'Fix login logout bug');
  assert.deepEqual(events, [{ type: 'planItem', planItem: updated }]);
  const call = claude.calls[0]!;
  assert.equal(call.prompt, item().description);
  assert.equal(call.permissionMode, 'default');
  assert.deepEqual(call.jsonSchema, titler.TITLE_SCHEMA);
  assert.ok(call.disallowedTools?.includes('Bash'));
  assert.ok(call.disallowedTools?.includes('Write'));
});

test('titlePlanItem uses the codex runner for a codex executor', async () => {
  const { instance, claude, codex } = setup({ executors: [CODEX] });
  const updated = await instance.titlePlanItem(item());
  assert.equal(updated?.title, 'Codex title');
  assert.equal(codex.calls[0]?.bin, 'codex');
  assert.equal(claude.calls.length, 0);
});

test('titlePlanItem keeps a title the user changed while the turn was running', async () => {
  const { instance, events, current } = setup({ stored: item({ title: 'Renamed by hand' }) });
  assert.equal(await instance.titlePlanItem(item()), null);
  assert.equal(current()?.title, 'Renamed by hand');
  assert.deepEqual(events, []);
});

test('titlePlanItem leaves the placeholder when the turn fails, errors, or returns no title', async () => {
  for (const claude of [titleResult('', 'done'), titleResult('Ignored', 'error'), new Error('spawn failed')]) {
    const { instance, events, current } = setup({ claude });
    assert.equal(await instance.titlePlanItem(item()), null);
    assert.equal(current()?.title, 'Fix the login bug');
    assert.deepEqual(events, []);
  }
});

test('titlePlanItem does nothing without an available executor or once the item is deleted', async () => {
  const noExecutor = setup({ executors: [] });
  assert.equal(await noExecutor.instance.titlePlanItem(item()), null);
  assert.equal(noExecutor.claude.calls.length, 0);

  const deleted = setup({ stored: null });
  assert.equal(await deleted.instance.titlePlanItem(item()), null);
  assert.deepEqual(deleted.events, []);
});

test('requestTitle titles the item in the background and onEvent can unsubscribe', async () => {
  const { instance, current } = setup();
  const seen: unknown[] = [];
  const unsubscribe = instance.onEvent((event) => seen.push(event));
  const done = new Promise<void>((resolve) => instance.onEvent(() => resolve()));
  instance.requestTitle(item());
  await done;
  assert.equal(current()?.title, 'Fix login logout bug');
  assert.equal(seen.length, 1);
  unsubscribe();
});

test('titleSession names a planning session in 5-6 words from its opening prompt and saves it on the Task', async () => {
  const { instance, claude, events, currentTask } = setup({ claude: titleResult('"Plan notification delivery backend."') });
  const updated = await instance.titleSession(session());

  assert.equal(updated?.title, 'Plan notification delivery backend');
  assert.equal(currentTask()?.title, 'Plan notification delivery backend');
  assert.deepEqual(events, [{ type: 'task', task: updated }]);
  const call = claude.calls[0]!;
  assert.equal(call.prompt, session().description);
  assert.match(call.appendSystemPrompt ?? '', /planning conversations[\s\S]*5 or 6 words/);
  assert.deepEqual(call.jsonSchema, titler.TITLE_SCHEMA);
  assert.ok(call.disallowedTools?.includes('Bash'));
});

test('titleSession leaves the session untitled when the turn fails, there is no executor, or the Task was deleted', async () => {
  for (const claude of [titleResult(''), titleResult('Ignored', 'error'), new Error('spawn failed')]) {
    const { instance, events, currentTask } = setup({ claude });
    assert.equal(await instance.titleSession(session()), null);
    assert.equal(currentTask()?.title, undefined);
    assert.deepEqual(events, []);
  }

  const noExecutor = setup({ executors: [] });
  assert.equal(await noExecutor.instance.titleSession(session()), null);
  assert.equal(noExecutor.claude.calls.length, 0);

  const deleted = setup({ storedTask: null });
  assert.equal(await deleted.instance.titleSession(session()), null);
  assert.deepEqual(deleted.events, []);
});

test('titleSession keeps a title the user set while the turn was running', async () => {
  const { instance, events, currentTask } = setup({ storedTask: session({ title: 'Renamed by hand' }) });
  assert.equal(await instance.titleSession(session()), null);
  assert.equal(currentTask()?.title, 'Renamed by hand');
  assert.deepEqual(events, []);
});

test('requestSessionTitle titles the session in the background', async () => {
  const { instance, currentTask } = setup();
  const done = new Promise<void>((resolve) => instance.onEvent(() => resolve()));
  instance.requestSessionTitle(session());
  await done;
  assert.equal(currentTask()?.title, 'Fix login logout bug');
});
