import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

const accountsLib = await import('../src/lib/githubAccounts.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE, reportedError } = await import('./errorHelpers.mjs');

const account = (login, extra = {}) => ({ login, name: null, active: false, signedIn: true, identity: { name: login, email: `${login}@x.test` }, hasCustomIdentity: false, usedByProjects: 0, ...extra });
const result = (accounts, gh = { state: 'ok', version: '2.45.0' }) => ({ gh, accounts, addCommand: 'gh auth login -h github.com', minGhVersion: '2.40.0' });

test('the card shows only for a github.com repository', () => {
  assert.equal(accountsLib.showsAccountCard({ repositoryUrl: 'https://github.com/o/r' }), true);
  assert.equal(accountsLib.showsAccountCard({ repositoryUrl: 'git@github.com:o/r.git' }), true);
  assert.equal(accountsLib.showsAccountCard({ repositoryUrl: 'https://gitlab.com/o/r' }), false);
  assert.equal(accountsLib.showsAccountCard({}), false);
});

test('selector options are Machine default plus accounts; an undetected stored account is kept and marked signed out', () => {
  const both = result([account('a'), account('b', { signedIn: false })]);
  assert.deepEqual(accountsLib.accountOptions({ githubAccount: null }, both).map((o) => [o.value, o.label, o.disabled]), [['', 'Machine default', false], ['a', 'a', false], ['b', 'b (needs sign-in)', false]]);
  const gone = accountsLib.accountOptions({ githubAccount: 'gone' }, both).at(-1);
  assert.deepEqual([gone.value, gone.label, gone.disabled], ['gone', 'gone (signed out)', true]);
  const noGh = accountsLib.accountOptions({ githubAccount: null }, result([account('a')], { state: 'missing' }));
  assert.equal(noGh.find((o) => o.value === 'a').disabled, true);
  assert.equal(noGh[0].disabled, false);
});

test('gh problems explain themselves, including the detected version and the minimum', () => {
  assert.equal(accountsLib.ghProblem({ state: 'ok', version: '2.45.0' }), null);
  assert.match(accountsLib.ghProblem({ state: 'missing' }), /not installed/);
  const old = accountsLib.ghProblem({ state: 'too-old', version: '2.39.0' }, '2.40.0');
  assert.match(old, /2\.39\.0/); assert.match(old, /2\.40\.0/);
});

test('the card result maps each check to a tone and whether it blocks', () => {
  const project = { githubAccount: 'acme-hr' };
  const check = (extra) => ({ status: 'ok', account: 'acme-hr', repository: 'o/r', ownerMismatch: false, blocks: false, message: 'Account acme-hr can push to o/r.', checkedAt: 'now', ...extra });
  assert.deepEqual(accountsLib.cardResult({ githubAccount: null }, null), { tone: 'neutral', text: 'This project uses the machine default GitHub identity.', blocks: false });
  assert.equal(accountsLib.cardResult(project, check({})).tone, 'good');
  const mismatch = accountsLib.cardResult(project, check({ ownerMismatch: true }));
  assert.deepEqual([mismatch.tone, mismatch.blocks], ['warning', false]);
  assert.deepEqual([accountsLib.cardResult(project, check({ status: 'no-access', blocks: true })).tone, accountsLib.cardResult(project, check({ status: 'signed-out', blocks: true })).blocks], ['bad', true]);
  assert.match(accountsLib.cardResult(project, 'checking').text, /Checking/);
});

test('Re-check is off for Machine default and when gh is unavailable', () => {
  assert.equal(accountsLib.canRecheck({ githubAccount: null }, result([])), false);
  assert.equal(accountsLib.canRecheck({ githubAccount: 'a' }, result([], { state: 'missing' })), false);
  assert.equal(accountsLib.canRecheck({ githubAccount: 'a' }, result([account('a')])), true);
});

test('identity drafts follow the daemon rules; labels and the copy command are exact', () => {
  assert.equal(accountsLib.identityDraftError({ name: 'A', email: 'a@b.c' }), null);
  for (const draft of [{ name: '', email: 'a@b.c' }, { name: 'a<b', email: 'a@b.c' }, { name: 'A', email: 'a' }, { name: 'A', email: 'a@@b' }, { name: 'A', email: 'a b@c' }]) assert.ok(accountsLib.identityDraftError(draft), JSON.stringify(draft));
  assert.equal(accountsLib.usedByLabel(0), 'Not used by any project');
  assert.equal(accountsLib.usedByLabel(1), 'Used by 1 project');
  assert.equal(accountsLib.usedByLabel(3), 'Used by 3 projects');
  assert.equal(accountsLib.accountStatusLabel({ signedIn: false }), 'Needs sign-in');
  assert.equal(accountsLib.GH_LOGIN_COMMAND, 'gh auth login -h github.com');
});

test('the store loads accounts, saves and resets an identity, and sets and checks a project account', async () => {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], githubAccounts: null, githubAccountChecks: {}, ...CLEAN_ERROR_STATE });
  await useWorldStore.getState().addProject('HR', 'https://github.com/acme/hr');
  const id = useWorldStore.getState().projects.at(-1).id;

  await useWorldStore.getState().loadGithubAccounts();
  assert.deepEqual(useWorldStore.getState().githubAccounts.accounts.map((a) => a.login), ['personal', 'acme-hr']);

  assert.equal(await useWorldStore.getState().saveGithubIdentity('acme-hr', { name: 'HR Bot', email: 'hr@acme.test' }), true);
  assert.equal(useWorldStore.getState().githubAccounts.accounts[1].identity.name, 'HR Bot');
  assert.equal(await useWorldStore.getState().resetGithubIdentity('acme-hr'), true);
  assert.equal(useWorldStore.getState().githubAccounts.accounts[1].hasCustomIdentity, false);

  assert.equal(await useWorldStore.getState().saveGithubIdentity('acme-hr', { name: '', email: 'bad' }), false);
  assert.ok(reportedError());

  assert.equal(await useWorldStore.getState().setProjectGithubAccount(id, 'acme-hr'), true);
  assert.equal(useWorldStore.getState().projects.find((p) => p.id === id).githubAccount, 'acme-hr');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(useWorldStore.getState().githubAccountChecks[id].status, 'ok');

  stub.githubAccountChecks.set(id, { status: 'signed-out', account: 'acme-hr', repository: 'acme/hr', ownerMismatch: false, blocks: true, message: 'signed out', checkedAt: 'now' });
  await useWorldStore.getState().checkProjectGithubAccount(id);
  assert.equal(accountsLib.cardResult({ githubAccount: 'acme-hr' }, useWorldStore.getState().githubAccountChecks[id]).blocks, true);

  assert.equal(await useWorldStore.getState().setProjectGithubAccount(id, 'nobody'), false);
  assert.equal(await useWorldStore.getState().setProjectGithubAccount(id, null), true);
  assert.equal(useWorldStore.getState().projects.find((p) => p.id === id).githubAccount, null);
  assert.equal(useWorldStore.getState().githubAccountChecks[id], undefined);
});

test('source wiring: third Settings tab, project card in the Git provider section, and no token is read anywhere', async () => {
  const settings = await readFile(new URL('../src/ui/SettingsPanel.tsx', import.meta.url), 'utf8');
  assert.match(settings, /label: 'GitHub accounts'/);
  const section = await readFile(new URL('../src/ui/project-popup/SettingsPanel.tsx', import.meta.url), 'utf8');
  assert.match(section, /<GithubAccountCard project=\{project\} \/>/);
  const card = await readFile(new URL('../src/ui/project-popup/GithubAccountCard.tsx', import.meta.url), 'utf8');
  assert.match(card, /aria-label="GitHub account"/);
  for (const file of ['../src/lib/githubAccounts.ts', '../src/ui/GithubAccountsSettings.tsx', '../src/ui/project-popup/GithubAccountCard.tsx']) {
    assert.doesNotMatch(await readFile(new URL(file, import.meta.url), 'utf8'), /\.token\b|\btoken\s*[:=]/i, file);
  }
});
