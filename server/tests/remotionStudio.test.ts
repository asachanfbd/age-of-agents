import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import type { ContentCtx } from '../src/content/context.ts';
import { openContentDb, writeMeta } from '../src/content/db.ts';
import { contentJobs } from '../src/content/jobs.ts';
import type { ContentJob, ContentJobEvent } from '../src/content/jobs.ts';
import { STUDIO_LOG_EVENT_MS, STUDIO_LOG_LINE_MAX, STUDIO_LOG_LINES } from '../src/content/limits.ts';
import { archiveConceptCode, existingCompositionId, removeConceptFromProject, scaffoldConcept, scaffoldProject } from '../src/content/remotionProject.ts';
import {
  createRemotionStudios, findFreePort, isReadyLine, NEEDS_VIDEO_SESSION, READ_ONLY_NEEDS_INSTALL, remotionStudioSpawner, stripAnsi,
} from '../src/content/remotionStudio.ts';
import type { StudioDeps, StudioEvent, StudioSpawnRequest } from '../src/content/remotionStudio.ts';
import type { SetupView } from '../src/content/remotionProject.ts';
import { gate, waitFor } from './helpers/videoFakes.ts';

/**
 * Remotion Studio's process lifecycle (`content/remotionStudio.ts`) with a fake spawner, port finder, install and timer: no real
 * Studio runs. Case ids follow the Test Case Planning list (RS-U01…).
 */

const roots: string[] = [];
after(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }); });
const unsubscribes: (() => void)[] = [];
afterEach(() => { for (const u of unsubscribes.splice(0)) u(); });

const IDLE = 600_000;
const START_TIMEOUT = 120_000;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** A Building folder; `project` writes the scaffold's entry file, which is what "the project exists" means. */
async function building(project = true): Promise<ContentCtx> {
  const dir = await mkdtemp(path.join(tmpdir(), 'remotion-studio-'));
  roots.push(dir);
  if (project) { await mkdir(path.join(dir, 'remotion', 'src'), { recursive: true }); await writeFile(path.join(dir, 'remotion', 'src', 'index.ts'), '// entry\n'); }
  return { db: openContentDb(':memory:'), buildingId: `b-${path.basename(dir)}`, dir, now: () => Date.now(), timezone: () => 'UTC', exclusive: (w) => w() };
}

/** Virtual time: timers fire only when the test advances it. */
function fakeTimers() {
  let now = 0;
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    setTimer(fn: () => void, ms: number) { const t = { at: now + ms, fn }; timers.add(t); return () => { timers.delete(t); }; },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        now = next.at;
        next.fn();
      }
      now = end;
    },
    get pending() { return timers.size; },
  };
}

interface FakeChild { request: StudioSpawnRequest; kills: number }
function harness(patch: Partial<StudioDeps> = {}, setup: { status: SetupView['status']; error?: string } = { status: 'ready' }) {
  const timers = fakeTimers();
  const children: FakeChild[] = [];
  let nextPort = 3047;
  const setupState = { ...setup, ensures: 0, gate: null as ReturnType<typeof gate> | null, result: true };
  const deps: StudioDeps = {
    spawner: { spawn(request) { const child = { request, kills: 0 }; children.push(child); return { kill: () => { child.kills++; } }; } },
    findPort: async () => nextPort++,
    setTimer: (fn, ms) => timers.setTimer(fn, ms),
    setup: {
      view: () => ({ status: setupState.status, error: setupState.error ?? null, percent: null }),
      async ensure() {
        setupState.ensures++;
        if (setupState.gate) await setupState.gate.promise;
        setupState.status = setupState.result ? 'ready' : 'failed';
        return setupState.result;
      },
    },
    startTimeoutMs: START_TIMEOUT,
    idleMs: IDLE,
    ...patch,
  };
  const studios = createRemotionStudios(deps);
  const events: StudioEvent[] = [];
  unsubscribes.push(studios.onEvent((e) => events.push(e)));
  const ready = (child: FakeChild) => child.request.onOutput(`Server ready - Local: http://localhost:${child.request.port}, Network: http://192.168.1.4:${child.request.port}\n`, 'stdout');
  return { studios, timers, children, setup: setupState, events, ready };
}

function jobEvents() {
  const seen: ContentJobEvent[] = [];
  unsubscribes.push(contentJobs.on((e) => seen.push(e)));
  return seen;
}
const studioJobs = (buildingId: string): ContentJob[] => contentJobs.list().filter((j) => j.kind === 'remotion-studio' && j.buildingId === buildingId);
const status = (fn: () => unknown): number | 'ok' => { try { fn(); return 'ok'; } catch (e) { return (e as { status: number }).status; } };

// ---- start, reuse, ports ---------------------------------------------------------------------------

test('RS-U01 a start from stopped spawns once in the Remotion folder on the found port, starting with no url', async () => {
  const h = harness();
  const ctx = await building();
  const view = h.studios.start(ctx, { readOnly: false });
  assert.deepEqual(view, { state: 'starting', url: null, error: null, log: [], waitingForSetup: false });
  await flush();
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0]!.request.dir, path.join(ctx.dir, 'remotion'));
  assert.equal(h.children[0]!.request.port, 3047);
  h.studios.stop(ctx.buildingId);
});

test('RS-U02 the ready line makes it running at http://127.0.0.1:<port>', async () => {
  const h = harness();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  h.ready(h.children[0]!);
  assert.deepEqual({ ...h.studios.view(ctx.buildingId), log: [] }, { state: 'running', url: 'http://127.0.0.1:3047', error: null, log: [], waitingForSetup: false });
  h.studios.stop(ctx.buildingId);
});

test('RS-U03 a start while running reuses the process', async () => {
  const h = harness();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  h.ready(h.children[0]!);
  const again = h.studios.start(ctx, { readOnly: false });
  await flush();
  assert.equal(h.children.length, 1);
  assert.equal(again.url, 'http://127.0.0.1:3047');
  h.studios.stop(ctx.buildingId);
});

test('RS-U04 a second start while the first waits for its port gives one spawn', async () => {
  const port = gate();
  const h = harness({ findPort: async () => { await port.promise; return 4000; } });
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  h.studios.start(ctx, { readOnly: false });
  port.open();
  await flush();
  assert.equal(h.children.length, 1);
  h.studios.stop(ctx.buildingId);
});

test('RS-U05 two Buildings get two processes on distinct ports; stopping one leaves the other', async () => {
  const h = harness();
  const [a, b] = [await building(), await building()];
  h.studios.start(a, { readOnly: false });
  h.studios.start(b, { readOnly: false });
  await flush();
  assert.equal(h.children.length, 2);
  assert.notEqual(h.children[0]!.request.port, h.children[1]!.request.port);
  h.ready(h.children[0]!); h.ready(h.children[1]!);
  h.studios.stop(a.buildingId);
  assert.equal(h.studios.view(a.buildingId).state, 'stopped');
  assert.equal(h.studios.view(b.buildingId).state, 'running');
  assert.equal(h.children[1]!.kills, 0);
  h.studios.stop(b.buildingId);
});

// ---- the log -----------------------------------------------------------------------------------

test('RS-U06 log lines: split chunks are joined, CRLF ends a line, both streams are kept, colours are removed', async () => {
  const h = harness();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  const { onOutput } = h.children[0]!.request;
  onOutput('Buil', 'stdout');
  onOutput('ding... 34%\r\n', 'stdout');
  onOutput('\x1b[33mwarn\x1b[39m big bundle\n', 'stderr');
  assert.deepEqual(h.studios.view(ctx.buildingId).log, ['Building... 34%', 'warn big bundle']);
  h.studios.stop(ctx.buildingId);
});

test('RS-U07/RS-U08 the log keeps the newest 200 lines, each cut to 2,000 characters', async () => {
  const h = harness();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  const lines = Array.from({ length: STUDIO_LOG_LINES + 1 }, (_, i) => `line ${i}`);
  h.children[0]!.request.onOutput(`${lines.join('\n')}\n${'x'.repeat(STUDIO_LOG_LINE_MAX + 50)}\n`, 'stdout');
  const log = h.studios.view(ctx.buildingId).log;
  assert.equal(log.length, STUDIO_LOG_LINES);
  assert.equal(log[0], 'line 2');
  assert.equal(log.at(-1)!.length, STUDIO_LOG_LINE_MAX);
  h.studios.stop(ctx.buildingId);
});

// ---- failures ----------------------------------------------------------------------------------------

test('RS-U09 an exit before ready fails with the exit code, keeps the log and ends the job failed', async () => {
  const h = harness();
  const seen = jobEvents();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  h.children[0]!.request.onOutput("Error: Cannot find module './concepts/registry'\n", 'stderr');
  h.children[0]!.request.onExit(1);
  const view = h.studios.view(ctx.buildingId);
  assert.equal(view.state, 'failed');
  assert.match(view.error!, /exited with code 1 before it was ready/);
  assert.deepEqual(view.log, ["Error: Cannot find module './concepts/registry'"]);
  assert.equal(seen.filter((e) => e.job.buildingId === ctx.buildingId).at(-1)!.job.status, 'failed');
  assert.deepEqual(studioJobs(ctx.buildingId), []);
});

test('RS-U10 a spawn error fails with its message; the caller does not throw', async () => {
  const ctx = await building();
  const thrown = harness({ spawner: { spawn() { throw new Error('spawn remotion ENOENT'); } } });
  assert.doesNotThrow(() => thrown.studios.start(ctx, { readOnly: false }));
  await flush();
  assert.deepEqual([thrown.studios.view(ctx.buildingId).state, thrown.studios.view(ctx.buildingId).error], ['failed', 'Remotion Studio could not start: spawn remotion ENOENT']);
  const reported = harness();
  const other = await building();
  reported.studios.start(other, { readOnly: false });
  await flush();
  reported.children[0]!.request.onExit(null, new Error('spawn remotion ENOENT'));
  assert.equal(reported.studios.view(other.buildingId).error, 'Remotion Studio could not start: spawn remotion ENOENT');
});

test('RS-U11 a port finder that throws or returns no valid port fails with no spawn', async () => {
  for (const bad of [() => { throw new Error('EADDRINUSE'); }, () => 0, () => 65_536, () => 1.5, () => Number.NaN]) {
    const h = harness({ findPort: async () => bad() });
    const ctx = await building();
    h.studios.start(ctx, { readOnly: false });
    await flush();
    assert.equal(h.children.length, 0);
    assert.equal(h.studios.view(ctx.buildingId).state, 'failed');
    assert.match(h.studios.view(ctx.buildingId).error!, /No free port/);
  }
});

test('RS-U12 no ready line within the start timeout kills it and fails; ready 1 ms before is running', async () => {
  const late = harness();
  const ctx = await building();
  late.studios.start(ctx, { readOnly: false });
  await flush();
  late.timers.advance(START_TIMEOUT);
  assert.equal(late.children[0]!.kills, 1);
  assert.match(late.studios.view(ctx.buildingId).error!, /did not start within 120 seconds/);
  const inTime = harness();
  const other = await building();
  inTime.studios.start(other, { readOnly: false });
  await flush();
  inTime.timers.advance(START_TIMEOUT - 1);
  inTime.ready(inTime.children[0]!);
  inTime.timers.advance(1);
  assert.equal(inTime.studios.view(other.buildingId).state, 'running');
  inTime.studios.stop(other.buildingId);
});

test('RS-U13 a crash after running fails with no url and cancels the idle timer', async () => {
  const h = harness();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  h.ready(h.children[0]!);
  h.children[0]!.request.onExit(137);
  const view = h.studios.view(ctx.buildingId);
  assert.deepEqual([view.state, view.url], ['failed', null]);
  assert.match(view.error!, /stopped unexpectedly \(exit code 137\)/);
  assert.equal(h.timers.pending, 0);
});

test('RS-U14 Retry after a failure spawns again with the log and error cleared', async () => {
  const h = harness();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  h.children[0]!.request.onOutput('boom\n', 'stderr');
  h.children[0]!.request.onExit(1);
  const retried = h.studios.start(ctx, { readOnly: false });
  assert.deepEqual([retried.state, retried.error, retried.log], ['starting', null, []]);
  await flush();
  assert.equal(h.children.length, 2);
  h.studios.stop(ctx.buildingId);
});

// ---- stop ----------------------------------------------------------------------------------------

test('RS-U15 Stop while running kills it, is stopped with no url, and ends the job stopped', async () => {
  const h = harness();
  const seen = jobEvents();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  h.ready(h.children[0]!);
  const view = h.studios.stop(ctx.buildingId);
  assert.deepEqual([view.state, view.url, h.children[0]!.kills], ['stopped', null, 1]);
  assert.equal(seen.filter((e) => e.job.buildingId === ctx.buildingId).at(-1)!.job.status, 'stopped');
  assert.equal(h.timers.pending, 0);
});

test('RS-U16 Stop while starting kills it; a late ready or exit of that child is ignored', async () => {
  const h = harness();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  h.studios.stop(ctx.buildingId);
  h.ready(h.children[0]!);
  h.children[0]!.request.onExit(1);
  assert.equal(h.studios.view(ctx.buildingId).state, 'stopped');
  assert.equal(h.studios.view(ctx.buildingId).error, null);
});

test('RS-U17 Stop when stopped is a no-op: no kill, no event', async () => {
  const h = harness();
  const ctx = await building();
  assert.equal(h.studios.stop(ctx.buildingId).state, 'stopped');
  assert.deepEqual(h.events, []);
});

// ---- idle stop --------------------------------------------------------------------------------

test('RS-U18 with no heartbeat it runs at 599,999 ms and stops at exactly 600,000 ms after start', async () => {
  const h = harness({ startTimeoutMs: 10 * IDLE });
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  h.ready(h.children[0]!);
  h.timers.advance(IDLE - 1);
  assert.equal(h.studios.view(ctx.buildingId).state, 'running');
  h.timers.advance(1);
  assert.equal(h.studios.view(ctx.buildingId).state, 'stopped');
  assert.equal(h.children[0]!.kills, 1);
});

test('RS-U19 a heartbeat at 9 minutes moves the stop to 19 minutes', async () => {
  const h = harness();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  h.ready(h.children[0]!);
  h.timers.advance(9 * 60_000);
  h.studios.heartbeat(ctx.buildingId);
  h.timers.advance(10 * 60_000 - 1);
  assert.equal(h.studios.view(ctx.buildingId).state, 'running');
  h.timers.advance(1);
  assert.equal(h.studios.view(ctx.buildingId).state, 'stopped');
});

test('RS-U20 a heartbeat while starting resets the timer; while stopped or failed it starts nothing', async () => {
  const h = harness({ startTimeoutMs: 10 * IDLE });
  const ctx = await building();
  assert.equal(h.studios.heartbeat(ctx.buildingId).state, 'stopped');
  await flush();
  assert.equal(h.children.length, 0);
  h.studios.start(ctx, { readOnly: false });
  await flush();
  h.timers.advance(IDLE - 10);
  h.studios.heartbeat(ctx.buildingId);
  h.timers.advance(20);
  assert.equal(h.studios.view(ctx.buildingId).state, 'starting');
  h.children[0]!.request.onExit(1);
  assert.equal(h.studios.heartbeat(ctx.buildingId).state, 'failed');
  await flush();
  assert.equal(h.children.length, 1);
});

test('RS-U21 the idle stop counts on timers, not the wall clock: a clock at epoch 0, at 8.64e15 or stepping back changes nothing', async (t) => {
  for (const clock of [() => 0, () => 8.64e15, (() => { let n = 1e12; return () => (n -= 60_000); })()]) {
    t.mock.method(Date, 'now', clock);
    const h = harness();
    const ctx = await building();
    h.studios.start(ctx, { readOnly: false });
    await flush();
    h.ready(h.children[0]!);
    h.timers.advance(IDLE - 1);
    assert.equal(h.studios.view(ctx.buildingId).state, 'running');
    h.timers.advance(1);
    assert.equal(h.studios.view(ctx.buildingId).state, 'stopped');
    t.mock.restoreAll();
  }
});

// ---- the install and the project --------------------------------------------------------------

test('RS-U22 while the install runs it waits (starting, waitingForSetup), then spawns once', async () => {
  const h = harness({}, { status: 'running' });
  h.setup.gate = gate();
  const ctx = await building();
  assert.equal(h.studios.start(ctx, { readOnly: false }).waitingForSetup, true);
  await flush();
  assert.equal(h.children.length, 0);
  h.setup.gate.open();
  await flush();
  assert.equal(h.children.length, 1);
  assert.equal(h.studios.view(ctx.buildingId).waitingForSetup, false);
  h.studios.stop(ctx.buildingId);
});

test('RS-U23 a failed install while waiting fails with the setup error', async () => {
  const h = harness({}, { status: 'running', error: 'Remotion setup failed: npm ERR! network' });
  h.setup.result = false;
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  assert.deepEqual([h.studios.view(ctx.buildingId).state, h.studios.view(ctx.buildingId).error], ['failed', 'Remotion setup failed: npm ERR! network']);
  assert.equal(h.children.length, 0);
});

test('RS-U24 a writable Building that is not installed runs the install, then spawns', async () => {
  const h = harness({}, { status: 'none' });
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  assert.equal(h.setup.ensures, 1);
  assert.equal(h.children.length, 1);
  h.studios.stop(ctx.buildingId);
});

test('RS-U25 a read-only Building whose project needs an install (or is installing) is 409 with nothing installed or spawned', async () => {
  for (const s of ['none', 'running', 'failed'] as const) {
    const h = harness({}, { status: s });
    const ctx = await building();
    assert.equal(status(() => h.studios.start(ctx, { readOnly: true })), 409);
    assert.throws(() => h.studios.start(ctx, { readOnly: true }), { message: READ_ONLY_NEEDS_INSTALL });
    await flush();
    assert.deepEqual([h.setup.ensures, h.children.length, h.events.length], [0, 0, 0]);
  }
});

test('RS-U26 a read-only Building that is installed spawns', async () => {
  const h = harness();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: true });
  await flush();
  assert.equal(h.children.length, 1);
  h.studios.stop(ctx.buildingId);
});

test('RS-U27 no Remotion project yet is 409 with no install and no spawn', async () => {
  const h = harness({}, { status: 'none' });
  const ctx = await building(false);
  assert.throws(() => h.studios.start(ctx, { readOnly: false }), { status: 409, message: NEEDS_VIDEO_SESSION });
  await flush();
  assert.deepEqual([h.setup.ensures, h.children.length], [0, 0]);
});

test('RS-U28 the idle stop while waiting for the install means no spawn when it succeeds', async () => {
  const h = harness({}, { status: 'running' });
  h.setup.gate = gate();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  h.timers.advance(IDLE);
  assert.equal(h.studios.view(ctx.buildingId).state, 'stopped');
  h.setup.gate.open();
  await flush();
  assert.equal(h.children.length, 0);
});

// ---- Building deletion, shutdown, restart -------------------------------------------------------

test('RS-U29 deleting the Building: running is killed and forgotten; starting and waiting never spawn; the job ends', async () => {
  const h = harness();
  const running = await building();
  h.studios.start(running, { readOnly: false });
  await flush();
  h.ready(h.children[0]!);
  h.studios.forget(running.buildingId);
  assert.equal(h.children[0]!.kills, 1);
  assert.deepEqual(studioJobs(running.buildingId), []);
  assert.equal(h.studios.view(running.buildingId).state, 'stopped');

  const port = gate();
  const starting = harness({ findPort: async () => { await port.promise; return 5000; } });
  const s = await building();
  starting.studios.start(s, { readOnly: false });
  starting.studios.forget(s.buildingId);
  port.open();
  await flush();
  assert.equal(starting.children.length, 0);

  const waiting = harness({}, { status: 'running' });
  waiting.setup.gate = gate();
  const w = await building();
  waiting.studios.start(w, { readOnly: false });
  waiting.studios.forget(w.buildingId);
  waiting.setup.gate.open();
  await flush();
  assert.equal(waiting.children.length, 0);
  assert.deepEqual(studioJobs(w.buildingId), []);
});

test('RS-U30 killAll is synchronous and kills every live child across Buildings; a no-op with none', async () => {
  const h = harness();
  h.studios.killAll();
  const [a, b] = [await building(), await building()];
  h.studios.start(a, { readOnly: false });
  h.studios.start(b, { readOnly: false });
  await flush();
  h.ready(h.children[0]!);
  const result = h.studios.killAll();
  assert.equal(result, undefined);
  assert.deepEqual(h.children.map((c) => c.kills), [1, 1]);
  h.studios.stop(a.buildingId); h.studios.stop(b.buildingId);
});

test('RS-U31 a fresh instance (a daemon restart) reads stopped everywhere and spawns nothing', async () => {
  const h = harness();
  const ctx = await building();
  await flush();
  assert.deepEqual(h.studios.view(ctx.buildingId), { state: 'stopped', url: null, error: null, log: [], waitingForSetup: false });
  assert.equal(h.children.length, 0);
});

// ---- the job and the events -----------------------------------------------------------------------

test('RS-U32 the job begins as starting and reaches running at once, not held by the progress throttle', async () => {
  const h = harness();
  const seen = jobEvents();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  const [job] = studioJobs(ctx.buildingId);
  assert.deepEqual([job!.kind, job!.percent, job!.phase], ['remotion-studio', null, 'starting']);
  await flush();
  h.ready(h.children[0]!);
  const mine = seen.filter((e) => e.job.buildingId === ctx.buildingId);
  assert.deepEqual(mine.map((e) => [e.job.status, e.job.phase]), [['running', 'starting'], ['running', 'running']]);
  h.studios.stop(ctx.buildingId);
});

test('RS-U33 each state change is emitted once with the Building id; log-only events at most once a second', async () => {
  const h = harness();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  const out = h.children[0]!.request.onOutput;
  for (let i = 0; i < 20; i++) out(`Building... ${i}%\n`, 'stdout');
  assert.equal(h.events.length, 1, 'only the start so far');
  h.timers.advance(STUDIO_LOG_EVENT_MS);
  assert.equal(h.events.length, 2);
  assert.equal(h.events[1]!.studio.log.length, 20);
  h.ready(h.children[0]!);
  h.studios.stop(ctx.buildingId);
  assert.deepEqual(h.events.map((e) => [e.type, e.buildingId, e.studio.state]), [
    ['remotionStudio', ctx.buildingId, 'starting'], ['remotionStudio', ctx.buildingId, 'starting'], ['remotionStudio', ctx.buildingId, 'running'], ['remotionStudio', ctx.buildingId, 'stopped'],
  ]);
});

test('RS-U34 the view and its events carry no folder path, pid, environment or command line (the log aside)', async () => {
  const h = harness();
  const ctx = await building();
  h.studios.start(ctx, { readOnly: false });
  await flush();
  h.ready(h.children[0]!);
  for (const value of [h.studios.view(ctx.buildingId), ...h.events]) {
    const text = JSON.stringify(value, (key, v) => (key === 'log' ? undefined : v));
    for (const secret of [ctx.dir, path.dirname(ctx.dir), 'node_modules', 'NODE_OPTIONS', 'pid', '--port']) assert.ok(!text.includes(secret), secret);
  }
  h.studios.stop(ctx.buildingId);
});

// ---- the real pieces ------------------------------------------------------------------------------

test('RS-U35 the real port finder returns a port a server can then bind on 127.0.0.1, probing 127.0.0.1 only', async (t) => {
  const listen = t.mock.method(net.Server.prototype, 'listen');
  const port = await findFreePort();
  assert.equal(listen.mock.calls[0]!.arguments[1], '127.0.0.1');
  t.mock.restoreAll();
  assert.ok(Number.isInteger(port) && port >= 1 && port <= 65_535);
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  await new Promise((resolve) => server.close(resolve));
});

/** A stand-in `remotion` in `node_modules/.bin`: prints its arguments, folder and bind address, says it is ready, and starts a child. */
async function standInStudio(): Promise<{ dir: string; pidFile: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-bin-'));
  roots.push(root);
  const dir = path.join(root, 'remotion');
  const bin = path.join(dir, 'node_modules', '.bin');
  await mkdir(bin, { recursive: true });
  const pidFile = path.join(root, 'grandchild.pid');
  await writeFile(path.join(bin, 'remotion'), `#!/usr/bin/env node
const http = require('node:http');
const { spawn } = require('node:child_process');
const port = Number(process.argv.find((a) => a.startsWith('--port=')).slice(7));
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
const server = http.createServer((q, s) => s.end('studio')).listen(port, () => {
  console.log('ARGS ' + JSON.stringify(process.argv.slice(2)));
  console.log('CWD ' + process.cwd());
  console.log('ENV ' + process.env.NODE_ENV + ' ' + process.env.BROWSER);
  console.log('BOUND ' + server.address().address);
  console.log('\\x1b[1mServer ready\\x1b[22m - Local: \\x1b[4mhttp://localhost:' + port + '\\x1b[24m');
});
`);
  await chmod(path.join(bin, 'remotion'), 0o755);
  return { dir, pidFile };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('RS-U36 the real spawner: arguments, folder and env as planned, bound to 127.0.0.1 by the preload, and kill ends its children too', { skip: process.platform === 'win32' }, async () => {
  const { dir, pidFile } = await standInStudio();
  const port = await findFreePort();
  let out = '';
  let exited: number | null | undefined;
  const child = remotionStudioSpawner.spawn({ dir, port, onOutput: (text) => { out += text; }, onExit: (code) => { exited = code; } });
  await waitFor(() => out.includes('Server ready'), 'the ready line');
  const lines = out.split('\n');
  assert.deepEqual(JSON.parse(lines.find((l) => l.startsWith('ARGS '))!.slice(5)), ['studio', 'src/index.ts', `--port=${port}`, '--no-open', '--force-new']);
  assert.ok(lines.some((l) => l.startsWith('CWD ') && l.endsWith(path.basename(dir))));
  assert.ok(lines.includes('ENV development none'));
  assert.ok(lines.includes('BOUND 127.0.0.1'));
  assert.ok(lines.some((l) => isReadyLine(l, port)));
  const { readFileSync } = await import('node:fs');
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(grandchild));
  child.kill();
  await waitFor(() => exited !== undefined, 'the stand-in to exit');
  await waitFor(() => !alive(grandchild), 'its child to end');
  child.kill();
});

test('RS-U36 (preload) every listen form of a preloaded process binds 127.0.0.1', { skip: process.platform === 'win32' }, async () => {
  const preload = path.join(import.meta.dirname, '..', 'src', 'content', 'studioLoopback.cjs');
  const script = `
    const net = require('node:net');
    const forms = [(s, cb) => s.listen(0, '0.0.0.0', cb), (s, cb) => s.listen(0, cb), (s, cb) => s.listen({ port: 0, host: '::' }, cb), (s, cb) => s.listen(cb), (s, cb) => s.listen('0', 5, cb), (s, cb) => s.listen()];
    (async () => {
      const out = [];
      for (const form of forms) {
        const s = net.createServer();
        await new Promise((r) => { form(s, r); s.once('listening', r); });
        out.push(s.address().address);
        s.close();
      }
      console.log(JSON.stringify(out));
    })();`;
  const result = await new Promise<string>((resolve, reject) => {
    const p = spawnProcess(process.execPath, ['--require', preload, '-e', script]);
    let text = '';
    p.stdout.on('data', (d) => { text += d; });
    p.on('error', reject);
    p.on('close', () => resolve(text));
  });
  assert.deepEqual(JSON.parse(result), Array(6).fill('127.0.0.1'));
});

test('RS-U37 the ready-line parser: the Remotion line, 127.0.0.1, colours and a trailing slash count; progress or another port do not', () => {
  assert.equal(isReadyLine('Server ready - Local: http://localhost:3047, Network: http://192.168.1.4:3047', 3047), true);
  assert.equal(isReadyLine('Server ready - http://127.0.0.1:3047', 3047), true);
  assert.equal(isReadyLine('\x1b[1mServer ready\x1b[22m - Local: \x1b[4mhttp://localhost:3047\x1b[24m', 3047), true);
  assert.equal(isReadyLine('Server ready - Local: http://localhost:3047/', 3047), true);
  assert.equal(isReadyLine('Building... 34%', 3047), false);
  assert.equal(isReadyLine('Server ready - Local: http://localhost:3048', 3047), false);
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

test('RS-U39 the composition exists only once its code is scaffolded, and not after the Concept is removed', async () => {
  const ctx = await building(false);
  const cid = '3f9a1c2e-4b7d-4a91-9c2e-3b8f61d0aa52';
  assert.equal(existingCompositionId(ctx, cid), null, 'before the first video session');
  writeMeta(ctx.db, `composition:${cid}`, 'concept-3f9a1c2e');
  assert.equal(existingCompositionId(ctx, cid), null, 'an id without its index.tsx');
  await scaffoldProject(ctx);
  await scaffoldConcept(ctx, cid);
  assert.equal(existingCompositionId(ctx, cid), 'concept-3f9a1c2e');
  await archiveConceptCode(ctx, cid, 1);
  assert.equal(existingCompositionId(ctx, cid), 'concept-3f9a1c2e', "after Discard's fresh scaffold");
  await removeConceptFromProject(ctx, cid);
  assert.equal(existingCompositionId(ctx, cid), null, 'after the Concept is deleted');
});
