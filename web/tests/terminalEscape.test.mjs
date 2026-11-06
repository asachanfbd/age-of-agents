import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const { isTaskTerminalTarget } = await import('../src/lib/terminalEscape.ts');

test('Escape from the CLI terminal is kept for the terminal, including its focused input', () => {
  const terminalInput = { closest: (selector) => selector === '[data-task-terminal]' ? {} : null };
  assert.equal(isTaskTerminalTarget(terminalInput), true);
});

test('Escape outside the CLI terminal can still dismiss the workspace', () => {
  assert.equal(isTaskTerminalTarget({ closest: () => null }), false);
  assert.equal(isTaskTerminalTarget(null), false);
  assert.equal(isTaskTerminalTarget({}), false);
});

test('the workspace prevents terminal Escape dismissal while xterm still sends input to the CLI', async () => {
  const [workspace, terminal] = await Promise.all([
    readFile(new URL('../src/ui/ProjectWorkspaceModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/TaskTerminal.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(workspace, /onEscapeKeyDown=\{\(event\) => \{\s*if \(isTaskTerminalTarget\(event\.target\)\) event\.preventDefault\(\);/);
  assert.match(terminal, /<div data-task-terminal\b/);
  // Input goes through the connection, which always writes to its current (possibly reconnected) socket.
  assert.match(terminal, /terminal\.onData\(\(data\) => link\.send\(\{ type: 'input', data \}\)\)/);
  assert.match(terminal, /isOpen: \(\) => socket\.readyState === WebSocket\.OPEN/);
});
