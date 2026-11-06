import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../../src/projects/git.ts';
import type { ProjectRecord } from '../../src/domain/types.ts';
import type { TerminalSessionStart } from '../../src/terminal/terminalSessionManager.ts';
import { autoAdvanceTerminalSteps, type StepAction } from './terminalStepFakes.ts';

/**
 * Everything the PR-tab tests share: real git against a local bare remote (GitHub URLs are rewritten
 * to it), a scripted fake `gh` on PATH, and a daemon server whose PR service runs conflict-resolution
 * runs through a worker manager with fake terminal sessions. No real `gh`, `claude` or network.
 */

/** The GraphQL `repository` payload the fake `gh` answers a merge-state read with. */
export interface FakeRepositoryPayload {
  viewerPermission: string;
  defaultBranchRef: { name: string } | null;
  pullRequest: Record<string, unknown>;
}

export function repositoryPayload(number: number, pullRequest: Record<string, unknown> = {}, repository: Partial<FakeRepositoryPayload> = {}): FakeRepositoryPayload {
  return {
    viewerPermission: 'WRITE',
    defaultBranchRef: { name: 'main' },
    ...repository,
    pullRequest: {
      number,
      title: `Change ${number}`,
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: null,
      headRefName: `feature-${number}`,
      headRefOid: 'a'.repeat(40),
      baseRefName: 'main',
      isCrossRepository: false,
      headRef: { name: `feature-${number}` },
      headRepository: { url: 'https://github.com/test/repo' },
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      ...pullRequest,
    },
  };
}

export interface FakeCheck { name: string; state: 'SUCCESS' | 'FAILURE' | 'PENDING'; required: boolean | null }

/** The `commits` payload of a PR whose latest commit carries these checks, each a status context with GitHub's `isRequired` flag. */
export function checksPayload(checks: FakeCheck[], hasNextPage = false): Record<string, unknown> {
  const nodes = checks.map((check) => ({ __typename: 'StatusContext', context: check.name, state: check.state, ...(check.required === null ? {} : { isRequired: check.required }) }));
  return { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage }, nodes } } } }] } };
}

interface FakeGhState {
  pulls: Record<string, FakeRepositoryPayload>;
  /** stderr text per call kind; the call then exits 1. */
  fail: Partial<Record<'read' | 'merge' | 'delete' | 'retarget' | 'list', string>>;
  /** Open PR numbers based on a branch, for the stacked-PR lookup. */
  stacked: Record<string, number[]>;
  /** How many merge-state reads keep answering `staleRead` before the stored payload shows. */
  staleReads: number;
  /** Milliseconds a merge call takes, so tests can overlap requests. */
  mergeDelayMs: number;
  /** PR numbers the base branch's protection blocks: `gh pr merge` refuses them unless it is given `--admin`. */
  protectedPulls: number[];
}

// Runs as `gh`: logs its argv, then answers from state.json beside it. A merge marks the PR MERGED.
const FAKE_GH_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const args = process.argv.slice(2);
const statePath = path.join(dir, 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\\n');
const fail = (text) => { process.stderr.write(text + '\\n'); process.exit(1); };
const arg = (prefix) => (args.find((a) => a.startsWith(prefix)) || '').slice(prefix.length);
const main = async () => {
  if (args[0] === 'api' && args[1] === 'graphql') {
    if (state.fail.read) fail(state.fail.read);
    const pull = state.pulls[arg('number=')];
    if (!pull) fail('GraphQL: Could not resolve to a PullRequest with the number of ' + arg('number=') + '. (repository.pullRequest)');
    if (state.staleReads > 0) {
      state.staleReads -= 1; save();
      const stale = JSON.parse(JSON.stringify(pull));
      stale.pullRequest.mergeable = 'UNKNOWN'; stale.pullRequest.mergeStateStatus = 'UNKNOWN';
      process.stdout.write(JSON.stringify({ data: { repository: stale } }));
      return;
    }
    process.stdout.write(JSON.stringify({ data: { repository: pull } }));
    return;
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    if (state.mergeDelayMs) await new Promise((r) => setTimeout(r, state.mergeDelayMs));
    if (state.fail.merge) fail(state.fail.merge);
    if (state.protectedPulls.includes(Number(args[2])) && !args.includes('--admin')) {
      fail('X Pull request #' + args[2] + ' is not mergeable: the base branch policy prohibits the merge. To use administrator privileges to immediately merge the pull request, add the --admin flag.');
    }
    if (state.pulls[args[2]]) state.pulls[args[2]].pullRequest.state = 'MERGED';
    save();
    return;
  }
  const target = args.find((a) => a.startsWith('repos/')) || '';
  if (args.includes('DELETE')) { if (state.fail.delete) fail(state.fail.delete); return; }
  if (args.includes('PATCH')) {
    if (state.fail.retarget) fail(state.fail.retarget);
    const number = target.split('/').pop();
    if (state.pulls[number]) state.pulls[number].pullRequest.baseRefName = arg('base=');
    save();
    return;
  }
  const base = /[?&]base=([^&]+)/.exec(target);
  if (base) { process.stdout.write((state.stacked[decodeURIComponent(base[1])] || []).join('\\n')); return; }
  if (state.fail.list) fail(state.fail.list);
  const open = Object.values(state.pulls).map((p) => p.pullRequest).filter((p) => p.state === 'OPEN');
  process.stdout.write(open.map((p) => JSON.stringify({
    number: p.number, title: p.title, headBranch: p.headRefName, baseBranch: p.baseRefName, author: 'someone',
    url: 'https://github.com/test/repo/pull/' + p.number, isDraft: p.isDraft, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  })).join('\\n'));
};
main();
`;

export interface FakeGh {
  /** Sets (or replaces) what a merge-state read answers for a PR. */
  setPull(number: number, pullRequest?: Record<string, unknown>, repository?: Partial<FakeRepositoryPayload>): Promise<void>;
  patch(change: Partial<Omit<FakeGhState, 'pulls'>>): Promise<void>;
  /** Every `gh` invocation's argv so far, oldest first. */
  calls(): Promise<string[][]>;
  clearCalls(): Promise<void>;
  /** Calls whose argv starts with these words, e.g. `callsTo('pr', 'merge')`. */
  callsTo(...words: string[]): Promise<string[][]>;
  uninstall(): void;
}

/** Puts a scripted `gh` first on PATH (git and node stay reachable behind it). */
export async function installFakeGh(root: string): Promise<FakeGh> {
  const bin = path.join(root, 'fake-gh-bin');
  await mkdir(bin, { recursive: true });
  const statePath = path.join(bin, 'state.json');
  const logPath = path.join(bin, 'calls.log');
  const read = async (): Promise<FakeGhState> => JSON.parse(await readFile(statePath, 'utf8')) as FakeGhState;
  const write = (state: FakeGhState) => writeFile(statePath, JSON.stringify(state));
  await write({ pulls: {}, fail: {}, stacked: {}, staleReads: 0, mergeDelayMs: 0, protectedPulls: [] });
  await writeFile(logPath, '');
  await writeFile(path.join(bin, 'gh'), FAKE_GH_SOURCE);
  await chmod(path.join(bin, 'gh'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;

  const calls = async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return {
    async setPull(number, pullRequest = {}, repository = {}) {
      const state = await read();
      state.pulls[String(number)] = repositoryPayload(number, pullRequest, repository);
      await write(state);
    },
    async patch(change) { await write({ ...(await read()), ...change }); },
    calls,
    clearCalls: () => writeFile(logPath, ''),
    async callsTo(...words) { return (await calls()).filter((args) => words.every((word, index) => args[index] === word)); },
    uninstall() { process.env.PATH = previousPath; },
  };
}

export interface PullRequestHarness {
  root: string;
  /** A second clone used to push branches and PR head refs to the bare remote, like another machine would. */
  seed: string;
  remote: string;
  gh: FakeGh;
  baseUrl: string;
  terminal: { starts: TerminalSessionStart[] };
  /** What each started conflict-resolution step session does; reassign per test. Unset leaves the session running. */
  stepActions: Record<string, StepAction>;
  manager: ReturnType<typeof import('../../src/worker/workerManager.ts')['createWorkerManager']>;
  pullRequests: import('../../src/projects/pullRequestService.ts').PullRequestService;
  projectService: typeof import('../../src/projects/projectService.ts');
  collections: typeof import('../../src/db/collections.ts');
  poller: typeof import('../../src/projects/gitSyncPoller.ts');
  api(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }>;
  createProject(name: string): Promise<ProjectRecord>;
  /**
   * Publishes a pull request: commits `files` on a new branch off `from` in the seed clone, pushes it
   * as the PR's `refs/pull/<n>/head` (and as branch `branch` on the remote unless `fork`), and makes
   * the fake `gh` report it. Resolves the head commit.
   */
  publishPullRequest(input: { number: number; branch: string; files: Record<string, string>; from?: string; fork?: boolean; pullRequest?: Record<string, unknown> }): Promise<string>;
  close(): Promise<void>;
}

export async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function startPullRequestHarness(prefix: string): Promise<PullRequestHarness> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, '..', 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(root, 'catalog');
  await cp(path.join(import.meta.dirname, '..', 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  // Rewrite only this test process's GitHub URLs to a local bare remote — same trick as gitSyncPoller.test.ts.
  process.env.GIT_CONFIG_COUNT = '3';
  process.env.GIT_CONFIG_KEY_0 = `url.${root}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/test/';
  process.env.GIT_CONFIG_KEY_1 = 'user.name'; process.env.GIT_CONFIG_VALUE_1 = 'Test';
  process.env.GIT_CONFIG_KEY_2 = 'user.email'; process.env.GIT_CONFIG_VALUE_2 = 'test@example.com';

  const remote = path.join(root, 'repo');
  const seed = path.join(root, 'seed');
  await git(root, ['init', '--bare', '--initial-branch=main', 'repo']);
  await git(root, ['clone', remote, 'seed']);
  await writeFile(path.join(seed, 'README.md'), 'v1\n');
  await writeFile(path.join(seed, 'shared.txt'), 'base line\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-m', 'initial']);
  await git(seed, ['push', 'origin', 'main']);
  const gh = await installFakeGh(root);

  const projectService = await import('../../src/projects/projectService.ts');
  const collections = await import('../../src/db/collections.ts');
  const poller = await import('../../src/projects/gitSyncPoller.ts');
  const { createWorkerManager } = await import('../../src/worker/workerManager.ts');
  const { createPullRequestService } = await import('../../src/projects/pullRequestService.ts');
  const { createDaemonServer } = await import('../../src/server.ts');

  const stepActions: Record<string, StepAction> = {};
  const managerRef: { current?: ReturnType<typeof createWorkerManager> } = {};
  const terminal = autoAdvanceTerminalSteps(managerRef, stepActions);
  const manager = createWorkerManager({ terminalSessions: terminal.host, pullRequestRecheck: { attempts: 4, delayMs: 0 } });
  managerRef.current = manager;
  const pullRequests = createPullRequestService({ ...manager, sessions: terminal.host });
  const server: HttpServer = createDaemonServer({ pullRequests });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    root, seed, remote, gh, baseUrl, terminal, stepActions, manager, pullRequests, projectService, collections, poller,
    async api(pathname, init) {
      const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    },
    createProject: (name) => projectService.createProject({ name, position: null, repositoryUrl: 'https://github.com/test/repo' }),
    async publishPullRequest({ number, branch, files, from = 'main', fork = false, pullRequest = {} }) {
      const work = `pr-work-${number}-${Math.random().toString(36).slice(2, 8)}`;
      await git(seed, ['fetch', '--quiet', 'origin']);
      await git(seed, ['switch', '--quiet', '-c', work, `origin/${from}`]);
      for (const [file, content] of Object.entries(files)) await writeFile(path.join(seed, file), content);
      await git(seed, ['add', '.']);
      await git(seed, ['commit', '-m', `PR ${number}: ${branch}`]);
      const sha = await git(seed, ['rev-parse', 'HEAD']);
      await git(seed, ['push', '--quiet', '--force', 'origin', `HEAD:refs/pull/${number}/head`]);
      if (!fork) await git(seed, ['push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`]);
      await git(seed, ['switch', '--quiet', 'main']);
      await gh.setPull(number, {
        headRefName: branch,
        headRef: { name: branch },
        headRefOid: sha,
        baseRefName: from,
        ...(fork ? { isCrossRepository: true, headRepository: { url: 'https://github.com/test/fork' } } : {}),
        ...pullRequest,
      });
      return sha;
    },
    async close() {
      gh.uninstall();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
