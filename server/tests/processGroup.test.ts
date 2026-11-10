import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { STOP_GRACE_MS, spawnInProcessGroup, terminateProcessGroup } from '../src/commands/processGroup.ts';

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

test('terminateProcessGroup signals the group with SIGTERM, then SIGKILL after the grace period', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: Array<[number, string | number | undefined]> = [];
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => { signals.push([pid, signal]); return true; });
  terminateProcessGroup(4242);
  assert.deepEqual(signals, [[-4242, 'SIGTERM']]);
  t.mock.timers.tick(STOP_GRACE_MS);
  assert.deepEqual(signals, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
});

test('terminateProcessGroup is harmless when the group is already gone', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); });
  assert.doesNotThrow(() => { terminateProcessGroup(4242); t.mock.timers.tick(STOP_GRACE_MS); });
});

test('terminateProcessGroup kills a real background child the group leader started', async () => {
  const child = spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], { detached: true });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  await waitUntil(() => /\d+\n/.test(output));
  const grandchild = Number(output.trim());
  assert.ok(isAlive(grandchild));
  terminateProcessGroup(child.pid!);
  await waitUntil(() => !isAlive(grandchild));
});
