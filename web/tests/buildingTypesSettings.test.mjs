import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const view = await import('../src/lib/typeConfigView.ts');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const slot = (over = {}) => ({
  slot: { id: 'feature', label: 'Build a feature', usedWhen: 'x', defaultWorkflowId: 'dev' },
  configuredWorkflowId: null, effectiveWorkflowId: 'dev', fellBack: null, customised: false,
  workflow: { id: 'dev', name: 'Dev', description: 'Dev desc' },
  steps: [
    { id: 'plan', name: 'Plan', defaultAgentId: 'eng', configuredAgentId: null, effectiveAgentId: 'eng', agentFellBack: false },
    { id: 'build', name: 'Build', defaultAgentId: 'eng', configuredAgentId: 'tester', effectiveAgentId: 'tester', agentFellBack: false },
  ],
  ...over,
});
const docs = { id: 'docs', name: 'Docs', description: 'Docs desc', enabled: true, steps: [{ id: 'draft', name: 'Draft', agentId: 'writer' }] };

test('CatalogModal mounts BuildingTypesSettings as a Building Types section', () => {
  const modal = src('ui/CatalogModal.tsx');
  assert.match(modal, /import \{ BuildingTypesSettings \}/);
  assert.match(modal, /<BuildingTypesSettings \/>/);
  assert.match(modal, /Building Types/);
});

test('BuildingTypesSettings wires the config helpers and the apply-to-new-runs note', () => {
  const s = src('ui/BuildingTypesSettings.tsx');
  for (const name of ['changedSlots', 'isDirty', 'allStepsTo', 'workflowChangeWarning', 'fallbackNotice', 'stepAgentNotice', 'slotBadge', 'APPLIES_TO_NEW_RUNS', 'setSlotConfig', 'resetSlotConfig', 'FormErrorAlert']) {
    assert.ok(s.includes(name), name);
  }
});

test('enabledOptions keeps a chosen-but-disabled item visible', () => {
  const items = [{ id: 'a', enabled: true }, { id: 'b', enabled: false }, { id: 'c', enabled: false }];
  assert.deepEqual(view.enabledOptions(items, 'a').map((i) => i.id), ['a']);
  assert.deepEqual(view.enabledOptions(items, 'b').map((i) => i.id), ['a', 'b']);
  assert.deepEqual(view.enabledOptions(items, 'gone').map((i) => i.id), ['a']);
});

test('draftWorkflowId lays an edit over the saved workflow', () => {
  assert.equal(view.draftWorkflowId(slot(), undefined), 'dev');
  assert.equal(view.draftWorkflowId(slot(), { workflowId: 'docs' }), 'docs');
  assert.equal(view.draftWorkflowId(slot({ effectiveWorkflowId: 'docs' }), { workflowId: null }), 'dev');
});

test('pickWorkflow stores null for the default and drops the edit for the current workflow', () => {
  assert.deepEqual(view.pickWorkflow({}, slot({ effectiveWorkflowId: 'docs' }), 'dev'), { feature: { workflowId: null, stepAgents: {} } });
  assert.deepEqual(view.pickWorkflow({}, slot(), 'docs'), { feature: { workflowId: 'docs', stepAgents: {} } });
  assert.deepEqual(view.pickWorkflow({ feature: { workflowId: 'docs', stepAgents: {} }, other: { stepAgents: { x: 'y' } } }, slot(), 'dev'), { other: { stepAgents: { x: 'y' } } });
});

test('pickStepAgent stores null when the step\'s own agent is chosen', () => {
  assert.deepEqual(view.pickStepAgent({}, 'feature', { id: 'plan', defaultAgentId: 'eng' }, 'eng'), { feature: { stepAgents: { plan: null } } });
  assert.deepEqual(view.pickStepAgent({}, 'feature', { id: 'plan', defaultAgentId: 'eng' }, 'ui'), { feature: { stepAgents: { plan: 'ui' } } });
});

test('draftSteps shows saved steps, edits over them, and a new workflow\'s own steps', () => {
  const saved = view.draftSteps(slot(), undefined, [docs]);
  assert.deepEqual(saved.map((s) => [s.id, s.agentId, s.customised]), [['plan', 'eng', false], ['build', 'tester', true]]);
  const edited = view.draftSteps(slot(), { stepAgents: { plan: 'ui', build: null } }, [docs]);
  assert.deepEqual(edited.map((s) => [s.agentId, s.customised]), [['ui', true], ['eng', false]]);
  const switched = view.draftSteps(slot(), { workflowId: 'docs', stepAgents: {} }, [docs]);
  assert.deepEqual(switched, [{ id: 'draft', name: 'Draft', defaultAgentId: 'writer', agentId: 'writer', customised: false }]);
  assert.deepEqual(view.draftSteps(slot(), { workflowId: 'missing', stepAgents: {} }, [docs]), []);
});

test('draftWorkflowInfo prefers the Catalog record, then the slot\'s own, then the id', () => {
  assert.deepEqual(view.draftWorkflowInfo(slot(), { workflowId: 'docs' }, [docs]), { name: 'Docs', description: 'Docs desc' });
  assert.deepEqual(view.draftWorkflowInfo(slot(), undefined, []), { name: 'Dev', description: 'Dev desc' });
  assert.deepEqual(view.draftWorkflowInfo(slot(), { workflowId: 'x' }, []), { name: 'x', description: '' });
});

test('name lookups fall back to the id', () => {
  assert.equal(view.agentNameOf([{ id: 'a', name: 'Alpha' }], 'a'), 'Alpha');
  assert.equal(view.agentNameOf([], 'a'), 'a');
  assert.equal(view.workflowNameOf([docs], 'docs'), 'Docs');
  assert.equal(view.workflowNameOf([], 'z'), 'z');
});

test('slotPayload omits an empty step map and withoutSlots removes saved slots', () => {
  assert.deepEqual(view.slotPayload({ workflowId: null, stepAgents: {} }), { workflowId: null });
  assert.deepEqual(view.slotPayload({ stepAgents: { a: 'b' } }), { stepAgents: { a: 'b' } });
  assert.deepEqual(view.withoutSlots({ a: { workflowId: 'x' }, b: { workflowId: 'y' } }, ['a']), { b: { workflowId: 'y' } });
});
