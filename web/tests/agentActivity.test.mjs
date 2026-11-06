import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentMessageText, describeActivity, isUsageLimitEvent } from '../src/lib/agentActivity.ts';

test('tool calls and results have readable labels and preserve multiline output', () => {
  const tools = new Map();
  const call = describeActivity(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: '1', name: 'Bash', input: { command: 'npm test' } }] } }), tools);
  assert.equal(call[0].title, 'Using Bash');
  assert.equal(call[0].text, 'Command\nnpm test');
  const result = describeActivity(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: '1', is_error: true, content: [{ type: 'text', text: 'Failure\nDetails' }] }] } }), tools);
  assert.equal(result[0].title, 'Bash failed');
  assert.equal(result[0].text, 'Failure\nDetails');
});

test('messages, structured results, and malformed events remain readable', () => {
  assert.equal(describeActivity('plain output', new Map())[0].text, 'plain output');
  assert.equal(describeActivity(JSON.stringify({ type: 'result', structured_output: { message: 'Finished' } }), new Map())[0].text, 'Message: Finished');
  assert.equal(describeActivity(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '**Updated** the file.' }] } }), new Map())[0].text, '**Updated** the file.');
});

test('Codex messages and commands render readable activity', () => {
  assert.deepEqual(describeActivity(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }), new Map()), [{ title: 'Agent message', text: 'Done', code: false }]);
  const command = describeActivity(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', aggregated_output: 'passed' } }), new Map())[0];
  assert.equal(command.text, 'npm test\npassed');
  assert.equal(command.code, true);
});

test('agentMessageText extracts a pure text agent message from Claude and Codex events', () => {
  assert.equal(agentMessageText(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '**Updated** the file.' }] } })), '**Updated** the file.');
  assert.equal(agentMessageText(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Part one' }, { type: 'text', text: 'Part two' }] } })), 'Part one\n\nPart two');
  assert.equal(agentMessageText(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } })), 'Done');
});

test('agentMessageText returns null for events that are not a pure agent message', () => {
  // Mixed with tool activity — stays inside the collapsed tool-run rather than becoming a bubble.
  assert.equal(agentMessageText(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Running it now' }, { type: 'tool_use', id: '1', name: 'Bash', input: {} }] } })), null);
  assert.equal(agentMessageText(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } })), null);
  assert.equal(agentMessageText(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: '1', content: 'ok' }] } })), null);
  assert.equal(agentMessageText(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test' } })), null);
  assert.equal(agentMessageText('not json'), null);
});

test('isUsageLimitEvent recognizes a raw rate_limit_event and nothing else', () => {
  assert.equal(isUsageLimitEvent(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} })), true);
  assert.equal(isUsageLimitEvent(JSON.stringify({ type: 'assistant', message: { content: [] } })), false);
  assert.equal(isUsageLimitEvent('not json'), false);
});
