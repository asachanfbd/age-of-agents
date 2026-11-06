import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
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
const note = await import('../src/lib/stepNote.ts');

test('steps yet to run use the start hint and show no warning', () => {
  for (const status of [undefined, 'skipped']) {
    const timing = note.stepNoteTiming(status);
    assert.equal(timing, 'upcoming');
    assert.match(note.stepNoteHint(timing), /Appended to the end of this step's input when it starts/);
    assert.equal(note.stepNoteWarning(timing), null);
  }
});

test('started, completed and failed steps warn that the note waits for the next round', () => {
  for (const status of ['running', 'awaiting-approval', 'changes-requested']) assert.equal(note.stepNoteTiming(status), 'started');
  assert.match(note.stepNoteWarning('started'), /already started/);
  assert.equal(note.stepNoteTiming('done'), 'completed');
  assert.match(note.stepNoteWarning('completed'), /already completed.*next round/);
  for (const status of ['failed', 'stopped']) assert.equal(note.stepNoteTiming(status), 'retry');
  assert.match(note.stepNoteWarning('retry'), /runs again/);
  assert.equal(note.stepNoteHint('started'), null);
});

test('the wording switches at the transition and never reverts', () => {
  const labels = ['skipped-not-yet', 'running', 'done'].map((status) => note.stepNoteSavedLabel(note.stepNoteTiming(status === 'skipped-not-yet' ? undefined : status)));
  assert.match(labels[0], /sent when this step starts/);
  assert.match(labels[1], /next round/);
  assert.match(labels[2], /next round/);
});

test('the button label and counter follow the note', () => {
  assert.equal(note.stepNoteButtonLabel(false), 'Add note');
  assert.equal(note.stepNoteButtonLabel(true), 'Edit note');
  assert.deepEqual(note.stepNoteCounter(' abc '), { label: '3 / 4000', tooLong: false });
  assert.equal(note.stepNoteCounter('x'.repeat(4000)).tooLong, false);
  assert.deepEqual(note.stepNoteCounter('x'.repeat(4001)), { label: '4001 / 4000 — 1 over the limit', tooLong: true });
  assert.equal(note.stepNoteCounter('😀'.repeat(4000)).tooLong, false, 'counted in code points');
  assert.equal(note.stepNoteCounter('😀'.repeat(4001)).tooLong, true);
});

test('Save is disabled when too long, saving or unchanged; clearing a stored note is allowed', () => {
  assert.equal(note.canSaveStepNote('new', undefined, false), true);
  assert.equal(note.canSaveStepNote('x'.repeat(4001), undefined, false), false);
  assert.equal(note.canSaveStepNote('new', undefined, true), false);
  assert.equal(note.canSaveStepNote(' same ', 'same', false), false);
  assert.equal(note.canSaveStepNote('', 'old', false), true);
  assert.equal(note.canSaveStepNote('  ', undefined, false), false);
});

test('the view wires the note control, stepper marker and API call', () => {
  const control = readFileSync(new URL('../src/ui/project-popup/StepNoteControl.tsx', import.meta.url), 'utf8');
  assert.match(control, /import \{ Button \} from '@\/components\/ui\/button'/);
  assert.match(control, /Textarea/);
  assert.match(control, /role="status"/);
  assert.match(control, /serverApi\.setStepNote\(planItemId, stepId, draft\.trim\(\)\)/);
  assert.match(control, /<Alert variant="destructive">/);
  assert.match(control, />Cancel</);
  assert.match(control, />Clear</);
  const view = readFileSync(new URL('../src/ui/project-popup/WorkflowRunView.tsx', import.meta.url), 'utf8');
  assert.match(view, /<StepNoteControl/);
  assert.match(view, /notedStepIds=/);
  const stepper = readFileSync(new URL('../src/ui/project-popup/WorkflowRunStepper.tsx', import.meta.url), 'utf8');
  assert.match(stepper, /notedStepIds\.includes\(stage\.id\)/);
});

test('the API client PUTs the note to the step', async () => {
  const { serverApi } = await import('../src/lib/serverApi.ts');
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push([String(url), init]); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    await serverApi.setStepNote('item-1', 'build', 'hello');
  } finally { globalThis.fetch = original; }
  assert.match(calls[0][0], /\/api\/plan-items\/item-1\/step-notes\/build$/);
  assert.equal(calls[0][1].method, 'PUT');
  assert.equal(calls[0][1].body, JSON.stringify({ note: 'hello' }));
});

test('Clear only empties the draft; Save is the only call to the API and reloads the run detail', () => {
  const control = readFileSync(new URL('../src/ui/project-popup/StepNoteControl.tsx', import.meta.url), 'utf8');
  const clear = control.match(/<Button[^>]*onClick=\{([^}]*)\}[^>]*>Clear<\/Button>/);
  assert.ok(clear, 'a Clear button exists');
  assert.equal(clear[1], "() => setDraft('')");
  assert.equal(control.match(/serverApi\.setStepNote/g).length, 1);
  assert.match(control, /await serverApi\.setStepNote[^;]*;\s*onSaved\(\);\s*setOpen\(false\)/);
  const view = readFileSync(new URL('../src/ui/project-popup/WorkflowRunView.tsx', import.meta.url), 'utf8');
  assert.match(view, /onSaved=\{\(\) => void loadWorkflowRunDetail\(runId\)\}/);
});

test('the web and server note limits and counting stay in step', async () => {
  const server = await import('../../server/src/projects/stepNotes.ts');
  assert.equal(note.MAX_STEP_NOTE_LENGTH, 4000);
  assert.equal(server.MAX_STEP_NOTE_LENGTH, note.MAX_STEP_NOTE_LENGTH);
  for (const text of ['abc', '😀😀', 'a😀é\r\n']) assert.equal(server.codePointLength(text), note.codePointLength(text));
});
