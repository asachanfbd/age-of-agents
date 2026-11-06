import assert from 'node:assert/strict';
import { settledSetup } from './helpers/startRun.ts';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { git } from '../src/projects/git.ts';
import { autoAdvanceTerminalSteps, type StepAction } from './helpers/terminalStepFakes.ts';

/**
 * Task 2.005 against a real git repository (a local bare "origin" reached through
 * `url.<root>/.insteadOf`, like gitProjects.test.ts): discovery leaves the run's worktree and the
 * Project's own checkout byte-for-byte unchanged and commits nothing; a proposal step that changes
 * files anyway is caught and never offered for approval; and an approved setup commits its changes
 * only to the run's own branch. A fake `gh` on PATH keeps the Complete stage offline.
 */

let root: string;
let projectService: typeof import('../src/projects/projectService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let collections: typeof import('../src/db/collections.ts');

const SEEDED_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2.1.0' } }),
  'package-lock.json': JSON.stringify({ name: 'app', lockfileVersion: 3 }),
  'tests/math.test.js': "test('adds', () => expect(1 + 1).toBe(2));\n",
  '.github/workflows/ci.yml': 'on: push\njobs: { test: { runs-on: ubuntu-latest, steps: [{ run: npm test }] } }\n',
  '.docs/testing/config.json': JSON.stringify({ schemaVersion: 1, suites: [] }),
};

const PROPOSAL = [{ name: 'Testing setup proposal', format: 'markdown' as const, content: '# Proposal\n\nAdd a junit reporter.' }];
const NEW_CONFIG = {
  schemaVersion: 1,
  suites: [{ id: 'unit', label: 'Unit', kind: 'unit', primaryActionId: 'run', actions: [{ id: 'run', label: 'Run', command: 'npm test', collectors: [{ id: 'cases', format: 'junit-xml', path: 'junit.xml' }] }] }],
};

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'testing-setup-git-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures/executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(root, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  process.env.GIT_CONFIG_COUNT = '3';
  process.env.GIT_CONFIG_KEY_0 = `url.${root}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/test/';
  process.env.GIT_CONFIG_KEY_1 = 'user.name'; process.env.GIT_CONFIG_VALUE_1 = 'Test';
  process.env.GIT_CONFIG_KEY_2 = 'user.email'; process.env.GIT_CONFIG_VALUE_2 = 'test@example.com';
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  await chmod(path.join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

  await git(root, ['init', '--bare', '--initial-branch=main', 'repo']);
  await git(root, ['clone', path.join(root, 'repo'), 'seed']);
  const seed = path.join(root, 'seed');
  for (const [file, content] of Object.entries(SEEDED_FILES)) {
    await mkdir(path.dirname(path.join(seed, file)), { recursive: true });
    await writeFile(path.join(seed, file), content);
  }
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-m', 'initial']);
  await git(seed, ['push', 'origin', 'main']);

  projectService = await import('../src/projects/projectService.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  collections = await import('../src/db/collections.ts');
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

type Manager = ReturnType<typeof import('../src/worker/workerManager.ts').createWorkerManager>;

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fingerprint(dir: string): Promise<Record<string, string>> {
  const entries = await Promise.all(Object.keys(SEEDED_FILES).map(async (file) => [file, createHash('sha256').update(await readFile(path.join(dir, file))).digest('hex')] as const));
  return Object.fromEntries(entries);
}

async function repoProject(name: string, actions: Record<string, StepAction>) {
  const project = await projectService.createProject({ name, position: null, repositoryUrl: 'https://github.com/test/repo' });
  const ref: { current?: Manager } = {};
  const { host, starts } = autoAdvanceTerminalSteps(ref, actions);
  const manager = workerManagerModule.createWorkerManager({ terminalSessions: host, listExecutors: async () => [] });
  ref.current = manager;
  return { project, manager, starts, dir: projectService.projectAbsolutePath(project) };
}

async function status(manager: Manager, runId: string) {
  return (await manager.getWorkflowRunDetail(runId)).run;
}

test('discovery writes nothing: its worktree stays clean, the checkout is unchanged, and the branch has no commits; an approved setup commits only to its own branch', async () => {
  const actions: Record<string, StepAction> = {};
  const { project, manager, dir } = await repoProject('Zero Write', actions);
  actions.proposal = (taskId) => manager.completeStep(taskId, { summary: 'Proposed.', outputs: PROPOSAL });
  const before = await fingerprint(dir);

  const { run } = await settledSetup(manager)(project.id);
  assert.equal(run?.baseBranch, 'main');
  assert.ok(run?.worktreePath && run.branch);
  await waitUntil(async () => (await status(manager, run.id)).status === 'awaiting-approval');

  assert.deepEqual(await git(run.worktreePath, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.deepEqual(await fingerprint(dir), before);
  assert.deepEqual(await fingerprint(run.worktreePath), before);
  assert.equal(await git(dir, ['rev-list', '--count', `main..${run.branch}`]), '0', 'nothing committed before approval');

  actions.implementation = async (taskId) => {
    await writeFile(path.join(run.worktreePath!, '.docs/testing/config.json'), JSON.stringify(NEW_CONFIG));
    await collections.testRunsDb.insert({
      id: randomUUID(), projectId: project.id, batchId: null,
      suite: { id: 'unit', label: 'Unit', kind: 'unit' },
      action: { id: 'run', label: 'Run', purpose: 'result', command: 'npm test', workingDirectory: '.', collectors: [] },
      trigger: 'agent', taskId, executionRoot: run.worktreePath!, cwd: run.worktreePath!, branch: run.branch!, commit: null,
      status: 'passed', exitCode: 0, queuedAt: new Date().toISOString(), startedAt: null, completedAt: null, durationMs: 5, outputTruncated: false,
      summary: { outcome: 'passed', counts: { total: 1, passed: 1 }, metrics: [], findingCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } },
      diagnostics: [], artifactDir: null,
    });
    await manager.completeStep(taskId, { summary: 'Configured the unit suite.', verdict: 'pass' });
  };
  await manager.approveTestingSetup(run.id, 1);
  await waitUntil(async () => (await status(manager, run.id)).status === 'completed');

  assert.deepEqual(JSON.parse(await git(path.join(root, 'repo'), ['show', `${run.branch}:.docs/testing/config.json`])), NEW_CONFIG);
  assert.deepEqual(await fingerprint(dir), before, 'the Project checkout only changes once the branch is merged');
  assert.equal((await status(manager, run.id)).testingSetup?.evidence?.ok, true);
});

test('a proposal step that changed files anyway is never offered for approval and nothing is committed', async () => {
  const actions: Record<string, StepAction> = {};
  const { project, manager, dir } = await repoProject('Sandbox Escape', actions);
  let worktree = '';
  actions.proposal = async (taskId) => {
    worktree = (await manager.getTask(taskId)).worktreePath!;
    await writeFile(path.join(worktree, 'package.json'), '{"tampered":true}');
    await writeFile(path.join(worktree, 'new-file.txt'), 'x');
    await manager.completeStep(taskId, { summary: 'Proposed.', outputs: PROPOSAL });
  };
  const before = await fingerprint(dir);
  const { run } = await settledSetup(manager)(project.id);
  await waitUntil(async () => (await status(manager, run!.id)).status === 'needs-attention');

  const attention = (await status(manager, run!.id)).attentionReason ?? '';
  assert.match(attention, /Setup Proposal is read-only but the working tree changed \(.*package\.json.*new-file\.txt/);
  assert.equal(await git(dir, ['rev-list', '--count', `main..${run!.branch}`]), '0');
  assert.deepEqual(await fingerprint(dir), before);
  await assert.rejects(manager.approveTestingSetup(run!.id, 1), (error: Error) => error.name === 'WorkflowRunNotActionableError');
  await manager.stopWorkflowRun(run!.id);
});
