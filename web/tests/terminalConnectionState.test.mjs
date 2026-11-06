import assert from 'node:assert/strict';
import { test } from 'node:test';

const { INITIAL_TERMINAL_CONNECTION_STATE, reduceTerminalConnectionState } = await import('../src/lib/terminalConnectionState.ts');

test('a delayed error from the Strict Mode cleanup socket cannot cover a healthy replacement', () => {
  let state = reduceTerminalConnectionState(INITIAL_TERMINAL_CONNECTION_STATE, { type: 'start', connectionId: 1 });
  state = reduceTerminalConnectionState(state, { type: 'start', connectionId: 2 });
  state = reduceTerminalConnectionState(state, { type: 'error', connectionId: 1, message: 'stale failure' });
  assert.deepEqual(state, { connectionId: 2, error: '' });
});

test('the current connection reports real errors and clears them when it opens', () => {
  let state = reduceTerminalConnectionState(INITIAL_TERMINAL_CONNECTION_STATE, { type: 'start', connectionId: 1 });
  state = reduceTerminalConnectionState(state, { type: 'error', connectionId: 1, message: 'failed' });
  assert.equal(state.error, 'failed');
  state = reduceTerminalConnectionState(state, { type: 'open', connectionId: 1 });
  assert.equal(state.error, '');
});
