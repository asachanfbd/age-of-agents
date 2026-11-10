import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports (workflowForm.ts
// imports catalogForm.ts at runtime for isValidCatalogId) — same shim as projectTasks.test.mjs.
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

const {
  emptyAgentConfig,
  agentConfigFromRecord,
  emptyStep,
  stepFromRecord,
  emptyWorkflowFields,
  workflowFieldsFromRecord,
  addStep,
  removeStep,
  moveStep,
  earlierSteps,
  agentOptionsFor,
  skillOptionsFor,
  DEFAULT_EXECUTOR_VALUE,
  executorSelectValue,
  executorFieldValue,
  toWorkflowAgentConfig,
  toWorkflowStep,
  buildCreateWorkflowInput,
  buildUpdateWorkflowPatch,
  validateWorkflowForm,
} = await import('../src/lib/workflowForm.ts');
const { withSkillPreload, withSkillSelected } = await import('../src/lib/workflowForm.ts');
const { readFileSync } = await import('node:fs');

// ---- fixtures ----

function agent(overrides = {}) {
  return { id: 'software-engineer', name: 'Software Engineer', avatar: '🛠️', manager: false, defaultAutonomy: 'auto', agentFile: 'agents/software-engineer.md', enabled: true, ...overrides };
}

function skill(overrides = {}) {
  return { id: 'maintain-project-context', name: 'Maintain Project Context', description: '', enabled: true, skillDir: 'skills/maintain-project-context', supportFiles: [], ...overrides };
}

function agentConfigRecord(overrides = {}) {
  return { agentId: 'software-engineer', skillIds: ['maintain-project-context'], executorId: 'main', instructions: 'Do the thing.', ...overrides };
}

function stepRecord(overrides = {}) {
  return {
    id: 'development', name: 'Development', agentId: 'software-engineer', skillIds: [], canEditCode: true, requiresApproval: false,
    instructions: 'Build it.', loopBack: null, ...overrides,
  };
}

function workflowRecord(overrides = {}) {
  return {
    id: 'software-development', name: 'Software Development', description: 'The default workflow.', enabled: true,
    steps: [stepRecord()], ...overrides,
  };
}

/** A valid, save-ready WorkflowFormFields — individual tests mutate a clone of this to isolate one broken rule at a time. */
function validFields() {
  return {
    name: 'My Workflow',
    description: 'A description.',
    enabled: true,
    branchType: '',
    steps: [
      { id: 'dev', name: 'Development', agentId: 'software-engineer', skillIds: [], executorId: '', instructions: 'Build it.', canEditCode: true, requiresApproval: false, isNew: true, idTouched: true, loopBackEnabled: false, loopBackToStepId: '', loopBackMaxRounds: '3' },
      { id: 'review', name: 'Review', agentId: 'software-engineer', skillIds: [], executorId: '', instructions: 'Review it.', canEditCode: false, requiresApproval: false, isNew: true, idTouched: true, loopBackEnabled: true, loopBackToStepId: 'dev', loopBackMaxRounds: '3' },
    ],
  };
}

// ---- emptyAgentConfig / agentConfigFromRecord ----

test('emptyAgentConfig starts with every field blank', () => {
  assert.deepEqual(emptyAgentConfig(), { agentId: '', skillIds: [], preloadSkillIds: [], executorId: '', instructions: '' });
});

test('agentConfigFromRecord copies a WorkflowAgentConfig, defaulting a missing executorId to \'\'', () => {
  assert.deepEqual(agentConfigFromRecord(agentConfigRecord()), { agentId: 'software-engineer', skillIds: ['maintain-project-context'], preloadSkillIds: [], executorId: 'main', instructions: 'Do the thing.' });
});

test('agentConfigFromRecord defaults missing skillIds/executorId', () => {
  const config = agentConfigFromRecord({ agentId: 'a', instructions: 'x' });
  assert.deepEqual(config, { agentId: 'a', skillIds: [], preloadSkillIds: [], executorId: '', instructions: 'x' });
});

// ---- emptyStep / stepFromRecord ----

test('emptyStep starts new, untouched, and with no loop-back', () => {
  const step = emptyStep();
  assert.equal(step.isNew, true);
  assert.equal(step.idTouched, false);
  assert.equal(step.loopBackEnabled, false);
  assert.equal(step.id, '');
  assert.equal(step.loopBackMaxRounds, '3');
});

test('stepFromRecord marks an existing step not-new and id-touched', () => {
  const step = stepFromRecord(stepRecord());
  assert.equal(step.isNew, false);
  assert.equal(step.idTouched, true);
  assert.equal(step.name, 'Development');
  assert.equal(step.loopBackEnabled, false);
  assert.equal(step.loopBackToStepId, '');
});

test('stepFromRecord carries a real loopBack into loopBackEnabled/toStepId/maxRounds', () => {
  const step = stepFromRecord(stepRecord({ id: 'review', loopBack: { toStepId: 'development', maxRounds: 5 } }));
  assert.equal(step.loopBackEnabled, true);
  assert.equal(step.loopBackToStepId, 'development');
  assert.equal(step.loopBackMaxRounds, '5');
});

// ---- emptyWorkflowFields / workflowFieldsFromRecord ----

test('emptyWorkflowFields starts enabled with no steps', () => {
  const fields = emptyWorkflowFields();
  assert.equal(fields.enabled, true);
  assert.equal(fields.branchType, '');
  assert.deepEqual(fields.steps, []);
});

test('workflowFieldsFromRecord reads a fixed branch type, and none as blank', () => {
  assert.equal(workflowFieldsFromRecord(workflowRecord({ branchType: 'bugfix' })).branchType, 'bugfix');
  assert.equal(workflowFieldsFromRecord(workflowRecord()).branchType, '');
  assert.equal(workflowFieldsFromRecord(workflowRecord({ branchType: null })).branchType, '');
});

test('workflowFieldsFromRecord maps every field, including nested steps', () => {
  const fields = workflowFieldsFromRecord(workflowRecord());
  assert.equal(fields.name, 'Software Development');
  assert.equal(fields.steps.length, 1);
  assert.equal(fields.steps[0].id, 'development');
  assert.ok(!('requirementAnalysis' in fields), 'a workflow is only its steps');
});

// ---- addStep / removeStep / moveStep / earlierSteps ----

test('addStep appends one new blank step', () => {
  const steps = addStep([emptyStep()]);
  assert.equal(steps.length, 2);
  assert.equal(steps[1].isNew, true);
});

test('removeStep splices out the step at the given index', () => {
  const steps = [stepFromRecord(stepRecord({ id: 'a' })), stepFromRecord(stepRecord({ id: 'b' }))];
  const next = removeStep(steps, 0);
  assert.deepEqual(next.map((s) => s.id), ['b']);
});

test('removeStep clears a later step\'s dangling loop-back to the removed step', () => {
  const steps = [
    stepFromRecord(stepRecord({ id: 'a' })),
    stepFromRecord(stepRecord({ id: 'b', loopBack: { toStepId: 'a', maxRounds: 2 } })),
  ];
  const next = removeStep(steps, 0);
  assert.equal(next.length, 1);
  assert.equal(next[0].loopBackEnabled, false);
  assert.equal(next[0].loopBackToStepId, '');
});

test('removeStep leaves an unrelated loop-back alone', () => {
  const steps = [
    stepFromRecord(stepRecord({ id: 'a' })),
    stepFromRecord(stepRecord({ id: 'b' })),
    stepFromRecord(stepRecord({ id: 'c', loopBack: { toStepId: 'b', maxRounds: 2 } })),
  ];
  const next = removeStep(steps, 0);
  assert.deepEqual(next.map((s) => s.id), ['b', 'c']);
  assert.equal(next[1].loopBackEnabled, true);
  assert.equal(next[1].loopBackToStepId, 'b');
});

test('moveStep swaps a step with its neighbour one position up', () => {
  const steps = [stepFromRecord(stepRecord({ id: 'a' })), stepFromRecord(stepRecord({ id: 'b' }))];
  const next = moveStep(steps, 1, -1);
  assert.deepEqual(next.map((s) => s.id), ['b', 'a']);
});

test('moveStep swaps a step with its neighbour one position down', () => {
  const steps = [stepFromRecord(stepRecord({ id: 'a' })), stepFromRecord(stepRecord({ id: 'b' }))];
  const next = moveStep(steps, 0, 1);
  assert.deepEqual(next.map((s) => s.id), ['b', 'a']);
});

test('moveStep is a no-op past either end of the array', () => {
  const steps = [stepFromRecord(stepRecord({ id: 'a' })), stepFromRecord(stepRecord({ id: 'b' }))];
  assert.deepEqual(moveStep(steps, 0, -1), steps);
  assert.deepEqual(moveStep(steps, 1, 1), steps);
});

test('earlierSteps returns only the steps strictly before the given index', () => {
  const steps = [stepFromRecord(stepRecord({ id: 'a' })), stepFromRecord(stepRecord({ id: 'b' })), stepFromRecord(stepRecord({ id: 'c' }))];
  assert.deepEqual(earlierSteps(steps, 0).map((s) => s.id), []);
  assert.deepEqual(earlierSteps(steps, 2).map((s) => s.id), ['a', 'b']);
});

// ---- agentOptionsFor / skillOptionsFor ----

test('agentOptionsFor returns only enabled agents when the selection is already among them', () => {
  const agents = [agent({ id: 'a' }), agent({ id: 'b', enabled: false })];
  assert.deepEqual(agentOptionsFor(agents, 'a').map((a) => a.id), ['a']);
});

test('agentOptionsFor appends a disabled/currently-selected agent so its own value stays visible', () => {
  const agents = [agent({ id: 'a' }), agent({ id: 'b', enabled: false })];
  assert.deepEqual(agentOptionsFor(agents, 'b').map((a) => a.id), ['a', 'b']);
});

test('agentOptionsFor drops a selection that no longer exists in the Catalog at all', () => {
  const agents = [agent({ id: 'a' })];
  assert.deepEqual(agentOptionsFor(agents, 'deleted').map((a) => a.id), ['a']);
});

test('agentOptionsFor with no selection returns just the enabled agents', () => {
  const agents = [agent({ id: 'a' }), agent({ id: 'b', enabled: false })];
  assert.deepEqual(agentOptionsFor(agents, '').map((a) => a.id), ['a']);
});

test('skillOptionsFor returns enabled skills plus any selected-but-disabled ones', () => {
  const skills = [skill({ id: 'a' }), skill({ id: 'b', enabled: false })];
  assert.deepEqual(skillOptionsFor(skills, ['b']).map((s) => s.id), ['a', 'b']);
});

test('skillOptionsFor ignores a selected id the Catalog no longer has at all', () => {
  const skills = [skill({ id: 'a' })];
  assert.deepEqual(skillOptionsFor(skills, ['deleted']).map((s) => s.id), ['a']);
});

// ---- executor select sentinel mapping ----

test('executorSelectValue maps an unset override to the sentinel', () => {
  assert.equal(executorSelectValue(''), DEFAULT_EXECUTOR_VALUE);
  assert.equal(executorSelectValue('  '), DEFAULT_EXECUTOR_VALUE);
});

test('executorSelectValue passes a real executor id through unchanged', () => {
  assert.equal(executorSelectValue('main'), 'main');
});

test('executorFieldValue maps the sentinel back to an empty string', () => {
  assert.equal(executorFieldValue(DEFAULT_EXECUTOR_VALUE), '');
});

test('executorFieldValue passes a real executor id through unchanged', () => {
  assert.equal(executorFieldValue('main'), 'main');
});

// ---- toWorkflowAgentConfig / toWorkflowStep ----

test('toWorkflowAgentConfig omits skillIds/executorId when unset', () => {
  const config = toWorkflowAgentConfig({ agentId: 'a', skillIds: [], preloadSkillIds: [], executorId: '', instructions: 'do it' });
  assert.deepEqual(config, { agentId: 'a', instructions: 'do it' });
});

test('toWorkflowAgentConfig includes skillIds/executorId when set, and trims strings', () => {
  const config = toWorkflowAgentConfig({ agentId: ' a ', skillIds: ['s1'], preloadSkillIds: [], executorId: 'main', instructions: ' do it ' });
  assert.deepEqual(config, { agentId: 'a', skillIds: ['s1'], executorId: 'main', instructions: 'do it' });
});

test('toWorkflowStep builds a step with no loopBack when disabled', () => {
  const step = toWorkflowStep(validFields().steps[0]);
  assert.equal(step.id, 'dev');
  assert.equal(step.loopBack, undefined);
});

test('toWorkflowStep builds a step with a parsed integer loopBack when enabled', () => {
  const step = toWorkflowStep(validFields().steps[1]);
  assert.deepEqual(step.loopBack, { toStepId: 'dev', maxRounds: 3 });
});

// ---- buildCreateWorkflowInput / buildUpdateWorkflowPatch ----

test('buildCreateWorkflowInput shapes a full WorkflowInput, including every step', () => {
  const input = buildCreateWorkflowInput('  my-workflow  ', validFields());
  assert.equal(input.id, 'my-workflow');
  assert.equal(input.name, 'My Workflow');
  assert.equal(input.enabled, true);
  assert.ok(!('requirementAnalysis' in input));
  assert.equal(input.steps.length, 2);
  assert.equal(input.steps[1].loopBack.toStepId, 'dev');
});

test('buildCreateWorkflowInput sends a trimmed branch type only when one is set', () => {
  assert.ok(!('branchType' in buildCreateWorkflowInput('w', validFields())));
  assert.equal(buildCreateWorkflowInput('w', { ...validFields(), branchType: ' bugfix ' }).branchType, 'bugfix');
});

test('buildUpdateWorkflowPatch sends the branch type, or null to clear it back to the default', () => {
  assert.equal(buildUpdateWorkflowPatch({ ...validFields(), branchType: 'bugfix' }).branchType, 'bugfix');
  assert.equal(buildUpdateWorkflowPatch({ ...validFields(), branchType: '  ' }).branchType, null);
});

test('buildUpdateWorkflowPatch always sends every field back (no blank-to-keep carve-out)', () => {
  const patch = buildUpdateWorkflowPatch(validFields());
  assert.equal(patch.name, 'My Workflow');
  assert.equal(patch.description, 'A description.');
  assert.equal(patch.enabled, true);
  assert.ok(!('requirementAnalysis' in patch));
  assert.equal(patch.steps.length, 2);
});

// ---- validateWorkflowForm ----

test('validateWorkflowForm accepts a fully valid form', () => {
  assert.equal(validateWorkflowForm(validFields(), true, 'my-workflow'), null);
});

test('validateWorkflowForm accepts a lowercase slug branch type', () => {
  assert.equal(validateWorkflowForm({ ...validFields(), branchType: 'bug-fix2' }, true, 'w'), null);
});

test('validateWorkflowForm rejects a branch type that is not a lowercase slug', () => {
  for (const branchType of ['Bugfix', 'bug/fix', '-bug', 'bug fix']) {
    assert.match(validateWorkflowForm({ ...validFields(), branchType }, true, 'w'), /Branch type must be/, branchType);
  }
});

test('validateWorkflowForm rejects an invalid id on create', () => {
  assert.match(validateWorkflowForm(validFields(), true, '!!!'), /Id must start with/);
});

test('validateWorkflowForm ignores the id on edit (not new)', () => {
  assert.equal(validateWorkflowForm(validFields(), false, ''), null);
});

test('validateWorkflowForm requires a name', () => {
  const fields = validFields();
  fields.name = '   ';
  assert.match(validateWorkflowForm(fields, true, 'ok'), /Workflow name is required/);
});

test('validateWorkflowForm requires a description', () => {
  const fields = validFields();
  fields.description = '';
  assert.match(validateWorkflowForm(fields, true, 'ok'), /Description is required/);
});

test('validateWorkflowForm requires at least one step', () => {
  const fields = validFields();
  fields.steps = [];
  assert.match(validateWorkflowForm(fields, true, 'ok'), /at least one step/);
});

test('validateWorkflowForm requires every step to have a name', () => {
  const fields = validFields();
  fields.steps[0].name = '';
  assert.match(validateWorkflowForm(fields, true, 'ok'), /Step 1 needs a name/);
});

test('validateWorkflowForm requires every step to have a valid id', () => {
  const fields = validFields();
  fields.steps[0].id = '!!bad';
  assert.match(validateWorkflowForm(fields, true, 'ok'), /Step 1 needs an id/);
});

test('validateWorkflowForm rejects duplicate step ids', () => {
  const fields = validFields();
  fields.steps[1].id = 'dev';
  fields.steps[1].loopBackToStepId = 'dev';
  assert.match(validateWorkflowForm(fields, true, 'ok'), /used more than once/);
});

test('validateWorkflowForm requires every step to have an agent', () => {
  const fields = validFields();
  fields.steps[0].agentId = '';
  assert.match(validateWorkflowForm(fields, true, 'ok'), /Step 1 needs an agent/);
});

test('validateWorkflowForm requires every step to have instructions', () => {
  const fields = validFields();
  fields.steps[0].instructions = '';
  assert.match(validateWorkflowForm(fields, true, 'ok'), /Step 1 needs instructions/);
});

test('validateWorkflowForm rejects a loop-back targeting a step that is not earlier', () => {
  const fields = validFields();
  // Step 0 ("dev") loops back to step 1 ("review"), which comes after it.
  fields.steps[0].loopBackEnabled = true;
  fields.steps[0].loopBackToStepId = 'review';
  assert.match(validateWorkflowForm(fields, true, 'ok'), /Step 1's loop-back must target an earlier step/);
});

test('validateWorkflowForm rejects a loop-back with no target chosen', () => {
  const fields = validFields();
  fields.steps[1].loopBackToStepId = '';
  assert.match(validateWorkflowForm(fields, true, 'ok'), /Step 2's loop-back must target an earlier step/);
});

test('validateWorkflowForm rejects a non-integer loop-back round count', () => {
  const fields = validFields();
  fields.steps[1].loopBackMaxRounds = 'abc';
  assert.match(validateWorkflowForm(fields, true, 'ok'), /whole number from 1 to 10/);
});

test('validateWorkflowForm rejects a loop-back round count out of the 1-10 range', () => {
  const fields = validFields();
  fields.steps[1].loopBackMaxRounds = '0';
  assert.match(validateWorkflowForm(fields, true, 'ok'), /whole number from 1 to 10/);
  fields.steps[1].loopBackMaxRounds = '11';
  assert.match(validateWorkflowForm(fields, true, 'ok'), /whole number from 1 to 10/);
});

test('validateWorkflowForm accepts loop-back round counts at the 1 and 10 boundaries', () => {
  const low = validFields();
  low.steps[1].loopBackMaxRounds = '1';
  assert.equal(validateWorkflowForm(low, true, 'ok'), null);
  const high = validFields();
  high.steps[1].loopBackMaxRounds = '10';
  assert.equal(validateWorkflowForm(high, true, 'ok'), null);
});

// ---- Request changes target (approval steps) ----

/** validFields plus an approval step at the end, sending Request changes back to `target` when given. */
function withApprovalStep(target) {
  const fields = validFields();
  fields.steps.push({
    id: 'signoff', name: 'Sign-off', agentId: 'software-engineer', skillIds: [], executorId: '', instructions: 'Brief.', canEditCode: false, requiresApproval: true,
    isNew: true, idTouched: true, loopBackEnabled: false, loopBackToStepId: '', loopBackMaxRounds: '3',
    requestChangesEnabled: target !== undefined, requestChangesToStepId: target ?? '',
  });
  return fields;
}

test('emptyStep starts with no Request changes target', () => {
  const step = emptyStep();
  assert.equal(step.requestChangesEnabled, false);
  assert.equal(step.requestChangesToStepId, '');
});

test('stepFromRecord maps requestChangesToStepId to the checkbox and target, and absent or null to unset', () => {
  const set = stepFromRecord(stepRecord({ id: 'signoff', requiresApproval: true, requestChangesToStepId: 'development' }));
  assert.equal(set.requestChangesEnabled, true);
  assert.equal(set.requestChangesToStepId, 'development');
  for (const unset of [stepFromRecord(stepRecord()), stepFromRecord(stepRecord({ requestChangesToStepId: null }))]) {
    assert.equal(unset.requestChangesEnabled, false);
    assert.equal(unset.requestChangesToStepId, '');
  }
});

test('toWorkflowStep sends the Request changes target only while approval is on and the box is checked', () => {
  const step = withApprovalStep('dev').steps[2];
  assert.equal(toWorkflowStep(step).requestChangesToStepId, 'dev');
  assert.equal('requestChangesToStepId' in toWorkflowStep({ ...step, requestChangesEnabled: false }), false);
  assert.equal('requestChangesToStepId' in toWorkflowStep({ ...step, requiresApproval: false }), false, 'turning approval off drops the target on save');
});

test('buildCreateWorkflowInput and buildUpdateWorkflowPatch round-trip the Request changes target', () => {
  const fields = withApprovalStep('dev');
  assert.equal(buildCreateWorkflowInput('flow', fields).steps[2].requestChangesToStepId, 'dev');
  assert.equal(buildUpdateWorkflowPatch(fields).steps[2].requestChangesToStepId, 'dev');
  const reloaded = workflowFieldsFromRecord(workflowRecord({ steps: buildUpdateWorkflowPatch(fields).steps }));
  assert.equal(reloaded.steps[2].requestChangesToStepId, 'dev');
});

test('validateWorkflowForm accepts a Request changes target that is an earlier step', () => {
  assert.equal(validateWorkflowForm(withApprovalStep('dev'), true, 'ok'), null);
  assert.equal(validateWorkflowForm(withApprovalStep('review'), true, 'ok'), null);
});

test('validateWorkflowForm rejects a Request changes target that is itself, later, unknown or not chosen', () => {
  for (const target of ['signoff', 'nope', '']) {
    assert.match(validateWorkflowForm(withApprovalStep(target), true, 'ok'), /Step 3: Request changes must go back to an earlier step\./, `target "${target}"`);
  }
  const later = withApprovalStep('dev');
  const [dev, review, signoff] = later.steps;
  later.steps = [{ ...signoff, requestChangesToStepId: 'review' }, dev, review];
  assert.match(validateWorkflowForm(later, true, 'ok'), /Step 1: Request changes must go back to an earlier step\./);
});

test('validateWorkflowForm ignores a leftover target once approval is turned off', () => {
  const fields = withApprovalStep('nope');
  fields.steps[2].requiresApproval = false;
  assert.equal(validateWorkflowForm(fields, true, 'ok'), null);
});

test('moveStep that puts the target after its approval step fails validation', () => {
  const fields = withApprovalStep('review');
  fields.steps = moveStep(fields.steps, 1, 1);
  assert.deepEqual(fields.steps.map((s) => s.id), ['dev', 'signoff', 'review']);
  assert.match(validateWorkflowForm(fields, true, 'ok'), /Step 2: Request changes must go back to an earlier step\./);
});

test('removeStep clears a Request changes target that pointed at the removed step, and leaves others alone', () => {
  const removedTarget = removeStep(withApprovalStep('review').steps, 1);
  assert.equal(removedTarget[1].requestChangesEnabled, false);
  assert.equal(removedTarget[1].requestChangesToStepId, '');
  const kept = removeStep(withApprovalStep('dev').steps, 1);
  assert.equal(kept[1].requestChangesEnabled, true);
  assert.equal(kept[1].requestChangesToStepId, 'dev');
});

// ---- Quick look (task 5.008) ----

test('a new step\'s Quick look defaults to none, and a record without one reads as none', () => {
  assert.equal(emptyStep().quickLook, 'none');
  assert.equal(stepFromRecord(stepRecord()).quickLook, 'none');
  assert.equal(stepFromRecord(stepRecord({ quickLook: null })).quickLook, 'none');
});

test('a step\'s Quick look round-trips from the record into the saved step', () => {
  for (const quickLook of ['none', 'code', 'diff', 'documents', 'commands']) {
    const fields = stepFromRecord(stepRecord({ quickLook }));
    assert.equal(fields.quickLook, quickLook);
    assert.equal(toWorkflowStep(fields).quickLook, quickLook);
  }
});

test('buildUpdateWorkflowPatch sends each step\'s Quick look in the PUT body', () => {
  const fields = validFields();
  fields.steps = [{ ...fields.steps[0], quickLook: 'code' }, { ...fields.steps[1], quickLook: 'none' }];
  assert.deepEqual(buildUpdateWorkflowPatch(fields).steps.map((step) => step.quickLook), ['code', 'none']);
});

test('canRunCommands defaults off, reads absent as off, and round-trips independently of canEditCode', async () => {
  const { emptyStep, stepFromRecord, toWorkflowStep } = await import('../src/lib/workflowForm.ts');
  assert.equal(emptyStep().canRunCommands, false);
  const base = { id: 'rca', name: 'RCA', agentId: 'a', skillIds: [], instructions: 'x', canEditCode: false, requiresApproval: false };
  assert.equal(stepFromRecord(base).canRunCommands, false);
  const on = stepFromRecord({ ...base, canRunCommands: true });
  assert.equal(on.canRunCommands, true);
  assert.equal(toWorkflowStep(on).canRunCommands, true);
  assert.equal(toWorkflowStep({ ...on, canRunCommands: false }).canRunCommands, false);
  const both = stepFromRecord({ ...base, canEditCode: true, canRunCommands: true });
  assert.deepEqual([both.canEditCode, both.canRunCommands], [true, true]);
});

test('the editor and stage list show the Can run commands switch, helper text and badge', async () => {
  const { readFileSync } = await import('node:fs');
  const modal = readFileSync(new URL('../src/ui/CatalogModal.tsx', import.meta.url), 'utf8');
  assert.match(modal, /checked=\{step\.canRunCommands\}[^]*Can run commands/);
  assert.ok(modal.includes('The step may run shell commands such as installing dependencies and running tests. It still must not change project source files, and its work is not committed.'));
  assert.ok(modal.indexOf('Can edit code') < modal.indexOf('Can run commands'));
  const settings = readFileSync(new URL('../src/ui/project-popup/SettingsPanel.tsx', import.meta.url), 'utf8');
  assert.match(settings, /step\.canRunCommands && !step\.canEditCode && <Badge variant="outline">Runs commands<\/Badge>/);
});

// ---- "Always load" per skill (task 29.002) ----

const baseFields = { agentId: 'a', skillIds: ['s1', 's2'], preloadSkillIds: [], executorId: '', instructions: 'do it' };

test('agentConfigFromRecord maps preloadSkillIds, defaulting to none', () => {
  assert.deepEqual(agentConfigFromRecord({ agentId: 'a', skillIds: ['s1'], preloadSkillIds: ['s1'], instructions: 'x' }).preloadSkillIds, ['s1']);
  assert.deepEqual(agentConfigFromRecord({ agentId: 'a', skillIds: ['s1'], instructions: 'x' }).preloadSkillIds, []);
});

test('toWorkflowAgentConfig round-trips preloadSkillIds, and omits it when empty', () => {
  assert.deepEqual(toWorkflowAgentConfig({ ...baseFields, preloadSkillIds: ['s2'] }), { agentId: 'a', skillIds: ['s1', 's2'], preloadSkillIds: ['s2'], instructions: 'do it' });
  assert.equal('preloadSkillIds' in toWorkflowAgentConfig(baseFields), false);
});

test('toWorkflowAgentConfig never emits a preload id that is not an attached skill', () => {
  assert.deepEqual(toWorkflowAgentConfig({ ...baseFields, preloadSkillIds: ['s2', 'stray'] }).preloadSkillIds, ['s2']);
  assert.equal('preloadSkillIds' in toWorkflowAgentConfig({ ...baseFields, skillIds: [], preloadSkillIds: ['stray'] }), false);
});

test('withSkillPreload turns Always load on and off for a ticked skill, and ignores an unticked one', () => {
  const on = withSkillPreload(baseFields, 's1', true);
  assert.deepEqual(on.preloadSkillIds, ['s1']);
  assert.deepEqual(withSkillPreload(on, 's1', true).preloadSkillIds, ['s1']);
  assert.deepEqual(withSkillPreload(on, 's1', false).preloadSkillIds, []);
  assert.equal(withSkillPreload(baseFields, 'other', true), baseFields);
});

test('unticking a skill also removes it from Always load, and re-ticking starts on demand', () => {
  const preloaded = { ...baseFields, preloadSkillIds: ['s1', 's2'] };
  const removed = withSkillSelected(preloaded, 's1', false);
  assert.deepEqual(removed.skillIds, ['s2']);
  assert.deepEqual(removed.preloadSkillIds, ['s2']);
  const readded = withSkillSelected(removed, 's1', true);
  assert.deepEqual(readded.skillIds, ['s2', 's1']);
  assert.deepEqual(readded.preloadSkillIds, ['s2']);
  assert.equal(withSkillSelected(readded, 's1', true), readded);
});

test('the picker renders Always load only for ticked skills and "(no description)" for an empty one; the API types carry the field', () => {
  const modal = readFileSync(new URL('../src/ui/CatalogModal.tsx', import.meta.url), 'utf8');
  assert.match(modal, /\{selected && \([\s\S]*?Always load/);
  assert.match(modal, /\(no description\)/);
  assert.match(readFileSync(new URL('../src/lib/serverApi.ts', import.meta.url), 'utf8'), /preloadSkillIds\?: string\[\]/);
});

test('canUseBrowser defaults off, reads absent as off and round-trips', async () => {
  const { emptyStep, stepFromRecord, toWorkflowStep } = await import('../src/lib/workflowForm.ts');
  assert.equal(emptyStep().canUseBrowser, false);
  const base = { id: 'rev', name: 'Review', agentId: 'a', skillIds: [], instructions: 'x', canEditCode: false, canRunCommands: true, requiresApproval: false };
  assert.equal(stepFromRecord(base).canUseBrowser, false);
  const on = stepFromRecord({ ...base, canUseBrowser: true });
  assert.equal(on.canUseBrowser, true);
  assert.equal(toWorkflowStep(on).canUseBrowser, true);
  assert.equal(toWorkflowStep({ ...on, canUseBrowser: false }).canUseBrowser, false);
});

test('browser eligibility needs a shell and never flips the switch on its own', async () => {
  const { stepHasShell, browserLacksShell } = await import('../src/lib/workflowForm.ts');
  assert.equal(stepHasShell({ canEditCode: true, canRunCommands: false }), true);
  assert.equal(stepHasShell({ canEditCode: false, canRunCommands: true }), true);
  assert.equal(stepHasShell({ canEditCode: false, canRunCommands: false }), false);
  assert.equal(browserLacksShell({ canEditCode: false, canRunCommands: false, canUseBrowser: true }), true);
  assert.equal(browserLacksShell({ canEditCode: true, canRunCommands: false, canUseBrowser: true }), false);
  assert.equal(browserLacksShell({ canEditCode: false, canRunCommands: false, canUseBrowser: false }), false);
});

test('the editor shows the Can use browser switch states and the Settings row the Uses browser badge', async () => {
  const { readFileSync } = await import('node:fs');
  const modal = readFileSync(new URL('../src/ui/CatalogModal.tsx', import.meta.url), 'utf8');
  assert.ok(modal.includes('The step gets a headless browser it can drive to check the running app, for example opening pages, clicking through and taking screenshots. It needs a shell to start the app, so it also needs Can edit code or Can run commands.'));
  assert.ok(modal.includes("${!step.canUseBrowser && !stepHasShell(step) ? ' opacity-60' : ''}"), 'dimmed only when off and ineligible (state B), not in state C');
  assert.ok(modal.includes('Turn on Can edit code or Can run commands first.'));
  assert.match(modal, /role="alert"[^]*Error: Can use browser needs Can edit code or Can run commands\. Turn one of them on, or turn this off\./);
  assert.match(modal, /disabled=\{pending \|\| \(!step\.canUseBrowser && !stepHasShell\(step\)\)\}/);
  assert.ok(modal.indexOf('Can run commands') < modal.indexOf('Can use browser'));
  assert.ok(modal.indexOf('Can use browser') < modal.indexOf('Requires human approval'));
  const settings = readFileSync(new URL('../src/ui/project-popup/SettingsPanel.tsx', import.meta.url), 'utf8');
  assert.match(settings, /Runs commands<\/Badge>\}\s*\{step\.canUseBrowser && <Badge variant="outline">Uses browser<\/Badge>\}\s*\{step\.requiresApproval/);
  assert.ok(settings.includes('flex flex-wrap items-center gap-1.5'));
  const api = readFileSync(new URL('../src/lib/serverApi.ts', import.meta.url), 'utf8');
  assert.match(api, /canUseBrowser\?: boolean/);
});

// ---- Required HTML mockup (B.036) ----

test('B036 a new step does not require an HTML mockup, and a record without the field reads as off', () => {
  assert.equal(emptyStep().requiresHtmlOutput, false);
  assert.equal(stepFromRecord(stepRecord()).requiresHtmlOutput, false);
  assert.equal(stepFromRecord(stepRecord({ requiredOutputFormat: null })).requiresHtmlOutput, false);
  assert.equal('requiredOutputFormat' in toWorkflowStep(stepFromRecord(stepRecord())), false, 'a step without it does not gain the key');
});

test('B036 requiredOutputFormat "html" survives an editor round-trip, so saving never turns the guard off', () => {
  const fields = stepFromRecord(stepRecord({ requiredOutputFormat: 'html' }));
  assert.equal(fields.requiresHtmlOutput, true);
  assert.equal(toWorkflowStep(fields).requiredOutputFormat, 'html');
  assert.equal('requiredOutputFormat' in toWorkflowStep({ ...fields, requiresHtmlOutput: false }), false);
});

test('B036 the step editor shows the Require an HTML mockup switch bound to requiresHtmlOutput', () => {
  const modal = readFileSync(new URL('../src/ui/CatalogModal.tsx', import.meta.url), 'utf8');
  assert.match(modal, /Require an HTML mockup to complete/);
  assert.match(modal, /checked=\{step\.requiresHtmlOutput\} onCheckedChange=\{\(checked\) => onChange\(\{ \.\.\.step, requiresHtmlOutput: checked \}\)\}/);
});
