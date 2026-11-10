import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { StepRunOutput } from '../src/domain/types.ts';
import { MIN_HTML_OUTPUT_LENGTH, StepOutputRequiredError, assertRequiredOutputs, htmlOutputProblem } from '../src/worker/requiredOutputs.ts';
import { settledExecute } from './helpers/startRun.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';

/** B.036: a step with `requiredOutputFormat: 'html'` refuses `complete_step` until it carries a real HTML mockup. */

const MOCKUP = `<!doctype html><html><head><style>body{font:14px sans-serif}</style></head><body><h1>Settings</h1><p>${'A real screen. '.repeat(8)}</p></body></html>`;
const html = (content: string, name = 'Screen'): StepRunOutput => ({ name, format: 'html', content });
const NUDGE = 'UI mockup missing';

describe('htmlOutputProblem', () => {
  test('accepts a full document, whatever the tag case or surrounding whitespace', () => {
    assert.equal(htmlOutputProblem(html(MOCKUP)), null);
    assert.equal(htmlOutputProblem(html(`  \n${MOCKUP.replace('<!doctype html>', '<!DOCTYPE HTML>')}\n `)), null);
    assert.equal(htmlOutputProblem(html(`<HTML>${'x'.repeat(MIN_HTML_OUTPUT_LENGTH)}</HTML>`)), null);
    assert.equal(htmlOutputProblem(html(`<body class="a">${'x'.repeat(MIN_HTML_OUTPUT_LENGTH)}</body>`)), null);
  });

  test('rejects a non-html format', () => {
    assert.match(htmlOutputProblem({ name: 'Notes', format: 'markdown', content: MOCKUP })!, /wrong format "markdown"/);
  });

  test('rejects empty, placeholder and tag-less content', () => {
    assert.equal(htmlOutputProblem(html('   ')), 'empty content');
    for (const token of ['PLACEHOLDER', 'todo', 'TBD', '...', '…']) assert.equal(htmlOutputProblem(html(` ${token} `)), 'placeholder content', token);
    assert.match(htmlOutputProblem(html('A plain-text spec of the timeline. '.repeat(10)))!, /no HTML document tag/);
    assert.equal(htmlOutputProblem(html('<html><body>PLACEHOLDER</body></html>'.padEnd(150, ' '))), 'placeholder content');
  });

  test('the minimum length is inclusive', () => {
    const prefix = '<html>';
    assert.equal(htmlOutputProblem(html(prefix + 'x'.repeat(MIN_HTML_OUTPUT_LENGTH - prefix.length))), null);
    assert.match(htmlOutputProblem(html(prefix + 'x'.repeat(MIN_HTML_OUTPUT_LENGTH - prefix.length - 1)))!, /too short/);
  });
});

describe('assertRequiredOutputs', () => {
  const required = { requiredOutputFormat: 'html' as const } as Parameters<typeof assertRequiredOutputs>[0];
  const optional = {} as Parameters<typeof assertRequiredOutputs>[0];

  test('a step without the field accepts anything', () => {
    assert.doesNotThrow(() => assertRequiredOutputs(optional, undefined));
    assert.doesNotThrow(() => assertRequiredOutputs({ requiredOutputFormat: null } as typeof optional, []));
  });

  test('passes with one valid html output, even beside markdown or rejected ones', () => {
    assert.doesNotThrow(() => assertRequiredOutputs(required, [{ name: 'Notes', format: 'markdown', content: 'x' }, html('PLACEHOLDER', 'Other'), html(MOCKUP)]));
  });

  test('a refusal without outputs tells the agent how to send one and lists nothing as rejected', () => {
    assert.throws(() => assertRequiredOutputs(required, undefined), (error: Error) => {
      assert.ok(error instanceof StepOutputRequiredError);
      assert.ok(error.message.startsWith(NUDGE));
      assert.match(error.message, /format: "html"/);
      assert.match(error.message, /skip_step/);
      assert.doesNotMatch(error.message, /Rejected outputs/);
      return true;
    });
  });

  test('a refusal names each rejected output and its reason', () => {
    assert.throws(() => assertRequiredOutputs(required, [{ name: 'Notes', format: 'markdown', content: 'x' }, html('PLACEHOLDER', 'Home')]), (error: Error) => {
      assert.match(error.message, /- "Notes": wrong format "markdown"/);
      assert.match(error.message, /- "Home": placeholder content/);
      return true;
    });
  });
});

describe('completeStep on a step that requires an HTML mockup', () => {
  let tempRoot: string;
  let projectService: typeof import('../src/projects/projectService.ts');
  let planItemService: typeof import('../src/projects/planItemService.ts');
  let workerManagerModule: typeof import('../src/worker/workerManager.ts');
  let notificationService: typeof import('../src/notifications/notificationService.ts');

  before(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'required-outputs-test-'));
    process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
    process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
    process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
    process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
    await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
    projectService = await import('../src/projects/projectService.ts');
    planItemService = await import('../src/projects/planItemService.ts');
    workerManagerModule = await import('../src/worker/workerManager.ts');
    notificationService = await import('../src/notifications/notificationService.ts');
    const workflowService = await import('../src/catalog/workflowService.ts');
    await workflowService.updateWorkflow('software-development', {
      name: 'Required outputs',
      description: 'A UI step that requires a mockup, then a step that does not.',
      steps: [
        { id: 'ui', name: 'UI Planning', agentId: 'builder', canEditCode: false, requiresApproval: true, requiredOutputFormat: 'html', instructions: 'Plan the UI.' },
        { id: 'build', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Implement it.' },
      ],
    });
  });

  after(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** A run parked on its `ui` step's live session (the fake host never ends it on its own). */
  async function startAtUiStep(name: string) {
    const project = await projectService.createProject({ name, position: null });
    const item = await planItemService.createPlanItem({ projectId: project.id, title: 'A UI task', description: 'Change a screen.' });
    const fake = fakeTerminalHost();
    const manager = workerManagerModule.createWorkerManager({ terminalSessions: fake.host });
    const task = await settledExecute(manager)(item.id);
    return { manager, project, taskId: task.id, runId: task.workflowRunId!, stops: fake.stops, starts: fake.starts };
  }

  const refusedInputs: [string, StepRunOutput[] | undefined][] = [
    ['no outputs', undefined],
    ['outputs: []', []],
    ['only markdown outputs', [{ name: 'Spec', format: 'markdown', content: MOCKUP }]],
    ['html "PLACEHOLDER"', [html('PLACEHOLDER')]],
    ['empty html', [html('')]],
    ['plain-text html with no tag', [html('The timeline shows each step as a row with a status pill. '.repeat(4))]],
  ];

  for (const [label, outputs] of refusedInputs) {
    test(`refuses ${label} and leaves the round running`, async () => {
      const { manager, project, taskId, runId, stops } = await startAtUiStep(`Refuse ${label}`);
      const before = await manager.getWorkflowRunDetail(runId);

      await assert.rejects(manager.completeStep(taskId, { summary: 'Planned the UI.', outputs }), (error: Error) => {
        assert.ok(error instanceof StepOutputRequiredError);
        assert.ok(error.message.includes(NUDGE));
        return true;
      });

      const detail = await manager.getWorkflowRunDetail(runId);
      const round = detail.steps.find((s) => s.step.id === 'ui')!.rounds.at(-1)!;
      assert.equal(round.status, 'running');
      assert.equal(round.completedAt ?? null, null);
      assert.deepEqual(round.outputs, []);
      assert.equal(detail.run.status, before.run.status);
      assert.equal(detail.run.currentStepId, 'ui');
      assert.deepEqual(stops, [], 'the live session is not ended');
      assert.deepEqual(await notificationService.listNotifications({ projectId: project.id, resolved: false }), []);
    });
  }

  test('the agent retries in the same session and the valid round goes to approval', async () => {
    const { manager, taskId, runId, stops } = await startAtUiStep('Retry');
    await assert.rejects(manager.completeStep(taskId, { summary: 'Planned.', outputs: [] }), StepOutputRequiredError);

    const outputs = [html(MOCKUP, 'Settings'), { name: 'Notes', format: 'markdown' as const, content: 'Design notes.' }];
    const done = await manager.completeStep(taskId, { summary: 'Planned with a mockup.', outputs });
    assert.equal(done.status, 'done');
    assert.deepEqual(done.outputs, outputs);
    assert.deepEqual(stops, [taskId]);
    const detail = await manager.getWorkflowRunDetail(runId);
    assert.equal(detail.run.status, 'awaiting-approval');
    assert.equal(detail.run.currentStepId, 'ui');
  });

  test('skip_step still skips a step that requires a mockup', async () => {
    const { manager, taskId, runId } = await startAtUiStep('Skip');
    const skipped = await manager.skipStep(taskId, { reason: 'No UI in this task.' });
    assert.equal(skipped.status, 'skipped');
    assert.notEqual((await manager.getWorkflowRunDetail(runId)).run.currentStepId, 'ui');
  });

  test('a step without the field still completes with no outputs', async () => {
    const { manager, taskId, runId, starts } = await startAtUiStep('Optional');
    await manager.completeStep(taskId, { summary: 'Planned.', outputs: [html(MOCKUP)] });
    await manager.approveWorkflowRun(runId);
    const buildTask = starts.at(-1)!.taskId;
    assert.notEqual(buildTask, taskId);
    const done = await manager.completeStep(buildTask, { summary: 'Built it.' });
    assert.equal(done.status, 'done');
    assert.deepEqual(done.outputs, []);
  });
});
