import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports.
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
  initialStepSelection, skippedStepIds, stepDependents, stepParentId, stepSelectionCount, stepTag, toggleStepSelection,
} = await import('../src/lib/stepSelection.ts');

// The Start task dialog's step list (task 5.007). Its dependency rules live in lib/stepSelection.ts
// and are tested here; the dialog's wiring is pinned against its source at the end.

const step = (id, name, patch = {}) => ({ id, name, requiresApproval: false, ...patch });
const STEPS = [
  step('ui', 'UI Planning'),
  step('tc', 'Test Case Planning'),
  step('dev', 'Development'),
  step('cr', 'Code Review', { loopBack: { toStepId: 'dev', maxRounds: 3 } }),
  step('hcr', 'Human Code Review', { requiresApproval: true, requestChangesToStepId: 'dev' }),
  step('docs', 'Docs & Retro'),
];
// A ← B (loops to A) ← C (approval, changes → B).
const CHAIN = [
  step('a', 'A'),
  step('b', 'B', { loopBack: { toStepId: 'a', maxRounds: 1 } }),
  step('c', 'C', { requiresApproval: true, requestChangesToStepId: 'b' }),
];
const byId = (steps, id) => steps.find((s) => s.id === id);
const toggle = (selection, ...ids) => ids.reduce((current, id) => toggleStepSelection(STEPS, current, id), selection);
const none = () => ({ selected: [], notes: {} });

// ---- Parents ----

test('a looping review\'s parent is its loop target, an approval step\'s is its Request changes target', () => {
  assert.equal(stepParentId(STEPS, byId(STEPS, 'cr')), 'dev');
  assert.equal(stepParentId(STEPS, byId(STEPS, 'hcr')), 'dev');
});

test('a plain step, and an approval step with no Request changes target, have no parent', () => {
  assert.equal(stepParentId(STEPS, byId(STEPS, 'ui')), null);
  const steps = [step('a', 'A'), step('b', 'B', { requiresApproval: true, requestChangesToStepId: null }), step('c', 'C', { requiresApproval: true })];
  assert.equal(stepParentId(steps, steps[1]), null);
  assert.equal(stepParentId(steps, steps[2]), null);
});

test('a target that is the step itself, a later step or unknown gives no parent, without throwing', () => {
  const steps = [
    step('a', 'A', { requiresApproval: true, requestChangesToStepId: 'a' }),
    step('b', 'B', { requiresApproval: true, requestChangesToStepId: 'c' }),
    step('c', 'C', { loopBack: { toStepId: 'missing', maxRounds: 1 } }),
    step('d', 'D', { requestChangesToStepId: 'a' }),
  ];
  for (const s of steps) assert.equal(stepParentId(steps, s), null, s.id);
});

test('stepDependents follows dependencies transitively, in workflow order', () => {
  assert.deepEqual(stepDependents(STEPS, 'dev'), ['cr', 'hcr']);
  assert.deepEqual(stepDependents(STEPS, 'cr'), []);
  assert.deepEqual(stepDependents(CHAIN, 'a'), ['b', 'c']);
});

// ---- AC 1: initial selection ----

test('every step starts checked, in order, with no notes', () => {
  assert.deepEqual(initialStepSelection(STEPS), { selected: ['ui', 'tc', 'dev', 'cr', 'hcr', 'docs'], notes: {} });
  assert.deepEqual(initialStepSelection([]), { selected: [], notes: {} });
});

// ---- AC 2: unchecking ----

test('unchecking Development also unchecks Code Review and Human Code Review, noting why', () => {
  const next = toggle(initialStepSelection(STEPS), 'dev');
  assert.deepEqual(next.selected, ['ui', 'tc', 'docs']);
  assert.deepEqual(next.notes, { cr: 'Unchecked with Development', hcr: 'Unchecked with Development' });
});

test('unchecking Code Review or Human Code Review leaves Development alone', () => {
  const noReview = toggle(initialStepSelection(STEPS), 'cr');
  assert.deepEqual(noReview, { selected: ['ui', 'tc', 'dev', 'hcr', 'docs'], notes: {} });
  const noSignoff = toggle(initialStepSelection(STEPS), 'hcr');
  assert.deepEqual(noSignoff, { selected: ['ui', 'tc', 'dev', 'cr', 'docs'], notes: {} });
});

test('unchecking a step nothing depends on changes only that step', () => {
  assert.deepEqual(toggle(initialStepSelection(STEPS), 'ui'), { selected: ['tc', 'dev', 'cr', 'hcr', 'docs'], notes: {} });
});

test('unchecking the root of a chain unchecks the whole chain, each noted with the root', () => {
  const next = toggleStepSelection(CHAIN, initialStepSelection(CHAIN), 'a');
  assert.deepEqual(next, { selected: [], notes: { b: 'Unchecked with A', c: 'Unchecked with A' } });
});

test('a dependent that was already unchecked gets no note when its parent is unchecked', () => {
  const next = toggle(initialStepSelection(STEPS), 'cr', 'dev');
  assert.deepEqual(next.notes, { hcr: 'Unchecked with Development' });
});

// ---- AC 2: checking ----

test('checking Code Review re-checks Development, noting why, and leaves Human Code Review unchecked', () => {
  const next = toggle(initialStepSelection(STEPS), 'dev', 'cr');
  assert.deepEqual(next.selected, ['ui', 'tc', 'dev', 'cr', 'docs']);
  assert.equal(next.notes.dev, 'Checked for Code Review');
  assert.equal(next.notes.hcr, 'Unchecked with Development');
});

test('checking Human Code Review re-checks Development', () => {
  const next = toggle(initialStepSelection(STEPS), 'dev', 'hcr');
  assert.deepEqual(next.selected, ['ui', 'tc', 'dev', 'hcr', 'docs']);
  assert.equal(next.notes.dev, 'Checked for Human Code Review');
});

test('checking a dependent whose parent is already checked changes nothing else', () => {
  const next = toggle(initialStepSelection(STEPS), 'cr', 'cr');
  assert.deepEqual(next, initialStepSelection(STEPS));
});

test('checking the end of an unchecked chain checks every step it depends on', () => {
  const next = toggleStepSelection(CHAIN, none(CHAIN), 'c');
  assert.deepEqual(next, { selected: ['a', 'b', 'c'], notes: { a: 'Checked for C', b: 'Checked for C' } });
});

test('checking a parent does not re-check its dependents', () => {
  const next = toggle(initialStepSelection(STEPS), 'dev', 'dev');
  assert.deepEqual(next.selected, ['ui', 'tc', 'dev', 'docs']);
});

// ---- Notes ----

test('toggling a row clears its own note and keeps the others', () => {
  const next = toggle(initialStepSelection(STEPS), 'dev', 'cr');
  assert.equal(next.notes.cr, undefined, 'Code Review\'s "Unchecked with" note is gone');
  assert.equal(next.notes.hcr, 'Unchecked with Development');
});

test('toggling an unknown step id returns the selection unchanged', () => {
  const selection = initialStepSelection(STEPS);
  assert.equal(toggleStepSelection(STEPS, selection, 'nope'), selection);
});

// ---- Invariant ----

test('whatever the starting state and toggle, no checked step is left with an unchecked parent', () => {
  for (const steps of [STEPS, CHAIN]) {
    for (let mask = 0; mask < 2 ** steps.length; mask += 1) {
      const selected = steps.filter((_, i) => mask & (1 << i)).map((s) => s.id);
      for (const s of steps) {
        const next = toggleStepSelection(steps, { selected, notes: {} }, s.id);
        const wasValid = steps.every((x) => !selected.includes(x.id) || !stepParentId(steps, x) || selected.includes(stepParentId(steps, x)));
        if (!wasValid) continue;
        for (const id of next.selected) {
          const parentId = stepParentId(steps, byId(steps, id));
          assert.ok(!parentId || next.selected.includes(parentId), `mask ${mask}, toggle ${s.id}: ${id} checked without ${parentId}`);
        }
      }
    }
  }
});

// ---- Output ----

test('skippedStepIds lists the unchecked steps in workflow order, and nothing when all are checked', () => {
  assert.deepEqual(skippedStepIds(STEPS, initialStepSelection(STEPS)), []);
  assert.deepEqual(skippedStepIds(STEPS, toggle(initialStepSelection(STEPS), 'docs', 'dev', 'ui')), ['ui', 'dev', 'cr', 'hcr', 'docs']);
});

test('stepTag names an approval step\'s Request changes target and a review\'s loop target', () => {
  assert.equal(stepTag(byId(STEPS, 'hcr'), STEPS), 'Approval · changes → Development');
  assert.equal(stepTag(byId(STEPS, 'cr'), STEPS), 'Loops to Development');
  assert.equal(stepTag(step('x', 'X', { requiresApproval: true }), STEPS), 'Approval');
  assert.equal(stepTag(byId(STEPS, 'ui'), STEPS), null);
});

test('stepSelectionCount reads "n of total"', () => {
  assert.equal(stepSelectionCount(STEPS, initialStepSelection(STEPS)), '6 of 6');
  assert.equal(stepSelectionCount(STEPS, toggle(initialStepSelection(STEPS), 'ui')), '5 of 6');
  assert.equal(stepSelectionCount(STEPS, none(STEPS)), '0 of 6');
});

// ---- The Start task dialog's wiring ----

const dialogs = await readFile(new URL('../src/ui/project-popup/TaskDialogs.tsx', import.meta.url), 'utf8');
const panel = await readFile(new URL('../src/ui/project-popup/TasksPanel.tsx', import.meta.url), 'utf8');
const startDialog = dialogs.slice(dialogs.indexOf('export function StartTaskDialog'));

test('the dialog gets whole workflows, steps included', () => {
  assert.match(dialogs, /workflows: Pick<WorkflowRecord, 'id' \| 'name' \| 'steps'>\[\];/);
  assert.match(panel, /const workflows = enabledWorkflows\(catalogWorkflows\);/);
});

test('the dialog uses the selection helpers and keeps no dependency logic of its own', () => {
  assert.match(dialogs, /import \{ initialStepSelection, skippedStepIds, stepSelectionCount, stepTag, toggleStepSelection, type StepSelection \} from '..\/..\/lib\/stepSelection';/);
  assert.match(startDialog, /useState<StepSelection>\(\(\) => initialStepSelection\(steps\)\)/);
  assert.match(startDialog, /onToggle=\{\(stepId\) => setSelection\(\(current\) => toggleStepSelection\(steps, current, stepId\)\)\}/);
  assert.doesNotMatch(startDialog, /loopBack\?\.toStepId|requestChangesToStepId/);
});

test('changing the workflow resets the list to its steps, all checked, with no notes', () => {
  assert.match(startDialog, /<Select value=\{workflowId\} onValueChange=\{changeWorkflow\}>/);
  assert.match(startDialog, /function changeWorkflow\(id: string\) \{\s*setWorkflowId\(id\);\s*setSelection\(initialStepSelection\(workflows\.find\(\(workflow\) => workflow\.id === id\)\?\.steps \?\? \[\]\)\);/);
});

test('each step is a Checkbox row with its tag and note, and Complete is a fixed row with no checkbox', () => {
  assert.match(startDialog, /\{steps\.length > 0 && \(\s*<StepChecklist/, 'no Steps section without a workflow');
  assert.match(startDialog, /<Checkbox id=\{`start-step-\$\{step\.id\}`\} checked=\{checked\} onCheckedChange=\{\(\) => onToggle\(step\.id\)\} \/>/);
  assert.match(startDialog, /const tag = stepTag\(step, steps\);/);
  assert.match(startDialog, /\{note && <span[^>]*>\{note\}<\/span>\}/);
  const completeStart = startDialog.lastIndexOf('<div', startDialog.indexOf('completeStageLabel(hasRepository)'));
  const complete = startDialog.slice(completeStart, startDialog.indexOf('</div>', completeStart));
  assert.match(complete, /completeStageLabel\(hasRepository\)\}<\/span>\s*<span>always runs<\/span>/);
  assert.doesNotMatch(complete, /Checkbox/);
});

test('with nothing checked Start is disabled and the list explains why', () => {
  assert.match(startDialog, /const noStepSelected = steps\.length > 0 && selection\.selected\.length === 0;/);
  assert.match(startDialog, /disabled=\{!executorId \|\| needsWorkflow \|\| noStepSelected \|\| starting\}/);
  assert.match(startDialog, /\{invalid && <p role="alert" className="text-xs text-destructive">Pick at least one step to run\.<\/p>\}/);
  assert.match(startDialog, /border \$\{invalid \? 'border-destructive' : ''\}/);
});

test('Start sends the unchecked steps, only when there are any', async () => {
  assert.match(startDialog, /const skipped = skippedStepIds\(steps, selection\);/);
  assert.match(startDialog, /startOptions\(\{ executorId, createBranch, hasRepository, autoMerge, workflowId, skippedStepIds: skipped \}\)/);
  const lib = await readFile(new URL('../src/lib/startTaskDialog.ts', import.meta.url), 'utf8');
  assert.match(lib, /\.\.\.\(input\.skippedStepIds\.length \? \{ skippedStepIds: input\.skippedStepIds \} : \{\}\)/);
});

test('the dialog keeps its size and the list scrolls', () => {
  assert.match(startDialog, /<DialogContent className="sm:max-w-md" hideClose>/);
  assert.match(startDialog, /max-h-72 overflow-y-auto/);
});
