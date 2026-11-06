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

const lib = await import('../src/lib/pullRequests.ts');
const { applyResponse, branchLabel, createPrReadings, EMPTY_READING, moreThanShownNote, prRowLabel, prTabAccessibleName, prTabLabel, prViewState, relativeCheckTime, sortNewestFirst, startPolling, workspaceTabs } = lib;

const pr = (number, createdAt = `2026-01-0${number}T00:00:00.000Z`, extra = {}) => ({ number, title: `PR ${number}`, headBranch: `f/${number}`, baseBranch: 'main', author: 'octo', url: `https://github.com/o/r/pull/${number}`, isDraft: false, createdAt, updatedAt: createdAt, ...extra });
const ok = (pullRequests, extra = {}) => ({ count: pullRequests.length, pullRequests, truncated: false, checkedAt: '2026-02-01T00:00:00.000Z', ...extra });
const failure = (error = 'boom') => ({ count: null, pullRequests: [], truncated: false, checkedAt: '2026-02-01T00:05:00.000Z', error });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('labels: count, zero and unavailable are distinct, in the visible and accessible names', () => {
  assert.equal(prTabLabel({ count: 3 }), 'PR 3');
  assert.equal(prTabLabel({ count: 0 }), 'PR 0');
  assert.equal(prTabLabel({ count: null }), 'PR');
  assert.equal(prTabAccessibleName({ count: 3 }), 'PR, 3 open');
  assert.equal(prTabAccessibleName({ count: 0 }), 'PR, 0 open');
  assert.equal(prTabAccessibleName({ count: null }), 'PR');
});

test('row text: number and title, branches, and the more-than-shown note', () => {
  assert.equal(prRowLabel({ number: 12, title: 'Add login page' }), '#12 Add login page');
  assert.equal(branchLabel({ headBranch: 'feature', baseBranch: 'main' }), 'feature → main');
  assert.equal(moreThanShownNote({ truncated: true, pullRequests: new Array(100).fill(0) }), 'Showing newest 100 of more than 100');
  assert.equal(moreThanShownNote({ truncated: false, pullRequests: [pr(1)] }), null);
});

test('sortNewestFirst orders by creation time, then higher number, without mutating', () => {
  const input = [pr(1, '2026-01-01T00:00:00Z'), pr(2, '2026-01-03T00:00:00Z'), pr(3, '2026-01-03T00:00:00Z')];
  assert.deepEqual(sortNewestFirst(input).map((p) => p.number), [3, 2, 1]);
  assert.deepEqual(input.map((p) => p.number), [1, 2, 3]);
});

test('relativeCheckTime wording', () => {
  const now = Date.parse('2026-01-01T00:10:00Z');
  assert.equal(relativeCheckTime('', now), 'Not checked yet');
  assert.equal(relativeCheckTime('2026-01-01T00:09:58Z', now), 'Last checked just now');
  assert.equal(relativeCheckTime('2026-01-01T00:09:30Z', now), 'Last checked 30 seconds ago');
  assert.equal(relativeCheckTime('2026-01-01T00:09:00Z', now), 'Last checked 1 minute ago');
  assert.equal(relativeCheckTime('2026-01-01T00:07:00Z', now), 'Last checked 3 minutes ago');
});

test('applyResponse: success replaces and sorts; failure keeps list, count and last-good time', () => {
  const good = applyResponse(EMPTY_READING, ok([pr(1), pr(2)]));
  assert.deepEqual(good.pullRequests.map((p) => p.number), [2, 1]);
  assert.equal(good.count, 2);
  const failed = applyResponse({ ...good, loading: true }, failure('rate limit'));
  assert.equal(failed.count, 2);
  assert.equal(failed.pullRequests.length, 2);
  assert.equal(failed.checkedAt, good.checkedAt);
  assert.equal(failed.error, 'rate limit');
  assert.equal(failed.loading, false);
  const firstFailure = applyResponse(EMPTY_READING, failure());
  assert.equal(firstFailure.count, null);
  assert.deepEqual(firstFailure.pullRequests, []);
  assert.equal(firstFailure.checkedAt, '');
});

test('prViewState distinguishes loading, ready, empty and both error shapes', () => {
  assert.equal(prViewState(EMPTY_READING), 'loading');
  assert.equal(prViewState({ ...EMPTY_READING, loading: true }), 'loading');
  assert.equal(prViewState(applyResponse(EMPTY_READING, ok([pr(1)]))), 'ready');
  assert.equal(prViewState(applyResponse(EMPTY_READING, ok([]))), 'empty');
  assert.equal(prViewState(applyResponse(applyResponse(EMPTY_READING, ok([pr(1)])), failure())), 'error-with-data');
  assert.equal(prViewState(applyResponse(EMPTY_READING, failure())), 'error-no-data');
});

test('workspaceTabs: Schedules, Connections and Activity are not tabs; PR follows Code; hidden without a recognised repository; Archived last', () => {
  const reading = applyResponse(EMPTY_READING, ok([pr(1), pr(2), pr(3)]));
  const keys = (project, hasArchived = false) => workspaceTabs(project, { reading, hasArchived }).map((tab) => tab.key);
  assert.deepEqual(keys({ repositoryUrl: 'https://github.com/o/r' }), ['tasks', 'documents', 'testing', 'code', 'pr', 'settings']);
  assert.deepEqual(keys({ repositoryUrl: 'https://github.com/o/r' }, true), ['tasks', 'documents', 'testing', 'code', 'pr', 'settings', 'archived']);
  assert.deepEqual(keys({}), ['tasks', 'documents', 'testing', 'code', 'settings']);
  assert.deepEqual(keys({ repositoryUrl: 'https://gitlab.com/o/r' }), ['tasks', 'documents', 'testing', 'code', 'settings']);
  const pr_ = workspaceTabs({ repositoryUrl: 'https://github.com/o/r' }, { reading, hasArchived: false }).find((tab) => tab.key === 'pr');
  assert.deepEqual(pr_, { key: 'pr', label: 'PR 3', ariaLabel: 'PR, 3 open' });
  const unknown = workspaceTabs({ repositoryUrl: 'https://github.com/o/r' }, { reading: EMPTY_READING, hasArchived: false }).find((tab) => tab.key === 'pr');
  assert.equal(unknown.label, 'PR');
});

test('store: concurrent requests for one Project coalesce, other Projects do not', async () => {
  let calls = 0;
  const d = deferred();
  const readings = createPrReadings(() => { calls++; return d.promise; });
  const a = readings.fetch('a', { provider: 'github' });
  const b = readings.fetch('a', { provider: 'github', force: true });
  assert.equal(a, b);
  readings.fetch('b', { provider: 'github' });
  assert.equal(calls, 2);
  d.resolve(ok([pr(1)]));
  assert.equal((await a).count, 1);
  assert.equal(readings.get('a').loading, false);
});

test('store: a good reading is reused for under a minute, refetched after, and force bypasses', async () => {
  let now = 1000;
  let calls = 0;
  const readings = createPrReadings(async () => { calls++; return ok([pr(1)]); }, () => now);
  await readings.fetch('a', { provider: 'github' });
  now += 59_999;
  await readings.fetch('a', { provider: 'github' });
  assert.equal(calls, 1);
  await readings.fetch('a', { provider: 'github', force: true });
  assert.equal(calls, 2);
  now += 60_000;
  await readings.fetch('a', { provider: 'github' });
  assert.equal(calls, 3);
});

test('store: refresh keeps the previous list while loading; a failure keeps it and the last good time', async () => {
  const responses = [ok([pr(1)]), deferred(), deferred()];
  let n = 0;
  const readings = createPrReadings(() => { const next = responses[n++]; return next.promise ?? Promise.resolve(next); });
  await readings.fetch('a', { provider: 'github' });
  const refresh = readings.fetch('a', { provider: 'github', force: true });
  assert.equal(readings.get('a').loading, true);
  assert.equal(readings.get('a').count, 1);
  assert.equal(readings.get('a').pullRequests.length, 1);
  responses[1].resolve(failure('Could not reach GitHub.'));
  const after = await refresh;
  assert.equal(after.error, 'Could not reach GitHub.');
  assert.equal(after.count, 1);
  assert.equal(after.checkedAt, '2026-02-01T00:00:00.000Z');
  // A failure is not cached: the next plain fetch retries.
  const retry = readings.fetch('a', { provider: 'github' });
  responses[2].resolve(ok([]));
  assert.equal((await retry).error, undefined);
  assert.equal(readings.get('a').count, 0);
});

test('store: a rejected request becomes a generic error and the next fetch still works', async () => {
  let n = 0;
  const readings = createPrReadings(async () => { if (n++ === 0) throw new Error('network'); return ok([pr(1)]); });
  const failed = await readings.fetch('a', { provider: 'github' });
  assert.equal(failed.error, 'Could not check pull requests.');
  assert.equal(failed.count, null);
  assert.equal((await readings.fetch('a', { provider: 'github' })).count, 1);
});

test('store: a provider change clears the reading and drops the stale in-flight response', async () => {
  const stale = deferred();
  let n = 0;
  const readings = createPrReadings(() => (n++ === 0 ? stale.promise : Promise.resolve(ok([pr(7)]))));
  readings.fetch('a', { provider: 'github' });
  const fresh = await readings.fetch('a', { provider: 'other' });
  assert.deepEqual(fresh.pullRequests.map((p) => p.number), [7]);
  stale.resolve(ok([pr(1)]));
  await stale.promise;
  assert.deepEqual(readings.get('a').pullRequests.map((p) => p.number), [7]);
});

test('store: readings are per Project and notify subscribers', async () => {
  const readings = createPrReadings(async (id) => ok(id === 'a' ? [pr(1)] : []));
  let notified = 0;
  const unsubscribe = readings.subscribe(() => { notified++; });
  await readings.fetch('a', { provider: 'github' });
  await readings.fetch('b', { provider: 'github' });
  assert.equal(readings.get('a').count, 1);
  assert.equal(readings.get('b').count, 0);
  assert.equal(readings.get('c'), EMPTY_READING);
  const seen = notified;
  assert.ok(seen >= 4);
  unsubscribe();
  await readings.fetch('a', { provider: 'github', force: true });
  assert.equal(notified, seen);
});

function fakeEnvironment(visible = true) {
  const env = { visible, intervals: [], listeners: new Set(), nextId: 1 };
  env.api = {
    isVisible: () => env.visible,
    onVisibilityChange: (listener) => { env.listeners.add(listener); return () => env.listeners.delete(listener); },
    setInterval: (callback, ms) => { const id = env.nextId++; env.intervals.push({ id, callback, ms }); return id; },
    clearInterval: (id) => { env.intervals = env.intervals.filter((entry) => entry.id !== id); },
  };
  env.setVisible = (value) => { env.visible = value; env.listeners.forEach((listener) => listener()); };
  env.tick = () => env.intervals.forEach((entry) => entry.callback());
  return env;
}

test('polling: checks on open, then every minute with force; stops on close', () => {
  const env = fakeEnvironment();
  const calls = [];
  const stop = startPolling((force) => calls.push(force), env.api);
  assert.deepEqual(calls, [false]);
  assert.equal(env.intervals.length, 1);
  assert.equal(env.intervals[0].ms, 60_000);
  env.tick();
  assert.deepEqual(calls, [false, true]);
  stop();
  assert.equal(env.intervals.length, 0);
  assert.equal(env.listeners.size, 0);
  env.tick();
  assert.equal(calls.length, 2);
});

test('polling: pauses while hidden and checks immediately when visible again', () => {
  const env = fakeEnvironment();
  const calls = [];
  startPolling((force) => calls.push(force), env.api);
  env.setVisible(false);
  assert.equal(env.intervals.length, 0);
  env.tick();
  assert.deepEqual(calls, [false]);
  env.setVisible(true);
  assert.deepEqual(calls, [false, true]);
  assert.equal(env.intervals.length, 1);
  env.tick();
  assert.equal(calls.length, 3);
});

test('polling: a workspace opened while hidden waits until the page is shown', () => {
  const env = fakeEnvironment(false);
  const calls = [];
  startPolling((force) => calls.push(force), env.api);
  assert.deepEqual(calls, []);
  assert.equal(env.intervals.length, 0);
  env.setVisible(true);
  assert.deepEqual(calls, [true]);
});

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('workspace wiring: header has only the repository icon link; PR tab and panel are wired', async () => {
  const modal = await source('../src/ui/ProjectWorkspaceModal.tsx');
  assert.match(modal, /<RepositoryLink project=\{project\} \/>/);
  assert.match(modal, /pr: <PrPanel project=\{project\} \/>,/);
  assert.match(modal, /usePrPolling\(project\)/);
  assert.match(await source('../src/ui/WorkspaceBody.tsx'), /aria-label=\{ariaLabel\}/);
  assert.doesNotMatch(modal, /GitHubLinks/);
  const link = await source('../src/ui/project-popup/RepositoryLink.tsx');
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.match(link, /aria-label=\{`Open GitHub repository \$\{link\.slug\} in a new tab`\}/);
  assert.doesNotMatch(link, /GitPullRequest|group-hover|\/pulls/);
});

test('PR panel: shared reading, refresh spinner only while loading, polite status, safe focusable links', async () => {
  const panel = await source('../src/ui/project-popup/PrPanel.tsx');
  assert.match(panel, /usePrReading\(project\.id\)/);
  assert.doesNotMatch(panel, /serverApi\./, 'the panel never calls the daemon itself');
  assert.match(panel, /reading\.loading \? 'animate-spin' : ''/);
  assert.match(panel, /role="status" aria-live="polite"/);
  assert.match(panel, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(panel, /tabIndex=\{-1\}/);
  assert.match(panel, /title=\{prRowLabel\(pr\)\}/);
  assert.match(panel, /pr\.isDraft && <Badge/);
  assert.match(panel, /overflow-y-auto/);
  assert.match(panel, /Newest first/);
  assert.match(panel, /No open pull requests/);
  assert.match(panel, /moreThanShownNote\(reading\)/);
  assert.doesNotMatch(panel, /animate-(pulse|bounce|ping)/);
  // Row actions (Check out, Merge) are covered in pullRequestActions.test.mjs; Refresh itself is never disabled.
  assert.match(panel, /<Button type="button" variant="outline" size="sm" onClick=\{refresh\} aria-label="Refresh open pull requests">/);
});

test('polling hook: visibilitychange listener is removed on cleanup and the old popover code is gone', async () => {
  const hook = await source('../src/lib/usePullRequests.ts');
  assert.match(hook, /addEventListener\('visibilitychange', listener\)/);
  assert.match(hook, /removeEventListener\('visibilitychange', listener\)/);
  const settings = await source('../src/ui/project-popup/SettingsPanel.tsx');
  assert.match(settings, /Git provider/);
  assert.match(settings, /More providers can be added later/);
  assert.match(settings, /setProjectGitProvider\(project\.id, provider\.id\)/);
  // Auto-pull toggle (task 10.014): only for a Project with a repository, wired to the store action.
  assert.match(settings, /\{project\.repositoryUrl && <AutoPullToggle project=\{project\} \/>\}/);
  assert.match(settings, /Auto-pull upstream changes/);
  assert.match(settings, /setProjectAutoPull\(project\.id, event\.target\.checked\)/);
  const { execFileSync } = await import('node:child_process');
  const stale = (() => {
    try { return execFileSync('grep', ['-rlE', 'fetchOpenPrCount|openPrReading|OpenPrCount|githubLinks|GitHubLinks', new URL('../src', import.meta.url).pathname], { encoding: 'utf8' }); }
    catch { return ''; } // grep exits 1 when nothing matches
  })();
  assert.equal(stale, '');
});
