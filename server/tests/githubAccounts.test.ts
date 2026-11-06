import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ProjectRecord } from '../src/domain/types.ts';

const TOKEN_ACME = 'ghp_FAKE_TOKEN_acme_hr_000';
const TOKEN_DEFAULT = 'ghp_FAKE_TOKEN_default_111';

let root: string;
let accounts: typeof import('../src/github/accounts.ts');
let context: typeof import('../src/github/context.ts');
let gitModule: typeof import('../src/projects/git.ts');
let secrets: typeof import('../src/buildings/secrets.ts');
let originalPath: string | undefined;

const STATUS_BOTH = `github.com
  ✓ Logged in to github.com account personal (keyring)
  - Active account: true
  - Git operations protocol: https

  ✓ Logged in to github.com account acme-hr (keyring)
  - Active account: false
`;

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1', name: 'HR Fin', slug: 'hr-fin', relativePath: 'hr-fin', status: 'idle', position: null,
    activeTaskId: null, activeTaskIds: [], taskCount: 0, repositoryUrl: 'https://github.com/acme/hr-fin', githubAccount: 'acme-hr', ...overrides,
  } as ProjectRecord;
}

async function fakeGh(dir: string): Promise<void> {
  const script = `#!/bin/sh
echo "$* | GH_TOKEN=$GH_TOKEN" >> "$FAKE_GH_DIR/log"
case "$1" in
  --version) echo "gh version \${FAKE_GH_VERSION:-2.45.0} (2024-01-01)";;
  auth)
    case "$2" in
      status) cat "$FAKE_GH_DIR/status"; exit 0;;
      token) f="$FAKE_GH_DIR/token-$6"; [ -f "$f" ] || { echo "no oauth token" >&2; exit 1; }; cat "$f";;
      *) echo "unexpected: $*" >&2; exit 2;;
    esac;;
  api)
    case "$2" in
      user) login=$(grep -l "$GH_TOKEN" "$FAKE_GH_DIR"/token-* | sed 's/.*token-//'); echo "{\\"login\\":\\"$login\\",\\"id\\":42,\\"name\\":null}";;
      user/orgs) ;;
      repos/*) cat "$FAKE_GH_DIR/repo-$GH_TOKEN" 2>/dev/null || { echo "HTTP 404: Not Found" >&2; exit 1; };;
    esac;;
esac
`;
  await writeFile(path.join(dir, 'gh'), script);
  await chmod(path.join(dir, 'gh'), 0o755);
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gh-accounts-'));
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  const bin = path.join(root, 'bin');
  const fakeDir = path.join(root, 'fake');
  await mkdir(bin); await mkdir(fakeDir);
  await fakeGh(bin);
  await writeFile(path.join(fakeDir, 'status'), STATUS_BOTH);
  await writeFile(path.join(fakeDir, 'token-acme-hr'), `${TOKEN_ACME}\n`);
  await writeFile(path.join(fakeDir, 'token-personal'), `${TOKEN_DEFAULT}\n`);
  await writeFile(path.join(fakeDir, `repo-${TOKEN_ACME}`), '{"push":true,"owner":"acme"}');
  process.env.FAKE_GH_DIR = fakeDir;
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  accounts = await import('../src/github/accounts.ts');
  context = await import('../src/github/context.ts');
  gitModule = await import('../src/projects/git.ts');
  secrets = await import('../src/buildings/secrets.ts');
});

after(async () => {
  process.env.PATH = originalPath;
  await rm(root, { recursive: true, force: true });
});

const ghLog = async () => readFile(path.join(process.env.FAKE_GH_DIR!, 'log'), 'utf8').catch(() => '');

test('parseAuthStatus lists both accounts with the active flag and flags failed logins', () => {
  assert.deepEqual(accounts.parseAuthStatus(STATUS_BOTH), [
    { login: 'personal', active: true, signedIn: true },
    { login: 'acme-hr', active: false, signedIn: true },
  ]);
  const failed = accounts.parseAuthStatus('  X Failed to log in to github.com account acme-hr (keyring)\n  - Active account: false\n');
  assert.deepEqual(failed, [{ login: 'acme-hr', active: false, signedIn: false }]);
  assert.deepEqual(accounts.parseAuthStatus(''), []);
  assert.deepEqual(accounts.parseAuthStatus('garbage \u0000 truncated'), []);
});

test('gh version support starts at 2.40.0', () => {
  assert.equal(accounts.ghVersionSupportsAccounts([2, 39, 9]), false);
  assert.equal(accounts.ghVersionSupportsAccounts([2, 40, 0]), true);
  assert.equal(accounts.ghVersionSupportsAccounts([10, 0, 0]), true);
  assert.equal(accounts.parseGhVersion('nonsense'), null);
});

test('default identity is the profile name or login with the noreply email', () => {
  assert.deepEqual(accounts.defaultIdentity({ login: 'octo', id: 7, name: 'Octo Cat' }), { name: 'Octo Cat', email: '7+octo@users.noreply.github.com' });
  assert.deepEqual(accounts.defaultIdentity({ login: 'octo', id: 7, name: '  ' }), { name: 'octo', email: '7+octo@users.noreply.github.com' });
  assert.equal(accounts.defaultIdentity({ login: 'octo' }).email, 'octo@users.noreply.github.com');
});

test('identity and login validation', () => {
  assert.deepEqual(accounts.validateIdentity({ name: ' A B ', email: ' a@b.c ' }), { name: 'A B', email: 'a@b.c' });
  for (const name of ['', 'a\nb', 'a<b', 'a>b']) assert.throws(() => accounts.validateIdentity({ name, email: 'a@b.c' }), accounts.IdentityValidationError);
  for (const email of ['', 'a', 'a@@b', '@b.c', 'a@', 'a b@c.d', 'a@b\n.c']) assert.throws(() => accounts.validateIdentity({ name: 'n', email }), accounts.IdentityValidationError);
  for (const ok of ['Octo', 'a-b', 'a'.repeat(39), 'a1']) assert.equal(accounts.isValidLogin(ok), true, ok);
  for (const bad of ['', '-a', 'a-', 'a--b', 'a_b', 'a'.repeat(40), '--hostname', '../x', ' a', 'é']) assert.equal(accounts.isValidLogin(bad), false, bad);
});

test('remote forms: https and git@ are supported, others are not', () => {
  assert.equal(accounts.classifyRemote('https://github.com/o/r'), 'https');
  assert.equal(accounts.classifyRemote('https://github.com/o/r.git/'), 'https');
  assert.equal(accounts.classifyRemote('git@github.com:o/r.git'), 'ssh');
  assert.equal(accounts.classifyRemote('git@github.com-work:o/r.git'), 'ssh');
  for (const bad of ['http://github.com/o/r', 'ssh://git@github.com/o/r', 'https://user:pw@github.com/o/r', 'https://gitlab.com/o/r', 'file:///x', '']) assert.equal(accounts.classifyRemote(bad), 'unsupported', bad);
});

test('githubEnv carries token and identity in env only, extends GIT_CONFIG_COUNT and drops ambient credentials', () => {
  const ctx = { projectName: 'HR', action: 'push', login: 'acme-hr', token: TOKEN_ACME, authorName: 'Acme HR', authorEmail: '1+acme-hr@users.noreply.github.com', sshRewrite: { from: 'git@github.com:acme/hr.git', to: 'https://github.com/acme/hr.git' } };
  const base = { PATH: '/bin', GITHUB_TOKEN: 'ambient', GIT_ASKPASS: '/x', GIT_SSH_COMMAND: 'ssh -i k', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'T' };
  const env = context.githubEnv(base, ctx);
  assert.equal(env.GH_TOKEN, TOKEN_ACME);
  assert.equal(env.GH_HOST, 'github.com');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_AUTHOR_NAME, 'Acme HR');
  assert.equal(env.GIT_COMMITTER_EMAIL, ctx.authorEmail);
  for (const gone of ['GITHUB_TOKEN', 'GIT_ASKPASS', 'GIT_SSH_COMMAND']) assert.equal(env[gone], undefined);
  assert.equal(env.GIT_CONFIG_COUNT, '4');
  assert.equal(env.GIT_CONFIG_KEY_0, 'user.name');
  assert.equal(env.GIT_CONFIG_KEY_3, 'url.https://github.com/acme/hr.git.insteadOf');
  const configValues = Object.entries(env).filter(([key]) => key.startsWith('GIT_CONFIG_')).map(([, value]) => value);
  assert.ok(!configValues.some((value) => value?.includes(TOKEN_ACME)), 'the token must not be in a git config value');
  assert.equal(base.GIT_CONFIG_COUNT, '1', 'the base env is not mutated');
});

test('failure messages name project, account and fix, and never carry the token', () => {
  const ctx = { projectName: 'HR Fin', action: 'push the task branch', login: 'acme-hr', token: TOKEN_ACME, authorName: 'n', authorEmail: 'e@x.y', sshRewrite: null };
  const signedOut = context.accountFailureMessage(ctx, 'remote: HTTP 401 Bad credentials');
  assert.match(signedOut!, /HR Fin/); assert.match(signedOut!, /acme-hr/); assert.match(signedOut!, /push the task branch/); assert.match(signedOut!, /gh auth login -h github\.com/);
  assert.match(context.accountFailureMessage(ctx, 'remote: Permission to acme/x.git denied to acme-hr')!, /no access/);
  assert.match(context.accountFailureMessage(ctx, 'GH007: push declines private email')!, /private/);
  assert.equal(context.accountFailureMessage(ctx, 'HTTP 403: API rate limit exceeded'), null);
  assert.equal(context.accountFailureMessage(ctx, 'Could not resolve host'), null);
});

test('redaction removes a registered token in plain, base64, URL-encoded and JSON forms', () => {
  secrets.registerSecret('ghp_a/b+c=_special_token');
  const token = 'ghp_a/b+c=_special_token';
  const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
  const text = `plain ${token} url ${encodeURIComponent(token)} basic ${b64} json ${JSON.stringify({ t: token })} twice ${token}${token}`;
  const out = secrets.redactSecrets(text);
  assert.ok(!out.includes(token) && !out.includes(b64) && !out.includes(encodeURIComponent(token)));
  secrets.registerSecret('abc');
  assert.equal(secrets.redactSecrets('abc stays'), 'abc stays', 'a very short value is never scrubbed');
});

test('detectAccounts lists both accounts with identities and no token', async () => {
  const result = await accounts.detectAccounts([project()]);
  assert.equal(result.gh.state, 'ok');
  assert.deepEqual(result.accounts.map((a) => [a.login, a.active, a.signedIn, a.usedByProjects]), [['personal', true, true, 0], ['acme-hr', false, true, 1]]);
  assert.equal(result.accounts[1]!.identity.email, '42+acme-hr@users.noreply.github.com');
  assert.ok(!JSON.stringify(result).includes(TOKEN_ACME));
  assert.ok(!JSON.stringify(result).includes(TOKEN_DEFAULT));
});

test('detectAccounts reports an old gh without listing accounts', async () => {
  process.env.FAKE_GH_VERSION = '2.39.0';
  try {
    const result = await accounts.detectAccounts();
    assert.equal(result.gh.state, 'too-old');
    assert.deepEqual(result.accounts, []);
  } finally { delete process.env.FAKE_GH_VERSION; }
});

test('a saved identity override is used and reset restores the default', async () => {
  await accounts.saveIdentity('Acme-HR', { name: 'HR Bot', email: 'hr@acme.test' });
  assert.deepEqual(await accounts.identityFor('acme-hr'), { name: 'HR Bot', email: 'hr@acme.test' });
  await accounts.resetIdentity('acme-hr');
  assert.equal((await accounts.identityFor('acme-hr')).name, 'acme-hr');
});

test('an operation runs as the project account: commit identity, token env, and never the global config', async () => {
  await accounts.saveIdentity('acme-hr', { name: 'HR Bot', email: 'hr@acme.test' });
  const bare = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  await gitModule.git(root, ['init', '--bare', '--initial-branch=main', bare]);
  await gitModule.git(root, ['clone', bare, work]);
  await writeFile(path.join(work, 'f.txt'), 'x');
  const before = await ghLog();
  await accounts.withProjectGithub(project(), 'commit and push the task branch', async () => {
    await gitModule.git(work, ['checkout', '-b', 'task/x']);
    await gitModule.commitAndPush(work, 'task/x', 'work');
  });
  const author = await gitModule.git(work, ['log', '-1', '--format=%an|%ae|%cn|%ce']);
  assert.equal(author, 'HR Bot|hr@acme.test|HR Bot|hr@acme.test');
  assert.equal(await gitModule.git(bare, ['rev-parse', 'refs/heads/task/x']), await gitModule.git(work, ['rev-parse', 'HEAD']));
  const used = (await ghLog()).slice(before.length);
  assert.ok(!/auth switch|setup-git/.test(used), 'gh accounts are never switched');
  assert.equal(await gitModule.git(work, ['config', '--local', '--get', 'user.name']).catch(() => ''), '', 'no repo config is written');
});

test('two projects with different accounts at once never share identity or token', async () => {
  await accounts.saveIdentity('personal', { name: 'Pat', email: 'pat@home.test' });
  await accounts.saveIdentity('acme-hr', { name: 'HR Bot', email: 'hr@acme.test' });
  const ident = (cwd: string) => gitModule.git(cwd, ['var', 'GIT_AUTHOR_IDENT']);
  const [a, b] = await Promise.all([
    accounts.withProjectGithub(project(), 'x', async () => { await new Promise((r) => setTimeout(r, 30)); return ident(root); }),
    accounts.withProjectGithub(project({ id: 'p2', name: 'Home', githubAccount: 'personal', repositoryUrl: 'https://github.com/pat/home' }), 'x', async () => ident(root)),
  ]);
  assert.match(a, /^HR Bot <hr@acme\.test>/);
  assert.match(b, /^Pat <pat@home\.test>/);
});

test('a project without an account, or without a github.com repository, runs unchanged', async () => {
  const inside = async (p: ProjectRecord) => accounts.withProjectGithub(p, 'x', async () => context.githubScope.getStore());
  assert.equal(await inside(project({ githubAccount: null })), undefined);
  assert.equal(await inside(project({ githubAccount: undefined })), undefined);
  assert.equal(await inside(project({ repositoryUrl: 'https://gitlab.com/o/r' })), undefined);
  assert.equal(await inside(project({ repositoryUrl: undefined })), undefined);
});

test('a signed-out account blocks the action with a clear message and never falls back', async () => {
  let ran = false;
  await assert.rejects(
    accounts.withProjectGithub(project({ githubAccount: 'gone-user' }), 'push the task branch', async () => { ran = true; }),
    (error: Error) => error instanceof context.GithubAccountError && /HR Fin/.test(error.message) && /gone-user/.test(error.message) && /gh auth login -h github\.com/.test(error.message),
  );
  assert.equal(ran, false);
});

test('an auth failure inside the scope becomes the sign-in message, token redacted', async () => {
  await assert.rejects(
    accounts.withProjectGithub(project(), 'push the task branch', () => gitModule.git(root, ['not-a-command-HTTP 401 Bad credentials', TOKEN_ACME])),
    (error: Error) => !error.message.includes(TOKEN_ACME),
  );
});

// githubSessionEnv only reports variables that differ from the ambient environment, so tests
// asserting on forced values must clear any ambient copy first.
const FORCED_ENV_KEYS = ['GH_HOST', 'GH_PROMPT_DISABLED', 'GIT_TERMINAL_PROMPT'];

async function withoutAmbientForcedEnv<T>(run: () => Promise<T>, ambient: Record<string, string> = {}): Promise<T> {
  const saved = Object.fromEntries(FORCED_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of FORCED_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, ambient);
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('session env omits forced values the ambient environment already has', async () => {
  const { set, unset } = await withoutAmbientForcedEnv(
    () => accounts.githubSessionEnv(project(), { CLAUDE_CONFIG_DIR: '/c' }),
    { GH_HOST: 'github.com' },
  );
  assert.equal(set.GH_HOST, undefined);
  assert.ok(!unset.includes('GH_HOST'));
});

test('session env carries token, identity and git auth config and unsets ambient credentials; Machine default changes nothing', async () => {
  process.env.GIT_ASKPASS = '/ambient/askpass';
  process.env.GIT_SSH_COMMAND = 'ssh -i ambient';
  try {
    await withoutAmbientForcedEnv(async () => {
      const { set, unset } = await accounts.githubSessionEnv(project(), { CLAUDE_CONFIG_DIR: '/c' });
      assert.equal(set.GH_TOKEN, TOKEN_ACME);
      assert.equal(set.GH_HOST, 'github.com');
      assert.equal(set.GIT_AUTHOR_NAME !== undefined && set.GIT_COMMITTER_EMAIL !== undefined, true);
      assert.ok(Number(set.GIT_CONFIG_COUNT) >= 2);
      assert.ok(unset.includes('GIT_ASKPASS') && unset.includes('GIT_SSH_COMMAND'));
      assert.ok(!Object.values(set).some((value) => value === '/ambient/askpass'));
      assert.deepEqual(await accounts.githubSessionEnv(project({ githubAccount: null }), {}), { set: {}, unset: [] });
    });
  } finally { delete process.env.GIT_ASKPASS; delete process.env.GIT_SSH_COMMAND; }
});

test('checkProjectAccount: ok, no access, signed out, default', async () => {
  const ok = await accounts.checkProjectAccount(project());
  assert.equal(ok.status, 'ok'); assert.equal(ok.blocks, false); assert.equal(ok.ownerMismatch, true);
  assert.ok(!JSON.stringify(ok).includes(TOKEN_ACME));
  assert.equal((await accounts.checkProjectAccount(project({ githubAccount: 'personal' }))).status, 'no-access');
  const out = await accounts.checkProjectAccount(project({ githubAccount: 'gone-user' }));
  assert.equal(out.status, 'signed-out'); assert.equal(out.blocks, true);
  const none = await accounts.checkProjectAccount(project({ githubAccount: null }));
  assert.equal(none.status, 'default'); assert.equal(none.blocks, false);
});

// ---- review round 1: remote forms, credential helper, isolation, blocking, redaction, docs ----

const { execFile } = await import('node:child_process');
const { promisify } = await import('node:util');
const execAsync = promisify(execFile);

/** Runs `git credential fill` the way git asks a credential helper, under the current account scope. */
async function credentialFill(): Promise<string> {
  const child = execAsync('git', ['credential', 'fill'], { env: context.operationEnv(), cwd: root });
  child.child.stdin!.end('protocol=https\nhost=github.com\n\n');
  return (await child).stdout;
}

test('HTTPS pushes authenticate through the credential helper with the account token, which is in no argument', async () => {
  const filled = await accounts.withProjectGithub(project(), 'push', credentialFill);
  assert.match(filled, /username=x-access-token/);
  assert.match(filled, new RegExp(`password=${TOKEN_ACME}`));
  assert.ok(!/GIT_CONFIG_VALUE|helper/.test(filled));
});

test('a token with special characters reaches the helper intact', async () => {
  const special = 'ghp_a/b+c=_FAKE_special';
  await writeFile(path.join(process.env.FAKE_GH_DIR!, 'token-special-user'), `${special}\n`);
  const filled = await accounts.withProjectGithub(project({ githubAccount: 'special-user' }), 'push', credentialFill);
  assert.ok(filled.includes(`password=${special}`));
});

test('an SSH-style remote is rewritten to HTTPS for that repository only, and the stored remote is unchanged', async () => {
  const repo = path.join(root, 'ssh-repo');
  await gitModule.git(root, ['init', '--initial-branch=main', repo]);
  await gitModule.git(repo, ['remote', 'add', 'origin', 'git@github.com:acme/hr-fin.git']);
  await gitModule.git(repo, ['remote', 'add', 'other', 'git@github.com:acme/other.git']);
  const ssh = project({ repositoryUrl: 'git@github.com:acme/hr-fin.git' });
  const seen = await accounts.withProjectGithub(ssh, 'push', async () => ({
    origin: await gitModule.git(repo, ['remote', 'get-url', 'origin']),
    other: await gitModule.git(repo, ['remote', 'get-url', 'other']),
  }));
  assert.equal(seen.origin, 'https://github.com/acme/hr-fin.git');
  assert.equal(seen.other, 'git@github.com:acme/other.git');
  assert.equal(await gitModule.git(repo, ['config', '--get', 'remote.origin.url']), 'git@github.com:acme/hr-fin.git');
});

test('an unsupported remote form is refused before any token is fetched or any credential used', async () => {
  const before = (await ghLog()).length;
  let ran = false;
  await assert.rejects(
    accounts.withProjectGithub(project({ repositoryUrl: 'https://user:pw@github.com/acme/hr' }), 'push', async () => { ran = true; }),
    (error: Error) => error instanceof context.GithubAccountError && /HR Fin/.test(error.message),
  );
  assert.equal(ran, false);
  assert.equal((await ghLog()).length, before);
});

test('two projects holding a latch together still each see only their own identity and token', async () => {
  await accounts.saveIdentity('personal', { name: 'Pat', email: 'pat@home.test' });
  await accounts.saveIdentity('acme-hr', { name: 'HR Bot', email: 'hr@acme.test' });
  let release!: () => void;
  const latch = new Promise<void>((resolve) => { release = resolve; });
  let waiting = 0;
  const inside = (p: ProjectRecord) => accounts.withProjectGithub(p, 'push', async () => {
    waiting += 1;
    if (waiting === 2) release();
    await latch;
    return { ident: await gitModule.git(root, ['var', 'GIT_AUTHOR_IDENT']), token: context.operationEnv().GH_TOKEN };
  });
  const sameRepo = 'https://github.com/acme/hr-fin';
  const [a, b] = await Promise.all([inside(project({ repositoryUrl: sameRepo })), inside(project({ id: 'p2', name: 'Home', githubAccount: 'personal', repositoryUrl: sameRepo }))]);
  assert.match(a.ident, /^HR Bot/); assert.equal(a.token, TOKEN_ACME);
  assert.match(b.ident, /^Pat/); assert.equal(b.token, TOKEN_DEFAULT);
});

test('a token rotated between operations is picked up, and no file in the data or temp dir holds it', async () => {
  const file = path.join(process.env.FAKE_GH_DIR!, 'token-rotating');
  await writeFile(file, 'ghp_FAKE_rotating_one\n');
  const rotating = project({ githubAccount: 'rotating' });
  const first = await accounts.withProjectGithub(rotating, 'x', async () => context.operationEnv().GH_TOKEN);
  await writeFile(file, 'ghp_FAKE_rotating_two\n');
  const second = await accounts.withProjectGithub(rotating, 'x', async () => context.operationEnv().GH_TOKEN);
  assert.deepEqual([first, second], ['ghp_FAKE_rotating_one', 'ghp_FAKE_rotating_two']);
  const { stdout } = await execAsync('grep', ['-rl', 'ghp_FAKE_rotating', path.join(root, 'data'), path.join(root, 'work'), path.join(root, 'remote.git')]).catch(() => ({ stdout: '' }));
  assert.equal(stdout.trim(), '');
});

test('global git config and the gh hosts file are byte-identical after an operation, and gh is never asked to switch accounts', async () => {
  const home = path.join(root, 'home');
  await mkdir(path.join(home, '.config', 'gh'), { recursive: true });
  const gitconfig = path.join(home, '.gitconfig');
  const hosts = path.join(home, '.config', 'gh', 'hosts.yml');
  await writeFile(gitconfig, '[user]\n\tname = Global Person\n\temail = global@home.test\n');
  await writeFile(hosts, 'github.com:\n  user: personal\n');
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  const logBefore = (await ghLog()).length;
  const snapshot = async () => [await readFile(gitconfig, 'utf8'), await readFile(hosts, 'utf8')];
  const before = await snapshot();
  try {
    await accounts.withProjectGithub(project(), 'commit', async () => { await gitModule.git(root, ['var', 'GIT_COMMITTER_IDENT']); await credentialFill(); });
    await accounts.githubSessionEnv(project(), {});
    await accounts.checkProjectAccount(project());
  } finally { process.env.HOME = originalHome; }
  assert.deepEqual(await snapshot(), before);
  assert.ok(!/auth (switch|setup-git|login|refresh)|config --global/.test((await ghLog()).slice(logBefore)));
});

test('Machine default git and gh invocations receive the same environment as before', () => {
  const base = { PATH: '/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' };
  assert.deepEqual(context.operationEnv(base), { ...base, GIT_TERMINAL_PROMPT: '0' });
});

test('an expired token mid-run fails with the sign-in message, and the next attempt works', async () => {
  const expire = "alias.expire=!echo 'remote: HTTP 401 Bad credentials' >&2; exit 1";
  await assert.rejects(
    accounts.withProjectGithub(project(), 'push the task branch', () => gitModule.git(root, ['-c', expire, 'expire'])),
    (error: Error) => error instanceof context.GithubAccountError && /signed out or its token expired/.test(error.message) && /gh auth login -h github\.com/.test(error.message),
  );
  assert.equal(await accounts.withProjectGithub(project(), 'push the task branch', () => gitModule.git(root, ['var', 'GIT_AUTHOR_IDENT'])).then(Boolean), true);
});

test('a no-access failure and an unrelated network failure are told apart', async () => {
  const denied = "alias.denied=!echo 'remote: Permission to acme/hr-fin.git denied to acme-hr.' >&2; exit 1";
  await assert.rejects(accounts.withProjectGithub(project(), 'push', () => gitModule.git(root, ['-c', denied, 'denied'])), /no access to this repository/);
  const down = "alias.down=!echo 'Could not resolve host: github.com' >&2; exit 1";
  await assert.rejects(accounts.withProjectGithub(project(), 'push', () => gitModule.git(root, ['-c', down, 'down'])), (error: Error) => !(error instanceof context.GithubAccountError));
});

test('an account removed from gh after being chosen reads signed out and blocks until the project is set back to default', async () => {
  const dir = process.env.FAKE_GH_DIR!;
  await writeFile(path.join(dir, 'token-vanishing'), 'ghp_FAKE_vanishing\n');
  const vanishing = project({ githubAccount: 'vanishing' });
  assert.equal(await accounts.withProjectGithub(vanishing, 'x', async () => 'ran'), 'ran');
  await rm(path.join(dir, 'token-vanishing'));
  await assert.rejects(accounts.withProjectGithub(vanishing, 'x', async () => 'ran'), context.GithubAccountError);
  assert.equal((await accounts.checkProjectAccount(vanishing)).blocks, true);
  assert.equal(await accounts.withProjectGithub(project({ ...vanishing, githubAccount: null }), 'x', async () => 'ran'), 'ran');
});

test('identity overrides are only kept for accounts gh lists', async () => {
  await assert.rejects(accounts.saveIdentity('not-listed', { name: 'N', email: 'n@x.test' }), accounts.UnknownAccountError);
});

test('a token failure names the project and the account, never an empty project', async () => {
  const tokenless = project({ githubAccount: 'gone-user' });
  await assert.rejects(accounts.withProjectGithub(tokenless, 'x', async () => 1), (error: Error) => !/Project ""/.test(error.message));
});

test('a poller failure raises one notification under the project, is not repeated, and clears when the problem is gone', async () => {
  const notes = await import('../src/github/accountNotifications.ts');
  const service = await import('../src/notifications/notificationService.ts');
  const p = project({ id: 'poll-project' });
  await notes.reportAccountFailure(p, 'Project "HR Fin": signed out');
  const first = (await service.listNotifications({ resolved: false, projectId: p.id })).filter((n) => n.kind === 'github.account_failed');
  assert.equal(first.length, 1);
  assert.equal(first[0]!.subject.type, 'project');
  await notes.reportAccountFailure(p, 'Project "HR Fin": signed out');
  const again = (await service.listNotifications({ resolved: false, projectId: p.id })).filter((n) => n.kind === 'github.account_failed');
  assert.equal(again.length, 1);
  assert.equal(again[0]!.id, first[0]!.id);
  assert.equal(again[0]!.updatedAt, first[0]!.updatedAt, 'an unchanged message is not re-raised');
  await notes.clearAccountFailure(p);
  assert.equal((await service.listNotifications({ resolved: false, projectId: p.id })).filter((n) => n.kind === 'github.account_failed').length, 0);
});

test('the stream redactor catches a token split across chunks and holds back nothing else', async () => {
  const redaction = await import('../src/redaction.ts');
  redaction.rememberSecret('ghp_STREAM_split_secret_123');
  const out: string[] = [];
  const stream = redaction.createStreamRedactor((safe) => out.push(safe), 10);
  stream.push('hello ghp_STREAM_sp');
  stream.push('lit_secret_123 done');
  stream.flush();
  assert.equal(out.join(''), 'hello [secret] done');
  const plain: string[] = [];
  const quiet = redaction.createStreamRedactor((safe) => plain.push(safe), 10);
  quiet.push('prompt$ ');
  assert.deepEqual(plain, ['prompt$ '], 'ordinary output is emitted at once');
  const late: string[] = [];
  const timed = redaction.createStreamRedactor((safe) => late.push(safe), 5);
  timed.push('see ghp_STREAM');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(late.join(''), 'see ghp_STREAM', 'a held tail is released when nothing follows');
});

test('step output files and task turns never persist a registered token', async () => {
  const { createStepOutputFiles } = await import('../src/worker/stepOutputFiles.ts');
  secrets.registerSecret(TOKEN_ACME);
  const files = createStepOutputFiles(path.join(root, 'step-outputs'));
  const [file] = await files.ensureRound({ projectId: 'p1', runId: 'r1', stepId: 's1', round: 1, outputs: [{ name: 'notes', format: 'markdown', content: `leaked ${TOKEN_ACME}` }] } as never);
  assert.ok(file);
  const saved = await readFile(file!, 'utf8');
  assert.ok(!saved.includes(TOKEN_ACME));
  assert.match(saved, /\[secret\]/);
});

test('the docs describe the account model, what each operation receives and the redaction rules', async () => {
  const blueprint = await readFile(new URL('../../.docs/blueprint.md', import.meta.url), 'utf8');
  const architecture = await readFile(new URL('../../docs/architecture.md', import.meta.url), 'utf8');
  for (const needle of ['GitHub accounts (per project)', 'What receives the account', 'Redaction', 'GH_TOKEN', 'insteadOf', 'github.account_failed']) assert.ok(blueprint.includes(needle), needle);
  assert.match(architecture, /Per-project GitHub account/);
});

test('API and project DTOs never carry a token value', async () => {
  const detected = JSON.stringify(await accounts.detectAccounts([project()]));
  const check = JSON.stringify(await accounts.checkProjectAccount(project()));
  for (const token of [TOKEN_ACME, TOKEN_DEFAULT]) { assert.ok(!detected.includes(token)); assert.ok(!check.includes(token)); }
});
