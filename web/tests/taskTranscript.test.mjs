import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports (taskTranscript.ts
// now imports agentMessageText from agentActivity.ts as a value, not just a type).
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
const { groupTranscriptSegments } = await import('../src/lib/taskTranscript.ts');

const turn = (role, content, at = '2024-01-01T00:00:00.000Z') => ({ role, content, at });

test('a transcript with no raw-event turns is just a run of bubble segments', () => {
  const turns = [turn('prompt', 'hi'), turn('result', 'hello')];
  const segments = groupTranscriptSegments(turns);
  assert.deepEqual(segments, [
    { kind: 'bubble', turn: turns[0] },
    { kind: 'bubble', turn: turns[1] },
  ]);
});

test('interleaves bubble, tool-run, bubble, bubble, tool-run, bubble in original order', () => {
  const prompt1 = turn('prompt', 'do the thing');
  const event1 = turn('raw-event', '{"tool":"a"}');
  const event2 = turn('raw-event', '{"tool":"b"}');
  const answer1 = turn('result', 'done');
  const prompt2 = turn('answer', 'now do another thing');
  const event3 = turn('raw-event', '{"tool":"c"}');
  const answer2 = turn('result', 'done again');

  const segments = groupTranscriptSegments([prompt1, event1, event2, answer1, prompt2, event3, answer2]);

  assert.deepEqual(segments, [
    { kind: 'bubble', turn: prompt1 },
    { kind: 'tool-run', turns: [event1, event2] },
    { kind: 'bubble', turn: answer1 },
    { kind: 'bubble', turn: prompt2 },
    { kind: 'tool-run', turns: [event3] },
    { kind: 'bubble', turn: answer2 },
  ]);
});

test('two chat turns with zero raw-events between them produce no tool-run segment', () => {
  const prompt = turn('prompt', 'hi');
  const answer = turn('result', 'hello');
  const segments = groupTranscriptSegments([prompt, answer]);
  assert.equal(segments.length, 2);
  assert.ok(segments.every((s) => s.kind === 'bubble'), 'no tool-run segment should be inserted between them');
});

test('a raw-event run at the very start of the transcript becomes the first segment', () => {
  const event1 = turn('raw-event', '{"tool":"a"}');
  const event2 = turn('raw-event', '{"tool":"b"}');
  const answer = turn('result', 'done');
  const segments = groupTranscriptSegments([event1, event2, answer]);
  assert.deepEqual(segments, [
    { kind: 'tool-run', turns: [event1, event2] },
    { kind: 'bubble', turn: answer },
  ]);
});

test('a raw-event run at the very end of the transcript becomes the last segment', () => {
  const prompt = turn('prompt', 'hi');
  const event1 = turn('raw-event', '{"tool":"a"}');
  const event2 = turn('raw-event', '{"tool":"b"}');
  const segments = groupTranscriptSegments([prompt, event1, event2]);
  assert.deepEqual(segments, [
    { kind: 'bubble', turn: prompt },
    { kind: 'tool-run', turns: [event1, event2] },
  ]);
});

test('multiple consecutive raw-event runs separated by bubbles stay as separate tool-run segments', () => {
  const a = turn('raw-event', '{"tool":"a"}');
  const b = turn('raw-event', '{"tool":"b"}');
  const mid = turn('result', 'midway update');
  const c = turn('raw-event', '{"tool":"c"}');
  const segments = groupTranscriptSegments([a, b, mid, c]);
  assert.deepEqual(segments, [
    { kind: 'tool-run', turns: [a, b] },
    { kind: 'bubble', turn: mid },
    { kind: 'tool-run', turns: [c] },
  ]);
});

test('an empty transcript produces no segments', () => {
  assert.deepEqual(groupTranscriptSegments([]), []);
});

test('a pure agent-message raw-event becomes its own segment and breaks a surrounding tool-run', () => {
  const event1 = turn('raw-event', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: '1', name: 'Bash', input: {} }] } }));
  const message = turn('raw-event', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking into it now.' }] } }));
  const event2 = turn('raw-event', JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: '1', content: 'ok' }] } }));

  const segments = groupTranscriptSegments([event1, message, event2]);

  assert.deepEqual(segments, [
    { kind: 'tool-run', turns: [event1] },
    { kind: 'agent-message', turn: message, text: 'Looking into it now.' },
    { kind: 'tool-run', turns: [event2] },
  ]);
});

test('a Codex agent_message raw-event also becomes its own segment', () => {
  const message = turn('raw-event', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done with that.' } }));
  assert.deepEqual(groupTranscriptSegments([message]), [{ kind: 'agent-message', turn: message, text: 'Done with that.' }]);
});

test('a raw-event mixing text with tool activity stays collapsed rather than becoming an agent-message', () => {
  const mixed = turn('raw-event', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'About to run it' }, { type: 'tool_use', id: '1', name: 'Bash', input: {} }] } }));
  assert.deepEqual(groupTranscriptSegments([mixed]), [{ kind: 'tool-run', turns: [mixed] }]);
});
