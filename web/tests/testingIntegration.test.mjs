import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { serverApi } = await import('../src/lib/serverApi.ts');
const { installServerStub } = await import('./serverStub.mjs');

/**
 * A cross-feature smoke test for task 2.006: create a project with no testing config, start its
 * setup, approve the proposal, see the config become valid, run a suite, and see it land in history
 * — all through `serverApi` against the extended `serverStub.mjs`, the same client code the Testing
 * tab itself calls. Catches route-shape drift between `serverApi.ts` and the stub that a narrower
 * per-file mock (like testingSetup.test.mjs's inline `mockFetch`) wouldn't.
 */
test('testing tab end-to-end: no config -> start setup -> approve -> valid config -> run a suite -> history', async () => {
  installServerStub();

  const project = await serverApi.createProject('Testing Smoke', null);

  const absent = await serverApi.getTestingOverview(project.id);
  assert.deepEqual(absent.config, { state: 'absent', path: '.docs/testing/config.json' });
  assert.deepEqual(absent.suites, []);

  const started = await serverApi.startTestingSetup(project.id);
  assert.equal(started.existing, false);
  assert.equal(started.run.status, 'awaiting-approval');
  assert.equal(started.run.testingSetup.mode, 'setup');

  // Starting again while one is already active returns the same one instead of a second.
  const startedAgain = await serverApi.startTestingSetup(project.id);
  assert.equal(startedAgain.existing, true);
  assert.equal(startedAgain.run.id, started.run.id);

  const setupBeforeApproval = await serverApi.getTestingSetup(project.id);
  assert.equal(setupBeforeApproval.active, true);
  assert.equal(setupBeforeApproval.run.status, 'awaiting-approval');

  const approved = await serverApi.approveTestingSetup(started.run.id, 1);
  assert.equal(approved.status, 'completed');
  assert.equal(approved.testingSetup.evidence.config.state, 'valid');

  const afterApproval = await serverApi.getTestingOverview(project.id);
  assert.equal(afterApproval.config.state, 'valid');
  assert.equal(afterApproval.suites.length, 1);
  assert.equal(afterApproval.suites[0].id, 'unit');
  assert.equal(afterApproval.suites[0].latestResult, null, 'valid, but nothing has run yet');

  const run = await serverApi.runTestAction(project.id, 'unit', 'run');
  assert.equal(run.status, 'running');

  // A second run of the same action while the first is still active is refused, not silently duplicated.
  await assert.rejects(serverApi.runTestAction(project.id, 'unit', 'run'), /already queued or running/);

  const duringRun = await serverApi.getTestingOverview(project.id);
  assert.equal(duringRun.queue.length, 1);
  assert.equal(duringRun.queue[0].id, run.id);

  const detail = await serverApi.getTestRun(run.id);
  assert.equal(detail.suite.label, 'Unit tests');
  assert.equal(detail.output, '');

  const page = await serverApi.listTestRuns(project.id, 10);
  assert.equal(page.total, 1);
  assert.equal(page.runs[0].id, run.id);
});

test('removing a queued run is refused once it starts running; stopping a non-running run is refused', async () => {
  const stub = installServerStub();
  const project = await serverApi.createProject('Queue Smoke', null);
  stub.testingConfigs.set(project.id, {
    state: 'valid',
    path: '.docs/testing/config.json',
    config: { schemaVersion: 1, suites: [{ id: 'unit', label: 'Unit', kind: 'unit', enabled: true, primaryActionId: 'run', actions: [{ id: 'run', label: 'Run', purpose: 'result', command: 'npm test', workingDirectory: '.', enabled: true, collectors: [] }], metrics: [] }] },
  });

  const run = await serverApi.runTestAction(project.id, 'unit', 'run');
  await assert.rejects(serverApi.removeQueuedTestRun(run.id), /not queued/);

  const stopped = await serverApi.stopTestRun(run.id);
  assert.equal(stopped.status, 'stopped');
  await assert.rejects(serverApi.stopTestRun(run.id), /not running/);
});

test('running all enabled suites queues one run per primary action, skipping a suite already active', async () => {
  const stub = installServerStub();
  const project = await serverApi.createProject('Run All Smoke', null);
  stub.testingConfigs.set(project.id, {
    state: 'valid',
    path: '.docs/testing/config.json',
    config: {
      schemaVersion: 1,
      suites: [
        { id: 'unit', label: 'Unit', kind: 'unit', enabled: true, primaryActionId: 'run', actions: [{ id: 'run', label: 'Run', purpose: 'result', command: 'npm test', workingDirectory: '.', enabled: true, collectors: [] }], metrics: [] },
        { id: 'e2e', label: 'E2E', kind: 'e2e', enabled: true, primaryActionId: 'run', actions: [{ id: 'run', label: 'Run', purpose: 'result', command: 'npx playwright test', workingDirectory: '.', enabled: true, collectors: [] }], metrics: [] },
        { id: 'contract', label: 'Contract', kind: 'contract', enabled: false, primaryActionId: 'run', actions: [{ id: 'run', label: 'Run', purpose: 'result', command: 'echo', workingDirectory: '.', enabled: true, collectors: [] }], metrics: [] },
      ],
    },
  });
  await serverApi.runTestAction(project.id, 'unit', 'run');

  const { runs } = await serverApi.runAllTests(project.id);
  assert.deepEqual(runs.map((r) => r.suite.id), ['e2e'], 'unit was already active, contract is disabled — only e2e gets queued');
});
