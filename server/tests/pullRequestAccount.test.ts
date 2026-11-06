import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ProjectRecord } from '../src/domain/types.ts';
import { repositoryPayload } from './helpers/pullRequestHarness.ts';

/**
 * A project with its own GitHub account and an SSH-alias remote (`git@github-loki:hrfinpay/...`): the
 * merge-state read, the merge and the PR list all run as that account against the right repository.
 * A fake `gh` that logs the token it was given and the arguments; no real account or network.
 */

const TOKEN = 'ghp_FAKE_TOKEN_hrfinpay_000';
const REMOTE = 'git@github-loki:hrfinpay/hr-fin-pay.git';

let root: string;
let actions: typeof import('../src/projects/pullRequestActions.ts');
let originalPath: string | undefined;

const project = (): ProjectRecord => ({
  id: 'p1', name: 'HR Fin Pay', slug: 'hr-fin-pay', relativePath: 'hr-fin-pay', status: 'idle', position: null, activeTaskId: null,
  activeTaskIds: [], taskCount: 0, repositoryUrl: REMOTE, githubAccount: 'hrfinpay-bot',
} as unknown as ProjectRecord);

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pr-account-'));
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  const bin = path.join(root, 'bin');
  const fakeDir = path.join(root, 'fake');
  await mkdir(bin); await mkdir(fakeDir); await mkdir(path.join(root, 'projects', 'hr-fin-pay'), { recursive: true });
  await writeFile(path.join(fakeDir, 'status'), '  ✓ Logged in to github.com account hrfinpay-bot (keyring)\n  - Active account: false\n');
  await writeFile(path.join(fakeDir, 'token-hrfinpay-bot'), `${TOKEN}\n`);
  await writeFile(path.join(fakeDir, 'pull.json'), JSON.stringify({ data: { repository: repositoryPayload(7) } }));
  const script = `#!/bin/sh
echo "$* | GH_TOKEN=$GH_TOKEN" | tr "\\n" " " >> "$FAKE_GH_DIR/log"; echo >> "$FAKE_GH_DIR/log"
case "$1" in
  --version) echo "gh version 2.45.0 (2024-01-01)";;
  auth)
    case "$2" in
      status) cat "$FAKE_GH_DIR/status";;
      token) cat "$FAKE_GH_DIR/token-$6";;
    esac;;
  api)
    case "$2" in
      user) echo '{"login":"hrfinpay-bot","id":42,"name":null}';;
      graphql) cat "$FAKE_GH_DIR/pull.json";;
      user/orgs) ;;
      *) ;;
    esac;;
esac
`;
  await writeFile(path.join(bin, 'gh'), script);
  await chmod(path.join(bin, 'gh'), 0o755);
  process.env.FAKE_GH_DIR = fakeDir;
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  actions = await import('../src/projects/pullRequestActions.ts');
});

after(async () => {
  process.env.PATH = originalPath;
  await rm(root, { recursive: true, force: true });
});

const logLines = async () => (await readFile(path.join(process.env.FAKE_GH_DIR!, 'log'), 'utf8')).split('\n').map((line) => line.trim()).filter(Boolean);
const callsTo = async (prefix: string) => (await logLines()).filter((line) => line.startsWith(prefix));

test('SI4 the repository slug of the alias remote is owner/name', () => {
  assert.equal(actions.pullRequestContext(project()).slug, 'hrfinpay/hr-fin-pay');
});

test('SI4/SI23 the merge-state read runs as the project\'s account against hrfinpay/hr-fin-pay, and reads fine', async () => {
  const reading = await actions.readPullRequest(project(), 7);
  assert.equal(reading.number, 7);
  const [call] = await callsTo('api graphql');
  assert.ok(call!.includes('owner=hrfinpay') && call!.includes('name=hr-fin-pay') && call!.includes('number=7'));
  assert.ok(call!.endsWith(`GH_TOKEN=${TOKEN}`), 'the account\'s token, not the machine default');
});

test('SI5 the merge runs as the project\'s account against the same repository', async () => {
  const reading = await actions.readPullRequest(project(), 7);
  await actions.mergePullRequest(project(), reading);
  const [call] = await callsTo('pr merge');
  assert.ok(call!.startsWith('pr merge 7 --repo hrfinpay/hr-fin-pay --merge'));
  assert.ok(call!.endsWith(`GH_TOKEN=${TOKEN}`));
  assert.ok(!call!.includes('--admin'));
});
