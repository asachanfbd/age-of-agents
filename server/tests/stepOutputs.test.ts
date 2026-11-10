import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStepOutputs } from '../src/api/stepOutputs.ts';

const mockup = { name: 'Screen', format: 'html', content: '<!doctype html><html></html>' };

test('absent or null outputs parse to undefined', () => {
  assert.deepEqual(parseStepOutputs(undefined), { outputs: undefined });
  assert.deepEqual(parseStepOutputs(null), { outputs: undefined });
});

test('a valid array is returned as is, including an empty one', () => {
  const outputs = [mockup, { name: 'Notes', format: 'markdown', content: '' }];
  assert.deepEqual(parseStepOutputs(outputs), { outputs });
  assert.deepEqual(parseStepOutputs([]), { outputs: [] });
});

test('a JSON string holding a valid array is parsed into it', () => {
  assert.deepEqual(parseStepOutputs(JSON.stringify([mockup])), { outputs: [mockup] });
});

test('a JSON string holding a malformed array gets the same element checks', () => {
  assert.deepEqual(parseStepOutputs(JSON.stringify([{ ...mockup, format: 'pdf' }])), { error: 'outputs[0].format must be "markdown" or "html"' });
});

test('anything that is not an array is refused', () => {
  for (const raw of ['not-json', '"str"', '{}', 42, {}, true]) {
    assert.deepEqual(parseStepOutputs(raw), { error: 'outputs must be an array (or a JSON string of one)' }, JSON.stringify(raw));
  }
});

test('each malformed element is named by its index', () => {
  assert.deepEqual(parseStepOutputs([null]), { error: 'outputs[0] must be an object' });
  assert.deepEqual(parseStepOutputs([[mockup]]), { error: 'outputs[0] must be an object' });
  assert.deepEqual(parseStepOutputs([{ ...mockup, name: '  ' }]), { error: 'outputs[0].name is required' });
  assert.deepEqual(parseStepOutputs([{ ...mockup, name: 3 }]), { error: 'outputs[0].name is required' });
  assert.deepEqual(parseStepOutputs([mockup, { name: 'b', format: 'html' }]), { error: 'outputs[1].content must be a string' });
});
