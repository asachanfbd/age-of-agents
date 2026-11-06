import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnInProcessGroup } from '../src/commands/processGroup.ts';

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('kill() stops a grandchild the shell forked, not just the shell', async () => {
  // `sleep 60 & echo $!; wait` — the shell prints the background sleep's pid, then waits on it.
  const child = spawnInProcessGroup('sleep 60 & echo $!; wait', { cwd: process.cwd(), env: process.env });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  await waitUntil(() => /\d+\n/.test(output));
  const grandchild = Number(output.trim());
  assert.ok(isAlive(grandchild));

  child.kill();
  await waitUntil(() => !isAlive(grandchild));
});

test('kill() after the process has closed is a harmless no-op', async () => {
  const child = spawnInProcessGroup('true', { cwd: process.cwd(), env: process.env });
  await new Promise((resolve) => child.on('close', resolve));
  assert.doesNotThrow(() => child.kill());
});
