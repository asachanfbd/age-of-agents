#!/usr/bin/env node

// Detached updater for the server-classified app-update path (task 7.001) — spawned by
// appUpdateService.ts once the daemon is idle, as the leader of its own process group
// (`detached: true`), so scripts/prod-stop.sh's SIGTERM to the DAEMON's process group (sent by this
// very script's own `stop()` step below, since it's the same signal prod-stop.sh always sends) never
// reaches this process. That's the whole trick behind "survives the daemon's own shutdown" — see
// appUpdateService.ts's doc comment at the spawn call for the full reasoning.
//
// Deliberately NOT unit tested (server/README.md's test-isolation rule, and this task's own test
// plan, acceptance criterion 11 — a manual browser check covers this boundary instead).
// runServerUpdate's own branching logic is fully covered with fakes in
// server/tests/appUpdateServerRunner.test.ts; this file is the thin, manually-verified wiring of
// that logic to real processes: scripts/prod-stop.sh, git, `npm run install:all` and
// scripts/prod-start.sh.

import { spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runServerUpdate } from '../src/appUpdate/serverUpdateRunner.ts';
import { pullFastForward, rollbackToCommit } from '../src/appUpdate/updateGitSteps.ts';

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_CHECKOUT_ROOT = process.env.AGENT_VISUAL_OS_APP_ROOT ?? path.resolve(BIN_DIR, '..', '..');
const RUN_DIR = process.env.AGENT_VISUAL_OS_RUN_DIR ?? path.join(APP_CHECKOUT_ROOT, '.run');
const LOG_PATH = path.join(RUN_DIR, 'app-update.log');
const RESULT_PATH = path.join(RUN_DIR, 'app-update-result.json');

const [previousCommit, newCommit] = process.argv.slice(2);
if (!previousCommit || !newCommit) {
  console.error('Usage: run-app-update.mjs <previousCommit> <newCommit>');
  process.exit(1);
}

async function appendLog(label, result) {
  await mkdir(RUN_DIR, { recursive: true });
  const output = typeof result === 'string' ? result : (result?.output ?? '');
  await appendFile(LOG_PATH, `\n--- ${new Date().toISOString()} ${label} ---\n${output}\n`);
}

/** Runs one command to completion, combining stdout+stderr, resolving ok:(exit code === 0). Never rejects. */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { cwd: APP_CHECKOUT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (error) => resolve({ ok: false, output: `${output}${error.message}` }));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

const steps = {
  async stop() {
    const result = await run(path.join(APP_CHECKOUT_ROOT, 'scripts', 'prod-stop.sh'), []);
    await appendLog('stop', result);
  },

  async pull() {
    const result = await pullFastForward(APP_CHECKOUT_ROOT);
    await appendLog('pull', result);
    return result;
  },

  async installAll() {
    const result = await run('npm', ['run', 'install:all']);
    await appendLog('installAll', result);
    return result;
  },

  /** prod-start.sh's own exit code already encodes "build failed" or "a process died right after starting" — a nonzero exit here is reported as ok:false with its output, nothing re-implemented. */
  async start() {
    const result = await run(path.join(APP_CHECKOUT_ROOT, 'scripts', 'prod-start.sh'), []);
    await appendLog('start', result);
    return result;
  },

  /** Restores the previous commit while keeping every local change — see rollbackToCommit. */
  async resetToCommit(sha) {
    const result = await rollbackToCommit(APP_CHECKOUT_ROOT, sha);
    await appendLog(`resetToCommit ${sha}`, result);
    return result;
  },
};

const result = await runServerUpdate(steps, { previousCommit, newCommit });
await mkdir(RUN_DIR, { recursive: true });
await writeFile(RESULT_PATH, JSON.stringify({ ...result, finishedAt: new Date().toISOString() }, null, 2));
process.exit(result.ok ? 0 : 1);
