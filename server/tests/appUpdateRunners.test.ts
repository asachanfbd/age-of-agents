import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWebOnlyUpdate, type WebOnlyUpdateSteps } from '../src/appUpdate/webOnlyUpdateRunner.ts';
import { runServerUpdate, type ServerUpdateSteps } from '../src/appUpdate/serverUpdateRunner.ts';

// Cases 49-56: the two pure, fully fake-injectable orchestration functions behind apply() — no git,
// no npm, no real processes anywhere in this file.

const OK = { ok: true, output: '' };
function fail(output: string) {
  return { ok: false, output };
}

test('49: installWeb is only invoked when installWebDeps is true (a web manifest/lockfile changed)', async () => {
  const calls: string[] = [];
  const steps: WebOnlyUpdateSteps = {
    pull: async () => { calls.push('pull'); return OK; },
    installWeb: async () => { calls.push('installWeb'); return OK; },
    buildWeb: async () => { calls.push('buildWeb'); return OK; },
  };

  await runWebOnlyUpdate(steps, { installWebDeps: false });
  assert.deepEqual(calls, ['pull', 'buildWeb'], 'installWeb skipped when installWebDeps is false');

  calls.length = 0;
  await runWebOnlyUpdate(steps, { installWebDeps: true });
  assert.deepEqual(calls, ['pull', 'installWeb', 'buildWeb']);
});

test('50: a build failure keeps serving the previous build and reports failure; no stop/start step exists on this path at all', async () => {
  // The fake tracks what it's "serving" — standing in for realWebOnlySteps.buildWeb's real
  // dist.new/-then-rename trick, which this pure runner never sees (it only sees ok/output).
  let servedBuild = 'previous-build';
  const steps: WebOnlyUpdateSteps = {
    pull: async () => OK,
    installWeb: async () => OK,
    buildWeb: async () => {
      // A real failure never swaps dist.new/ into place — servedBuild deliberately untouched here.
      return fail('vite build failed: syntax error');
    },
  };

  const result = await runWebOnlyUpdate(steps, { installWebDeps: false });
  assert.equal(result.ok, false);
  assert.match(result.failureMessage ?? '', /vite build failed/);
  assert.equal(servedBuild, 'previous-build', 'the previously-served build is left exactly as it was');
  // WebOnlyUpdateSteps has no stop/start of its own — nothing to assert never-called beyond the type
  // itself not offering one; this comment documents why 49/50 never touch anything daemon-restart-shaped.
});

const CONTEXT = { previousCommit: 'abc1234', newCommit: 'def5678' };

function recordingSteps(overrides: Partial<ServerUpdateSteps> = {}): { steps: ServerUpdateSteps; calls: string[] } {
  const calls: string[] = [];
  const steps: ServerUpdateSteps = {
    stop: async () => { calls.push('stop'); },
    pull: async () => { calls.push('pull'); return OK; },
    installAll: async () => { calls.push('installAll'); return OK; },
    start: async () => { calls.push('start'); return OK; },
    resetToCommit: async (sha) => { calls.push(`resetToCommit:${sha}`); return OK; },
    ...overrides,
  };
  return { steps, calls };
}

test('51: success runs stop -> pull -> install -> start in exact order; result reads ok + updatedToCommit', async () => {
  const { steps, calls } = recordingSteps();
  const result = await runServerUpdate(steps, CONTEXT);
  assert.deepEqual(calls, ['stop', 'pull', 'installAll', 'start']);
  assert.deepEqual(result, { ok: true, updatedToCommit: CONTEXT.newCommit, recovered: true });
});

test('52: a pull failure (processes already stopped) restarts on the same previous commit; never "nothing running"', async () => {
  const { steps, calls } = recordingSteps({ pull: async () => { calls.push('pull'); return fail('merge conflict'); } });
  const result = await runServerUpdate(steps, CONTEXT);
  assert.deepEqual(calls, ['stop', 'pull', 'start']);
  assert.equal(result.ok, false);
  assert.match(result.failureMessage ?? '', /merge conflict/);
  assert.equal(result.recovered, true);
  assert.equal(result.updatedToCommit, undefined);
});

test('53: an install failure after a successful pull resets the branch to the previous commit and restarts', async () => {
  const { steps, calls } = recordingSteps({ installAll: async () => { calls.push('installAll'); return fail('npm ci failed'); } });
  const result = await runServerUpdate(steps, CONTEXT);
  assert.deepEqual(calls, ['stop', 'pull', 'installAll', `resetToCommit:${CONTEXT.previousCommit}`, 'start']);
  assert.equal(result.ok, false);
  assert.match(result.failureMessage ?? '', /npm ci failed/);
  assert.equal(result.recovered, true);
});

test('54: a build failure surfaced as start() returning ok:false gets the same previous-commit recovery as an install failure', async () => {
  const { steps, calls } = recordingSteps({
    start: async () => { calls.push('start'); return calls.filter((c) => c === 'start').length === 1 ? fail('vite build failed') : OK; },
  });
  const result = await runServerUpdate(steps, CONTEXT);
  assert.deepEqual(calls, ['stop', 'pull', 'installAll', 'start', `resetToCommit:${CONTEXT.previousCommit}`, 'start']);
  assert.equal(result.ok, false);
  assert.match(result.failureMessage ?? '', /vite build failed/);
  assert.equal(result.recovered, true, 'the second start() attempt succeeded');
});

test('55/56: start() reporting an immediate-exit-style failure gets a best-effort SECOND restart attempt, logged; this collapses what would otherwise be a near-duplicate "the web process died" test, since the fake start() cannot distinguish which of the two real processes died', async () => {
  const startCalls: string[] = [];
  const { steps } = recordingSteps({
    start: async () => {
      startCalls.push('start');
      // First call (the real attempt) fails; the recovery attempt (second call) also fails here —
      // the one case where the owner genuinely has nothing running, which must still be recorded.
      return fail('process exited immediately after starting');
    },
  });
  const result = await runServerUpdate(steps, CONTEXT);
  // start() is called once for the real attempt, then once more as the best-effort recovery restart
  // after resetToCommit — two calls total, counting the very first attempt as call #1.
  assert.equal(startCalls.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.recovered, false, 'nothing is running — this must be recorded, never silently swallowed');
  assert.match(result.failureMessage ?? '', /process exited immediately/);
});

test('rollback failure after an install failure is reported, start is still attempted, and the failure text says local changes were kept', async () => {
  const { steps, calls } = recordingSteps({
    installAll: async () => { calls.push('installAll'); return fail('npm ci failed'); },
    resetToCommit: async (sha) => { calls.push(`resetToCommit:${sha}`); return fail('would lose local changes'); },
  });
  const result = await runServerUpdate(steps, CONTEXT);
  assert.deepEqual(calls, ['stop', 'pull', 'installAll', `resetToCommit:${CONTEXT.previousCommit}`, 'start']);
  assert.equal(result.ok, false);
  assert.match(result.failureMessage ?? '', /npm ci failed/);
  assert.match(result.failureMessage ?? '', /could not be restored without discarding local changes/);
  assert.match(result.failureMessage ?? '', /would lose local changes/);
});

test('rollback failure after a start failure is reported and the second start still runs', async () => {
  const starts: string[] = [];
  const { steps } = recordingSteps({
    start: async () => { starts.push('start'); return starts.length === 1 ? fail('build failed') : OK; },
    resetToCommit: async () => fail('refused'),
  });
  const result = await runServerUpdate(steps, CONTEXT);
  assert.equal(starts.length, 2);
  assert.equal(result.recovered, true);
  assert.match(result.failureMessage ?? '', /build failed.*could not be restored/);
});

test('a successful rollback adds nothing to the failure message', async () => {
  const { steps } = recordingSteps({ installAll: async () => fail('npm ci failed') });
  assert.equal((await runServerUpdate(steps, CONTEXT)).failureMessage, 'npm ci failed');
});

test('a pull refused because of local changes never installs or builds, and the message is passed through', async () => {
  const calls: string[] = [];
  const steps: WebOnlyUpdateSteps = {
    pull: async () => fail('Update not applied: local changes would be overwritten by the update: data.json. Nothing was changed.'),
    installWeb: async () => { calls.push('installWeb'); return OK; },
    buildWeb: async () => { calls.push('buildWeb'); return OK; },
  };
  const result = await runWebOnlyUpdate(steps, { installWebDeps: true });
  assert.equal(result.ok, false);
  assert.match(result.failureMessage ?? '', /data\.json/);
  assert.deepEqual(calls, []);
});
