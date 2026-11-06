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

const lib = await import('../src/lib/footerPullRequests.ts');
const { createPrReadings, EMPTY_READING } = await import('../src/lib/pullRequests.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { ageLabel, createFooterPrPoller, eligibleProjects, lastCheckedText, moreRowText, nextRowIndex, prGoneNotice, prRowAccessibleName, prsTriggerLabel, resolveHighlight, sortRows, summarizeFooterPrs, unavailableRowText, MAX_ROWS_PER_PROJECT } = lib;
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const proj = (id, name = id, extra = {}) => ({ id, name, repositoryUrl: `https://github.com/o/${id}`, ...extra });
const pr = (number, createdAt = `2026-01-${String(number).padStart(2, '0')}T00:00:00.000Z`, extra = {}) => ({ number, title: `PR ${number}`, headBranch: `f/${number}`, baseBranch: 'main', author: 'octo', url: `https://github.com/o/r/pull/${number}`, isDraft: false, createdAt, updatedAt: createdAt, ...extra });
const reading = (pullRequests, extra = {}) => ({ ...EMPTY_READING, count: pullRequests.length, pullRequests, checkedAt: '2026-02-01T00:00:00.000Z', ...extra });
const ok = (pullRequests, extra = {}) => ({ count: pullRequests.length, pullRequests, truncated: false, checkedAt: '2026-02-01T00:00:00.000Z', ...extra });
const failure = (error = 'boom') => ({ count: null, pullRequests: [], truncated: false, checkedAt: '2026-02-01T00:05:00.000Z', error });
const summary = (projects, map) => summarizeFooterPrs(projects, (id) => map[id] ?? EMPTY_READING);

test('count: sum over successful readings; a real zero is not unavailable; unavailable is never added (U1-U4)', () => {
  const ps = [proj('a'), proj('b'), proj('c')];
  assert.equal(summary(ps, { a: reading([pr(1), pr(2)]), b: reading([pr(3)]), c: reading([]) }).total, 3);
  const zero = summary(ps, { a: reading([]), b: reading([]), c: reading([]) });
  assert.deepEqual([zero.total, zero.unavailable, zero.groups.length], [0, 0, 0]);
  const all = summary(ps, { a: { ...EMPTY_READING, error: 'x' }, b: { ...EMPTY_READING, error: 'x' }, c: { ...EMPTY_READING, error: 'x' } });
  assert.deepEqual([all.total, all.unavailable], [0, 3]);
  assert.equal(prsTriggerLabel(all), '0 open pull requests, 3 projects unavailable');
  const mixed = summary(ps, { a: reading([pr(1)]), b: { ...EMPTY_READING, error: 'gh missing' }, c: reading([]) });
  assert.deepEqual([mixed.total, mixed.unavailable], [1, 1]);
  assert.equal(prsTriggerLabel(mixed), '1 open pull requests, 1 project unavailable');
  assert.equal(prsTriggerLabel(zero), '0 open pull requests');
});

test('eligibility: no repository or an unrecognised one is left out; none eligible hides the item (U5-U7)', () => {
  const ps = [proj('a'), { id: 'n', name: 'n' }, proj('x', 'x', { repositoryUrl: 'https://gitlab.com/o/x' })];
  assert.deepEqual(eligibleProjects(ps).map((p) => p.id), ['a']);
  const s = summary(ps, { n: reading([pr(1)]), x: reading([pr(2)]), a: reading([]) });
  assert.equal(s.visible, true);
  assert.equal(s.total, 0);
  assert.equal(summary([ps[1], ps[2]], {}).visible, false);
  assert.equal(summary([], {}).visible, false);
});

test('first load is Checking, not zero or unavailable; error with older data is unavailable; loading keeps old rows (U8-U10)', () => {
  const first = summary([proj('a')], {});
  assert.deepEqual([first.total, first.unavailable, first.checking, first.groups[0].state], [0, 0, 1, 'checking']);
  assert.equal(prsTriggerLabel(first), '0 open pull requests, 1 project checking');
  const stale = summary([proj('a')], { a: reading([pr(1)], { error: 'network' }) });
  assert.deepEqual([stale.total, stale.unavailable, stale.groups[0].rows.length, stale.groups[0].reason], [0, 1, 0, 'network']);
  const inflight = summary([proj('a')], { a: reading([pr(1), pr(2)], { loading: true }) });
  assert.deepEqual([inflight.total, inflight.groups[0].rows.length], [2, 2]);
});

test('headings A-Z case-insensitive, ties by id, odd names stay stable (U11-U13, U17)', () => {
  const ps = [proj('z1', 'Zephyr'), proj('b1', 'beacon'), proj('a1', 'Atlas'), proj('t2', 'api'), proj('t1', 'API'), proj('e', ''), proj('p10', 'p10'), proj('p2', 'p2'), proj('em', '🚀'), proj('ac', 'Éclair')];
  const map = Object.fromEntries(ps.map((p) => [p.id, reading([pr(1)])]));
  const names = summary(ps, map).groups.map((g) => g.projectName);
  assert.deepEqual(names.slice(0, 1), ['']);
  assert.deepEqual(names.filter((n) => /^(Atlas|beacon|Zephyr)$/.test(n)), ['Atlas', 'beacon', 'Zephyr']);
  const tie = summary([proj('t2', 'api'), proj('t1', 'API')], { t1: reading([pr(1)]), t2: reading([pr(1)]) });
  assert.deepEqual(tie.groups.map((g) => g.projectId), ['t1', 't2']);
  assert.equal(summary([proj('a'), proj('b')], { a: reading([pr(1), pr(2)]), b: reading([]) }).groups.length, 1);
  assert.equal(summary([proj('a')], { a: reading([pr(1), pr(2)]) }).groups[0].count, 2);
});

test('rows: newest first; missing or unparseable createdAt last by number desc; equal times by number desc (U14-U16, U51)', () => {
  const rows = sortRows([pr(1, '2026-01-01T00:00:00Z'), pr(2, '2026-01-03T00:00:00Z'), pr(3, ''), pr(4, 'not a date'), pr(5, '2026-01-03T00:00:00Z')]);
  assert.deepEqual(rows.map((r) => r.number), [5, 2, 1, 4, 3]);
  assert.deepEqual(sortRows([pr(0, ''), pr(Number.MAX_SAFE_INTEGER, ''), pr(1, '')]).map((r) => r.number), [Number.MAX_SAFE_INTEGER, 1, 0]);
  const dup = summary([proj('a'), proj('b')], { a: reading([pr(7)]), b: reading([pr(7)]) });
  assert.deepEqual(dup.groups.map((g) => g.rows[0].number), [7, 7]);
});

test('per-project cap of 50 with a "+N more" count, also for a truncated reading (U18, U19)', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => pr(i + 1, `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`));
  assert.equal(MAX_ROWS_PER_PROJECT, 50);
  const fifty = summary([proj('a')], { a: reading(many(50)) }).groups[0];
  assert.deepEqual([fifty.rows.length, fifty.hiddenCount], [50, 0]);
  const fiftyOne = summary([proj('a')], { a: reading(many(51)) }).groups[0];
  assert.deepEqual([fiftyOne.rows.length, fiftyOne.hiddenCount], [50, 1]);
  assert.equal(moreRowText(1), '+1 more, open the PR tab');
  const big = summary([proj('a')], { a: reading(many(10), { count: 2 ** 31, truncated: true }) });
  assert.equal(big.groups[0].hiddenCount, 2 ** 31 - 10);
  assert.equal(big.total, 2 ** 31);
});

test('age labels at their boundaries, clamped future and unusable dates (U20, U21)', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  const M = 60_000; const H = 60 * M; const D = 24 * H;
  assert.deepEqual([30_000, M, 59 * M, H, 23 * H, 24 * H, 6 * D, 7 * D, 29 * D, 30 * D, 364 * D, 365 * D].map((ms) => ageLabel(ago(ms), now)), ['now', '1m', '59m', '1h', '23h', '1d', '6d', '1w', '4w', '1mo', '12mo', '1y']);
  assert.equal(ageLabel(new Date(now + D).toISOString(), now), 'now');
  assert.equal(ageLabel('', now), '');
  assert.equal(ageLabel('garbage', now), '');
  assert.equal(ageLabel('1970-01-01T00:00:00Z', now), '56y');
  assert.equal(ageLabel('9999-12-31T00:00:00Z', now), 'now');
});

test('accessible names and row text (U22-U24, U27, U28)', () => {
  assert.equal(prRowAccessibleName({ number: 12, title: 'Title', isDraft: true }, 'Name'), '#12 Title, project Name, draft');
  assert.equal(prRowAccessibleName({ number: 12, title: 'Title', isDraft: false }, 'Name'), '#12 Title, project Name');
  const long = 'x'.repeat(600);
  const group = summary([proj('a')], { a: reading([pr(1, undefined, { title: long, author: null, isDraft: true })]) }).groups[0];
  assert.equal(group.rows[0].title, long);
  assert.equal(group.rows[0].author, null);
  assert.equal(group.rows[0].branches, 'f/1 → main');
  assert.equal(unavailableRowText('gh is not signed in'), 'unavailable: gh is not signed in');
  assert.equal(unavailableRowText(undefined), 'unavailable: Could not check pull requests.');
  assert.equal(prGoneNotice(9), 'Pull request #9 is no longer open.');
});

test('last checked: oldest of the eligible, ignores unchecked, stale only above 5 minutes (U25, U26)', () => {
  const s = summary([proj('a'), proj('b'), proj('c')], { a: reading([], { checkedAt: '2026-02-01T00:10:00Z' }), b: reading([], { checkedAt: '2026-02-01T00:02:00Z' }), c: EMPTY_READING });
  assert.equal(s.oldestCheckedAt, '2026-02-01T00:02:00Z');
  assert.equal(summary([proj('a')], {}).oldestCheckedAt, null);
  const base = Date.parse('2026-02-01T00:00:00Z');
  const at = (ms) => lastCheckedText('2026-02-01T00:00:00Z', base + ms);
  assert.deepEqual([at(299_000).stale, at(300_000).stale, at(301_000).stale], [false, false, true]);
  assert.equal(lastCheckedText(null, base).text, 'Not checked yet');
  assert.equal(lastCheckedText(null, base).stale, false);
});

test('arrow-key index helper wraps (U30)', () => {
  assert.deepEqual([['ArrowDown', 0], ['ArrowDown', 2], ['ArrowUp', 0], ['ArrowUp', 2], ['Home', 1], ['End', 1]].map(([k, c]) => nextRowIndex(c, 3, k)), [1, 0, 2, 1, 0, 2]);
  assert.equal(nextRowIndex(-1, 3, 'ArrowDown'), 0);
  assert.equal(nextRowIndex(-1, 3, 'ArrowUp'), 2);
  assert.equal(nextRowIndex(0, 0, 'ArrowDown'), -1);
});

test('highlight resolution: found, gone, unlisted, wait (U47)', () => {
  const r = reading([pr(1)]);
  assert.deepEqual(resolveHighlight(r, 1), { kind: 'found' });
  assert.deepEqual(resolveHighlight(r, 2), { kind: 'gone' });
  assert.deepEqual(resolveHighlight({ ...r, truncated: true }, 2), { kind: 'unlisted' });
  assert.deepEqual(resolveHighlight({ ...r, loading: true }, 2), { kind: 'wait' });
  assert.deepEqual(resolveHighlight(EMPTY_READING, 1), { kind: 'wait' });
  assert.deepEqual(resolveHighlight({ ...EMPTY_READING, error: 'x' }, 1), { kind: 'wait' });
});

/* ---------- poller with an injected clock ---------- */

function fakeEnvironment(visible = true) {
  let clock = 0;
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  const environment = {
    isVisible: () => visible,
    onVisibilityChange: (l) => { listeners.add(l); return () => listeners.delete(l); },
    setTimeout: (cb, ms) => { const id = nextId++; pending.set(id, { at: clock + ms, cb }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
  };
  return {
    environment,
    pendingCount: () => pending.size,
    listenerCount: () => listeners.size,
    setVisible(value) { visible = value; listeners.forEach((l) => l()); },
    async advance(ms) {
      const target = clock + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        clock = due[1].at;
        due[1].cb();
        await Promise.resolve();
      }
      clock = target;
    },
  };
}

function pollerHarness({ projects, visible = true, respond = async () => ok([]), ...options }) {
  const env = fakeEnvironment(visible);
  const calls = [];
  const state = { projects };
  const poller = createFooterPrPoller({
    fetch: async (id, o) => { calls.push({ id, ...o, at: undefined }); return respond(id, o); },
    getProjects: () => state.projects,
    environment: env.environment,
    ...options,
  });
  return { env, calls, state, poller };
}

test('on load every eligible project is fetched, staggered, none at the same instant (U31, U33)', async () => {
  const h = pollerHarness({ projects: [proj('a'), proj('b'), proj('c'), { id: 'n', name: 'n' }] });
  h.poller.start();
  assert.deepEqual(h.calls.map((c) => c.id), ['a']);
  await h.env.advance(250);
  assert.deepEqual(h.calls.map((c) => c.id), ['a', 'b']);
  await h.env.advance(250);
  assert.deepEqual(h.calls.map((c) => [c.id, c.force]), [['a', false], ['b', false], ['c', false]]);
});

test('each project is refetched about every minute, spread across the minute (U34)', async () => {
  const h = pollerHarness({ projects: [proj('a'), proj('b')] });
  h.poller.start();
  await h.env.advance(59_999);
  assert.equal(h.calls.length, 2);
  await h.env.advance(1);
  assert.deepEqual(h.calls.slice(2).map((c) => [c.id, c.force]), [['a', true]]);
  await h.env.advance(30_000);
  assert.deepEqual(h.calls.slice(2).map((c) => c.id), ['a', 'b']);
  await h.env.advance(30_000);
  assert.deepEqual(h.calls.slice(4).map((c) => c.id), ['a']);
});

test('many projects keep requests in flight at or below the bound (U32)', async () => {
  const projects = Array.from({ length: 200 }, (_, i) => proj(`p${i}`));
  let active = 0;
  let peak = 0;
  const release = [];
  const h = pollerHarness({ projects, respond: () => new Promise((resolve) => { active++; peak = Math.max(peak, active); release.push(() => { active--; resolve(); }); }) });
  h.poller.start();
  await h.env.advance(60_000);
  assert.equal(peak, 4);
  assert.equal(active, 4);
  while (release.length) { release.shift()(); await Promise.resolve(); await Promise.resolve(); }
  assert.ok(peak <= 4);
});

test('a hidden page runs nothing; showing it fetches again and restarts the schedule (U35, U36)', async () => {
  const h = pollerHarness({ projects: [proj('a')] });
  h.poller.start();
  assert.equal(h.calls.length, 1);
  h.env.setVisible(false);
  assert.equal(h.env.pendingCount(), 0);
  await h.env.advance(180_000);
  assert.equal(h.calls.length, 1);
  h.env.setVisible(true);
  assert.deepEqual(h.calls.slice(1).map((c) => c.force), [true]);
  await h.env.advance(60_000);
  assert.equal(h.calls.length, 3);
  const hidden = pollerHarness({ projects: [proj('a')], visible: false });
  hidden.poller.start();
  assert.equal(hidden.calls.length, 0);
});

test('added projects are fetched at once; deleted ones are no longer polled; repository changes refetch (U37-U39)', async () => {
  const h = pollerHarness({ projects: [proj('a')] });
  h.poller.start();
  h.state.projects = [proj('a'), proj('b')];
  h.poller.sync();
  assert.deepEqual(h.calls.slice(1).map((c) => [c.id, c.force]), [['b', false]]);
  h.poller.sync();
  assert.equal(h.calls.length, 2);
  h.state.projects = [proj('a', 'a', { repositoryUrl: 'https://github.com/o/other' }), proj('b')];
  h.poller.sync();
  assert.deepEqual(h.calls.slice(2).map((c) => [c.id, c.force]), [['a', true]]);
  h.state.projects = [proj('a', 'a', { repositoryUrl: 'https://github.com/o/other' })];
  h.poller.sync();
  await h.env.advance(60_000);
  assert.ok(h.calls.slice(3).every((c) => c.id === 'a'));
  h.state.projects = [{ id: 'a', name: 'a' }];
  await h.env.advance(120_000);
  assert.ok(h.calls.slice(3).filter((c) => c.id === 'a').length <= 1);
});

test('refresh all is forced, staggered, and a failing project does not stop the others (U41)', async () => {
  const h = pollerHarness({ projects: [proj('a'), proj('b'), proj('c')], respond: async (id) => { if (id === 'a') throw new Error('boom'); return ok([]); } });
  h.poller.start();
  await h.env.advance(500);
  const before = h.calls.length;
  h.poller.refreshAll();
  assert.equal(h.calls.length, before + 1);
  await h.env.advance(500);
  assert.deepEqual(h.calls.slice(before).map((c) => [c.id, c.force]), [['a', true], ['b', true], ['c', true]]);
});

test('stop clears every timer and the visibility subscription (U45); sync after stop does nothing', async () => {
  const h = pollerHarness({ projects: [proj('a'), proj('b')] });
  const stop = h.poller.start();
  stop();
  assert.equal(h.env.pendingCount(), 0);
  assert.equal(h.env.listenerCount(), 0);
  h.state.projects = [proj('c')];
  h.poller.sync();
  await h.env.advance(120_000);
  assert.equal(h.calls.length, 1);
});

/* ---------- shared readings: coalescing, one source, provider change (U40, U42-U44, I1-I8) ---------- */

test('footer and PR tab share one reading: a fetch from either updates both with one request (U43, U44, I4)', async () => {
  let requests = 0;
  let release;
  const readings = createPrReadings(() => { requests++; return new Promise((resolve) => { release = () => resolve(ok([pr(1)])); }); });
  let notified = 0;
  readings.subscribe(() => { notified++; });
  const footer = readings.fetch('a', { provider: 'github', force: true });
  const tab = readings.fetch('a', { provider: 'github', force: true });
  assert.equal(requests, 1);
  release();
  await Promise.all([footer, tab]);
  assert.ok(notified >= 2);
  assert.equal(summary([proj('a')], { a: readings.get('a') }).total, 1);
});

test('footer summary follows readings: failures stay unavailable, provider change clears and refetches (U40, I1-I3, I8)', async () => {
  const responses = { a: ok([pr(1), pr(2)]), b: failure('gh is not signed in'), c: ok([]) };
  const readings = createPrReadings(async (id) => responses[id]);
  const ps = [proj('a'), proj('b'), proj('c')];
  await Promise.all(ps.map((p) => readings.fetch(p.id, { provider: 'github' })));
  const s = summarizeFooterPrs(ps, readings.get);
  assert.deepEqual([s.total, s.unavailable], [2, 1]);
  assert.equal(s.groups.find((g) => g.projectId === 'b').reason, 'gh is not signed in');
  await readings.fetch('a', { provider: 'other' });
  assert.equal(readings.get('a').count, 2);
});

test('a request that rejects reads as unavailable, not zero (I2)', async () => {
  const readings = createPrReadings(async () => { throw new Error('offline'); });
  await readings.fetch('a', { provider: 'github' });
  const s = summarizeFooterPrs([proj('a')], readings.get);
  assert.deepEqual([s.total, s.unavailable], [0, 1]);
});

test('a PR that vanishes between readings is gone on the next successful reading (I10)', async () => {
  let list = [pr(1), pr(2)];
  const readings = createPrReadings(async () => ok(list));
  await readings.fetch('a', { provider: 'github' });
  assert.deepEqual(resolveHighlight(readings.get('a'), 2), { kind: 'found' });
  list = [pr(1)];
  await readings.fetch('a', { provider: 'github', force: true });
  assert.deepEqual(resolveHighlight(readings.get('a'), 2), { kind: 'gone' });
});

/* ---------- navigation through the store (U46, U48-U50, I6, I9) ---------- */

const T = '2026-10-04T10:00:00.000Z';
const storeProject = (id) => ({ id, name: id, slug: id, relativePath: `projects/${id}`, status: 'idle', position: null, activeTaskId: null, taskCount: 0, createdAt: T, updatedAt: T });

test('a row click opens the workspace on the PR tab and records one pending highlight; a later click replaces it (U46, U48, I9)', () => {
  useWorldStore.setState({ projects: [storeProject('a'), storeProject('b')], workspaceProjectId: null, workspaceTab: 'tasks', prHighlightRequest: null });
  useWorldStore.getState().openPullRequestFromFooter('a', 5);
  let state = useWorldStore.getState();
  assert.deepEqual([state.workspaceProjectId, state.workspaceTab, state.prHighlightRequest], ['a', 'pr', { projectId: 'a', number: 5 }]);
  useWorldStore.getState().clearPrHighlightRequest();
  assert.equal(useWorldStore.getState().prHighlightRequest, null);
  useWorldStore.getState().openPullRequestFromFooter('a', 5);
  useWorldStore.getState().openPullRequestFromFooter('b', 7);
  state = useWorldStore.getState();
  assert.deepEqual([state.workspaceProjectId, state.prHighlightRequest], ['b', { projectId: 'b', number: 7 }]);
  useWorldStore.getState().openPullRequestFromFooter('b', null);
  assert.equal(useWorldStore.getState().prHighlightRequest.number, null);
  useWorldStore.getState().openWorkspace('a');
  assert.equal(useWorldStore.getState().prHighlightRequest, null);
});

test('a click on a deleted project is a no-op (U50); a deleted project leaves the summary at once (I6)', () => {
  useWorldStore.setState({ projects: [storeProject('a')], workspaceProjectId: null, prHighlightRequest: null });
  useWorldStore.getState().openPullRequestFromFooter('gone', 1);
  assert.equal(useWorldStore.getState().workspaceProjectId, null);
  assert.equal(useWorldStore.getState().prHighlightRequest, null);
  assert.equal(summary([], { a: reading([pr(1)]) }).total, 0);
});

/* ---------- source-level checks of the components (C1-C14) ---------- */

test('the footer wires a PRs count group, popover shell, polling and no looping animation (C1-C4, C11, C13)', async () => {
  const footer = await read('../src/ui/StatusFooter.tsx');
  const popover = await read('../src/ui/FooterPullRequestsPopover.tsx');
  const shell = await read('../src/ui/FooterCountPopover.tsx');
  assert.match(footer, /prs\.visible && \(\s*<CountGroup ariaLabel="Open pull requests across all projects" heading="PRs">/);
  assert.ok(footer.indexOf('heading="Commands"') < footer.indexOf('heading="PRs"'));
  assert.match(footer, /<FooterCountPopover id="pull-requests-open" label=\{prsTriggerLabel\(prs\)\} state=\{popover\} dispatch=\{dispatch\}/);
  assert.match(footer, /useFooterPrPolling\(\);/);
  assert.match(footer, /<footer\s+data-status-footer/);
  assert.doesNotMatch(footer + popover, /animate-|animation/);
  assert.match(popover, /aria-label=\{prRowAccessibleName\(row, group\.projectName\)\}/);
  assert.match(popover, /title=\{row\.title\}/);
  assert.match(popover, /className="min-w-0 flex-1 truncate font-medium"/);
  assert.match(popover, /onClick=\{\(\) => onOpen\(group\.projectId, row\.number\)\}/);
  assert.match(popover, /const onOpen = .*\{ onDone\(\); open\(projectId, number\); \}/);
  assert.match(popover, /onClick=\{refreshAllPullRequests\}>Refresh all/);
  assert.match(popover, /<p className="px-2 py-2 italic text-muted-foreground">\{EMPTY_PRS_MESSAGE\}/);
  assert.match(popover, /Checking…/);
  assert.match(popover, /unavailableRowText\(group\.reason\)/);
  assert.match(shell, /isolateScroll/);
  assert.match(shell, /max-h-\[min\(24rem/);
  assert.match(shell, /ArrowDown/);
  assert.match(shell, /focusRowsOnOpen/);
  assert.match(shell, /key !== 'Escape'/);
});

test('the PR tab consumes the highlight with scroll, aria-current, focus and a status notice (C10)', async () => {
  const panel = await read('../src/ui/project-popup/PrPanel.tsx');
  assert.match(panel, /resolveHighlight\(reading, number\)/);
  assert.match(panel, /scrollIntoView/);
  assert.match(panel, /aria-current=\{highlighted \? 'true' : undefined\}/);
  assert.match(panel, /\{goneNotice && \(\s*<div role="status"/);
  assert.match(panel, /clearHighlightRequest\(\);/);
});

test('the blueprint documents the PRs footer item, count semantics and polling (C14)', async () => {
  const blueprint = await read('../../.docs/blueprint.md');
  assert.match(blueprint, /\*\*PRs group/);
  assert.match(blueprint, /Refresh all/);
});
