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

const { reconnectDelayMs } = await import('../src/lib/serverApi.ts');

test('reconnectDelayMs doubles each attempt starting at 1s', () => {
  assert.equal(reconnectDelayMs(0), 1000);
  assert.equal(reconnectDelayMs(1), 2000);
  assert.equal(reconnectDelayMs(2), 4000);
  assert.equal(reconnectDelayMs(3), 8000);
});

test('reconnectDelayMs caps at 15s and never exceeds it for a long-disconnected client', () => {
  assert.equal(reconnectDelayMs(4), 15000);
  assert.equal(reconnectDelayMs(10), 15000);
  assert.equal(reconnectDelayMs(100), 15000);
});

/** Mocks `fetch` for one `run()` call, recording each request's URL/method/parsed-JSON-body and returning `responseBody` at `status`. */
async function withMockFetch(responseBody, status, run) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(responseBody === undefined ? null : JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---- Catalog: Workflows (task 3.012) ----

test('listCatalogWorkflows GETs /api/catalog/workflows', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const workflows = [{ id: 'w1' }];
  const { result, calls } = await withMockFetch(workflows, 200, () => serverApi.listCatalogWorkflows());
  assert.deepEqual(result, workflows);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/api\/catalog\/workflows$/);
});

test('getCatalogWorkflow GETs /api/catalog/workflows/:id', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const workflow = { id: 'w1' };
  const { result, calls } = await withMockFetch(workflow, 200, () => serverApi.getCatalogWorkflow('w1'));
  assert.deepEqual(result, workflow);
  assert.match(calls[0].url, /\/api\/catalog\/workflows\/w1$/);
});

test('createCatalogWorkflow POSTs the input to /api/catalog/workflows', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const input = { id: 'w1', name: 'W1', description: 'x', steps: [] };
  const created = { ...input, enabled: true };
  const { result, calls } = await withMockFetch(created, 201, () => serverApi.createCatalogWorkflow(input));
  assert.deepEqual(result, created);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, input);
  assert.match(calls[0].url, /\/api\/catalog\/workflows$/);
});

test('updateCatalogWorkflow PUTs the patch to /api/catalog/workflows/:id', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const patch = { name: 'W1 v2' };
  const updated = { id: 'w1', name: 'W1 v2' };
  const { result, calls } = await withMockFetch(updated, 200, () => serverApi.updateCatalogWorkflow('w1', patch));
  assert.deepEqual(result, updated);
  assert.equal(calls[0].method, 'PUT');
  assert.deepEqual(calls[0].body, patch);
  assert.match(calls[0].url, /\/api\/catalog\/workflows\/w1$/);
});

test('deleteCatalogWorkflow DELETEs /api/catalog/workflows/:id', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const { result, calls } = await withMockFetch(undefined, 204, () => serverApi.deleteCatalogWorkflow('w1'));
  assert.equal(result, undefined);
  assert.equal(calls[0].method, 'DELETE');
  assert.match(calls[0].url, /\/api\/catalog\/workflows\/w1$/);
});

// ---- Project workflow selection + Workflow runs (task 3.012) ----

test('step reopen options, exact mode and pending-change decision use their daemon routes', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const options = await withMockFetch({ choiceRequired: true, permissionsAvailable: true }, 200, () => serverApi.stepReopenOptions('step-1'));
  assert.deepEqual(options.result, { choiceRequired: true, permissionsAvailable: true });
  assert.match(options.calls[0].url, /\/api\/tasks\/step-1\/reopen-session\/options$/);
  const opened = await withMockFetch({ location: 'recreated-worktree', mode: 'permissions' }, 201, () => serverApi.reopenStepSession('step-1', 'permissions'));
  assert.deepEqual(opened.calls[0].body, { mode: 'permissions' });
  assert.match(opened.calls[0].url, /\/api\/tasks\/step-1\/reopen-session$/);
  const safe = await withMockFetch({ location: 'project', mode: 'read-only' }, 201, () => serverApi.reopenStepSession('step-1', 'read-only'));
  assert.deepEqual(safe.calls[0].body, { mode: 'read-only' });
  const resolved = await withMockFetch({ id: 'run-1', pendingInspectChanges: null }, 200, () => serverApi.resolveStepInspectChanges('run-1', 'discard'));
  assert.deepEqual(resolved.calls[0].body, { decision: 'discard' });
  assert.match(resolved.calls[0].url, /\/api\/workflow-runs\/run-1\/reopen-changes$/);
});

test('setProjectWorkflow PATCHes {workflowId} to /api/projects/:id/workflow', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const project = { id: 'p1', workflowId: 'w1' };
  const { result, calls } = await withMockFetch(project, 200, () => serverApi.setProjectWorkflow('p1', 'w1'));
  assert.deepEqual(result, project);
  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, { workflowId: 'w1' });
  assert.match(calls[0].url, /\/api\/projects\/p1\/workflow$/);
});

test('setProjectAutoPull PATCHes {autoPullEnabled} to /api/projects/:id/auto-pull', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const project = { id: 'p1', autoPullEnabled: false };
  const { result, calls } = await withMockFetch(project, 200, () => serverApi.setProjectAutoPull('p1', false));
  assert.deepEqual(result, project);
  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, { autoPullEnabled: false });
  assert.match(calls[0].url, /\/api\/projects\/p1\/auto-pull$/);
});

test('setProjectGitProvider PATCHes {gitProvider} to /api/projects/:id/git-provider', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const project = { id: 'p1', gitProvider: 'github' };
  const { result, calls } = await withMockFetch(project, 200, () => serverApi.setProjectGitProvider('p1', 'github'));
  assert.deepEqual(result, project);
  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, { gitProvider: 'github' });
  assert.match(calls[0].url, /\/api\/projects\/p1\/git-provider$/);
});

test('openPullRequests GETs /api/projects/:id/open-pull-requests and returns the list, keeping zero distinct from unavailable', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const zero = { count: 0, pullRequests: [], truncated: false, checkedAt: 'now' };
  const { result, calls } = await withMockFetch(zero, 200, () => serverApi.openPullRequests('p1'));
  assert.deepEqual(result, zero);
  assert.match(calls[0].url, /\/api\/projects\/p1\/open-pull-requests$/);
  const unavailable = { count: null, pullRequests: [], truncated: false, checkedAt: 'now', error: 'Could not reach GitHub.' };
  assert.deepEqual((await withMockFetch(unavailable, 200, () => serverApi.openPullRequests('p1'))).result, unavailable);
});

test('listWorkflowRunsForProject GETs /api/projects/:id/workflow-runs', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const runs = [{ id: 'run-1' }];
  const { result, calls } = await withMockFetch(runs, 200, () => serverApi.listWorkflowRunsForProject('p1'));
  assert.deepEqual(result, runs);
  assert.match(calls[0].url, /\/api\/projects\/p1\/workflow-runs$/);
});

test('getWorkflowRunDetail GETs /api/workflow-runs/:id', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const detail = { run: { id: 'run-1' }, steps: [] };
  const { result, calls } = await withMockFetch(detail, 200, () => serverApi.getWorkflowRunDetail('run-1'));
  assert.deepEqual(result, detail);
  assert.match(calls[0].url, /\/api\/workflow-runs\/run-1$/);
});

test('approveWorkflowRun POSTs {comment} to /api/workflow-runs/:id/approve', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const run = { id: 'run-1', status: 'running' };
  const { result, calls } = await withMockFetch(run, 200, () => serverApi.approveWorkflowRun('run-1', 'looks good'));
  assert.deepEqual(result, run);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { comment: 'looks good' });
  assert.match(calls[0].url, /\/api\/workflow-runs\/run-1\/approve$/);
});

test('requestChangesWorkflowRun POSTs {comment} to /api/workflow-runs/:id/request-changes', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const run = { id: 'run-1', status: 'running' };
  const { result, calls } = await withMockFetch(run, 200, () => serverApi.requestChangesWorkflowRun('run-1', 'fix it'));
  assert.deepEqual(result, run);
  assert.deepEqual(calls[0].body, { comment: 'fix it' });
  assert.match(calls[0].url, /\/api\/workflow-runs\/run-1\/request-changes$/);
});

test('decideWorkflowRunLoop POSTs {action, comment} to /api/workflow-runs/:id/loop', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const run = { id: 'run-1', status: 'running' };
  const { result, calls } = await withMockFetch(run, 200, () => serverApi.decideWorkflowRunLoop('run-1', 'another-round', 'go again'));
  assert.deepEqual(result, run);
  assert.deepEqual(calls[0].body, { action: 'another-round', comment: 'go again' });
  assert.match(calls[0].url, /\/api\/workflow-runs\/run-1\/loop$/);
});

test('retryWorkflowStep POSTs with no body to /api/workflow-runs/:id/retry-step', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const run = { id: 'run-1', status: 'running' };
  const { result, calls } = await withMockFetch(run, 200, () => serverApi.retryWorkflowStep('run-1'));
  assert.deepEqual(result, run);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, undefined);
  assert.match(calls[0].url, /\/api\/workflow-runs\/run-1\/retry-step$/);
});

test('resumeWorkflowRun POSTs with no body to /api/workflow-runs/:id/resume', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const run = { id: 'run-1', status: 'running' };
  const { result, calls } = await withMockFetch(run, 200, () => serverApi.resumeWorkflowRun('run-1'));
  assert.deepEqual(result, run);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, undefined);
  assert.match(calls[0].url, /\/api\/workflow-runs\/run-1\/resume$/);
});

test('resumeWorkflowRun rejects with the daemon\'s message on a 409', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  await assert.rejects(withMockFetch({ error: 'run cannot be resumed while running' }, 409, () => serverApi.resumeWorkflowRun('run-1')), /cannot be resumed/);
});

test('updatePlanItem sends {archived:true} to archive an item', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const { calls } = await withMockFetch({ id: 'i1', archived: true }, 200, () => serverApi.updatePlanItem('i1', { archived: true }));
  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, { archived: true });
  assert.match(calls[0].url, /\/api\/plan-items\/i1$/);
});

test('stopWorkflowRun POSTs with no body to /api/workflow-runs/:id/stop', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const run = { id: 'run-1', status: 'stopped' };
  const { result, calls } = await withMockFetch(run, 200, () => serverApi.stopWorkflowRun('run-1'));
  assert.deepEqual(result, run);
  assert.match(calls[0].url, /\/api\/workflow-runs\/run-1\/stop$/);
});

// ---- Code tab: creating files and folders ----

test('listProjectCodeTree GETs the project code tree with its files and folders', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const listing = { files: ['scripts/run.sh'], folders: ['empty', 'scripts'] };
  const { result, calls } = await withMockFetch(listing, 200, () => serverApi.listProjectCodeTree('p1'));
  assert.deepEqual(result, listing);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/api\/projects\/p1\/code\/tree$/);
});

test('createCodeEntry POSTs { path, type } to /api/projects/:id/code/entries and returns the created entry', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const created = { path: 'web/src/helpers.ts', type: 'file' };
  const { result, calls } = await withMockFetch(created, 201, () => serverApi.createCodeEntry('p1', 'web/src/helpers.ts', 'file'));
  assert.deepEqual(result, created);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { path: 'web/src/helpers.ts', type: 'file' });
  assert.match(calls[0].url, /\/api\/projects\/p1\/code\/entries$/);
});

test('createCodeEntry rejects with the server\'s error message so the form can show it inline', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  await assert.rejects(
    withMockFetch({ error: '"package.json" already exists' }, 409, () => serverApi.createCodeEntry('p1', 'package.json', 'file')),
    { message: '"package.json" already exists' },
  );
});

// ---- Starting a task ----

test('executePlanItem POSTs the start options, skippedStepIds included when steps are left out', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const { calls } = await withMockFetch({ id: 't1' }, 201, () => serverApi.executePlanItem('i1', { executorId: 'e1', createBranch: true, skippedStepIds: ['ui'] }));
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/api\/plan-items\/i1\/execute$/);
  assert.deepEqual(calls[0].body, { executorId: 'e1', createBranch: true, skippedStepIds: ['ui'] });
});

test('executePlanItem sends no skippedStepIds when every step runs', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const { calls } = await withMockFetch({ id: 't1' }, 201, () => serverApi.executePlanItem('i1', { executorId: 'e1', createBranch: false }));
  assert.deepEqual(calls[0].body, { executorId: 'e1', createBranch: false });
});

// ---- Quick look (task 5.008) ----

test('the Quick look client functions hit the run\'s quick-look URLs and encode the path', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const { calls } = await withMockFetch({}, 200, async () => {
    await serverApi.getQuickLookLocation('run-1');
    await serverApi.listQuickLookCodeTree('run-1');
    await serverApi.getQuickLookCodeFile('run-1', 'src/a b.ts');
    await serverApi.getQuickLookDocsTree('run-1');
    await serverApi.getQuickLookDocsFile('run-1', '../x.md');
    await serverApi.getQuickLookDiff('run-1');
    await serverApi.getQuickLookDiffFile('run-1', 'a&b.ts');
  });
  assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname + new URL(call.url).search]), [
    ['GET', '/api/workflow-runs/run-1/quick-look'],
    ['GET', '/api/workflow-runs/run-1/quick-look/code/tree'],
    ['GET', '/api/workflow-runs/run-1/quick-look/code/file?path=src%2Fa%20b.ts'],
    ['GET', '/api/workflow-runs/run-1/quick-look/docs/tree'],
    ['GET', '/api/workflow-runs/run-1/quick-look/docs/file?path=..%2Fx.md'],
    ['GET', '/api/workflow-runs/run-1/quick-look/diff'],
    ['GET', '/api/workflow-runs/run-1/quick-look/diff/file?path=a%26b.ts'],
  ]);
});

test('runCommand and runAdHocCommand send workflowRunId only when given', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const { calls } = await withMockFetch({ id: 'r' }, 201, async () => {
    await serverApi.runCommand('cmd-1');
    await serverApi.runCommand('cmd-1', 'run-9');
    await serverApi.runAdHocCommand('p1', 'npm test');
    await serverApi.runAdHocCommand('p1', 'npm test', 'run-9');
  });
  assert.deepEqual(calls.map((call) => call.body), [{}, { workflowRunId: 'run-9' }, { command: 'npm test' }, { command: 'npm test', workflowRunId: 'run-9' }]);
  assert.equal(calls[1].url.endsWith('/api/commands/cmd-1/run'), true);
  assert.equal(calls[3].url.endsWith('/api/projects/p1/commands/run-adhoc'), true);
});

test('a failed request throws an ApiError carrying the status, so a 410 reads as a removed working copy', async () => {
  const { serverApi, ApiError } = await import('../src/lib/serverApi.ts');
  const { isWorkingCopyRemoved } = await import('../src/lib/quickLook.ts');
  const { result } = await withMockFetch({ error: 'The task\'s working copy has been removed' }, 410, () => serverApi.listQuickLookCodeTree('run-1').catch((error) => error));
  assert.ok(result instanceof ApiError);
  assert.equal(result.status, 410);
  assert.equal(result.message, 'The task\'s working copy has been removed');
  assert.equal(isWorkingCopyRemoved(result), true);
});
