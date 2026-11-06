import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { installServerStub } from './serverStub.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { serverApi } = await import('../src/lib/serverApi.ts');

test('stubbed completed-run choice, reopen and persisted resolution match the daemon contract', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const stub = installServerStub();
    stub.tasksById.set('step-1', { id: 'step-1', workflowRunId: 'run-1', workflowStepId: 'build', status: 'done', sessionId: 'cli-1' });
    stub.workflowRuns.set('run-1', {
      id: 'run-1', status: 'completed', branch: 'task/step-1', worktreePath: '/tmp/step-1',
      workflowSnapshot: { steps: [{ id: 'build', canEditCode: true }] }, pendingInspectChanges: null,
    });
    assert.deepEqual(await serverApi.stepReopenOptions('step-1'), { choiceRequired: true, permissionsAvailable: true });
    await assert.rejects(() => serverApi.reopenStepSession('step-1'), /choose a reopen mode/);
    assert.deepEqual(await serverApi.reopenStepSession('step-1', 'permissions'), { location: 'recreated-worktree', mode: 'permissions' });
    await assert.rejects(() => serverApi.reopenStepSession('step-1', 'permissions'), /already open/);
    await serverApi.closeStepSession('step-1');
    stub.workflowRuns.get('run-1').pendingInspectChanges = { taskId: 'step-1', worktreePath: '/tmp/step-1', state: 'pending', hasChanges: true };
    assert.ok((await serverApi.getWorkflowRunDetail('run-1')).run.pendingInspectChanges);
    await assert.rejects(() => serverApi.reopenStepSession('step-1', 'permissions'), /cannot be reopened/);
    const resolved = await serverApi.resolveStepInspectChanges('run-1', 'discard');
    assert.equal(resolved.pendingInspectChanges, null);
    await assert.rejects(() => serverApi.resolveStepInspectChanges('run-1', 'discard'), /no reopened changes/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
