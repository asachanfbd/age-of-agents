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

const { workflowBadge, stageAgentLabel, loopBackLabel, stageExecutorLabel, DEFAULT_WORKFLOW_ID } =
  await import('../src/lib/workflowSettings.ts');

test('workflowBadge marks the Project\'s explicit choice "current"', () => {
  assert.equal(workflowBadge({ workflowId: 'wf-a' }, { id: 'wf-a' }), 'current');
  assert.equal(workflowBadge({ workflowId: 'wf-a' }, { id: 'wf-b' }), null);
});

test('workflowBadge marks software-development "default" only when the Project has no workflowId set', () => {
  assert.equal(workflowBadge({ workflowId: null }, { id: DEFAULT_WORKFLOW_ID }), 'default');
  assert.equal(workflowBadge({ workflowId: undefined }, { id: DEFAULT_WORKFLOW_ID }), 'default');
  assert.equal(workflowBadge({ workflowId: null }, { id: 'some-other-workflow' }), null);
});

test('workflowBadge prefers the explicit choice over the default guess, even if it happens to be software-development', () => {
  assert.equal(workflowBadge({ workflowId: DEFAULT_WORKFLOW_ID }, { id: DEFAULT_WORKFLOW_ID }), 'current');
  assert.equal(workflowBadge({ workflowId: 'wf-a' }, { id: DEFAULT_WORKFLOW_ID }), null);
});

test('stageAgentLabel prefers the resolved agent\'s name, falling back to the raw agentId', () => {
  assert.equal(stageAgentLabel({ agentId: 'agent-1', agent: { id: 'agent-1', name: 'Reviewer' } }), 'Reviewer');
  assert.equal(stageAgentLabel({ agentId: 'agent-1' }), 'agent-1');
  assert.equal(stageAgentLabel({ agentId: 'agent-1', agent: undefined }), 'agent-1');
});

test('loopBackLabel is null for a step that is not a loop origin', () => {
  assert.equal(loopBackLabel({ loopBack: null }, []), null);
  assert.equal(loopBackLabel({ loopBack: undefined }, []), null);
});

test('loopBackLabel resolves the target step\'s name and pluralizes "times" correctly', () => {
  const steps = [{ id: 'review', name: 'Review' }, { id: 'implement', name: 'Implement' }];
  assert.equal(
    loopBackLabel({ loopBack: { toStepId: 'implement', maxRounds: 3 } }, steps),
    'Loops back to Implement up to 3 times',
  );
  assert.equal(
    loopBackLabel({ loopBack: { toStepId: 'implement', maxRounds: 1 } }, steps),
    'Loops back to Implement up to 1 time',
  );
});

test('loopBackLabel falls back to the raw target id when it is not found among the steps', () => {
  assert.equal(
    loopBackLabel({ loopBack: { toStepId: 'missing-step', maxRounds: 2 } }, [{ id: 'implement', name: 'Implement' }]),
    'Loops back to missing-step up to 2 times',
  );
});

test('stageExecutorLabel resolves an override against the executor list, or is null with no override', () => {
  const executors = [{ id: 'exec-1', label: 'Claude (work account)' }];
  assert.equal(stageExecutorLabel({ executorId: 'exec-1' }, executors), 'Claude (work account)');
  assert.equal(stageExecutorLabel({ executorId: null }, executors), null);
  assert.equal(stageExecutorLabel({}, executors), null);
});

test('stageExecutorLabel falls back to the raw id for a deleted executor', () => {
  assert.equal(stageExecutorLabel({ executorId: 'gone' }, []), 'gone');
});
