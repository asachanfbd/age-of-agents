import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const {
  describeAppUpdateFooterLabel,
  describeAppUpdatePopover,
  describeBlockingFiles,
  appUpdateActions,
  pluralCommits,
  nextReloadBannerVisibility,
  reconnectBannerVisible,
  reloadBannerVisible,
} = await import('../src/lib/appUpdate.ts');
const { mergeWorkerEvent } = await import('../src/store/worldStore.ts');

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const footer = await read('../src/ui/StatusFooter.tsx');
const appUpdatePopoverSrc = await read('../src/ui/AppUpdatePopover.tsx');
const reloadBannerSrc = await read('../src/ui/AppUpdateReloadBanner.tsx');
const reconnectBannerSrc = await read('../src/ui/AppReconnectBanner.tsx');
const appUpdateSrc = await read('../src/lib/appUpdate.ts');

const ZERO_BLOCKING = { testRuns: 0, commands: 0, terminalSessions: 0 };

/** A full, sane `AppUpdateStatus` with everything a test doesn't care about defaulted — override just what matters. */
function baseStatus(overrides = {}) {
  return {
    mode: 'prod',
    canApply: true,
    applyBlockedReason: null,
    availability: 'up-to-date',
    branch: 'main',
    currentCommit: 'abc1234',
    aheadBy: 0,
    behindBy: 0,
    classification: null,
    installWebDeps: false,
    incomingCommits: [],
    incomingCommitsTruncated: false,
    cantUpdateReason: null,
    blockingFiles: [],
    blockingFilesTotal: 0,
    checkError: null,
    checkedAt: '2026-10-05T00:10:00.000Z',
    lastSuccessfulCheckAt: '2026-10-05T00:10:00.000Z',
    phase: 'idle',
    blocking: ZERO_BLOCKING,
    updatedToCommit: null,
    failureMessage: null,
    failureLogPath: null,
    ...overrides,
  };
}

// ---- 23/24: footer label + color, every state, and commit-count pluralization ----

test('23: label/color mapping covers all nine display states', () => {
  assert.deepEqual(describeAppUpdateFooterLabel(baseStatus({ availability: 'up-to-date' })), { text: 'Up to date', tone: 'muted' });
  assert.deepEqual(
    describeAppUpdateFooterLabel(baseStatus({ availability: 'available', behindBy: 3, classification: 'web-only' })),
    { text: 'Update available (3)', tone: 'warning' },
  );
  assert.deepEqual(
    describeAppUpdateFooterLabel(baseStatus({ phase: 'held', availability: 'available', behindBy: 9, classification: 'server' })),
    { text: 'Update waiting for idle…', tone: 'warning' },
  );
  assert.deepEqual(describeAppUpdateFooterLabel(baseStatus({ phase: 'updating' })), { text: 'Updating…', tone: 'progress' });
  assert.deepEqual(
    describeAppUpdateFooterLabel(baseStatus({ phase: 'updated', updatedToCommit: 'e7c0b82' })),
    { text: 'Updated to e7c0b82', tone: 'success' },
  );
  assert.deepEqual(describeAppUpdateFooterLabel(baseStatus({ phase: 'failed' })), { text: 'Update failed', tone: 'destructive' });
  assert.deepEqual(
    describeAppUpdateFooterLabel(baseStatus({ availability: 'could-not-check', lastSuccessfulCheckAt: null, checkError: 'No network connection.' })),
    { text: "Couldn't check", tone: 'muted' },
  );
  assert.deepEqual(
    describeAppUpdateFooterLabel(baseStatus({ availability: 'could-not-check', checkError: 'No network connection.' })),
    { text: "Couldn't check (showing last known)", tone: 'muted' },
  );
  assert.deepEqual(
    describeAppUpdateFooterLabel(baseStatus({ availability: 'cant-auto-update', behindBy: 4 })),
    { text: "Can't auto-update (4)", tone: 'warning' },
  );
  assert.deepEqual(
    describeAppUpdateFooterLabel(baseStatus({ mode: 'dev', availability: 'available', behindBy: 3, classification: 'web-only' })),
    { text: 'Update available (3) · read only', tone: 'warning' },
  );
});

test('24: singular/plural "N commit(s)" wording', () => {
  assert.equal(pluralCommits(0), '0 commits');
  assert.equal(pluralCommits(1), '1 commit');
  assert.equal(pluralCommits(2), '2 commits');
  assert.equal(describeAppUpdatePopover(baseStatus({ behindBy: 1, branch: 'main' }), Date.now()).behindByText, '1 commit behind origin/main');
  assert.equal(describeAppUpdatePopover(baseStatus({ behindBy: 9, branch: 'main' }), Date.now()).behindByText, '9 commits behind origin/main');
});

// ---- 25: popover content, all read from one AppUpdateStatus ----

test('25: popover content reads branch, behindBy, bounded commits, web-only/server label and blocking breakdown from one status', () => {
  const status = baseStatus({
    availability: 'available',
    behindBy: 9,
    classification: 'server',
    branch: 'main',
    incomingCommits: [{ sha: 'e7c0b82', subject: 'add update checker' }, { sha: '9f2a1c4', subject: 'fix folder gate' }],
    incomingCommitsTruncated: true,
    blocking: { testRuns: 0, commands: 0, terminalSessions: 1 },
  });
  const content = describeAppUpdatePopover(status, Date.parse(status.checkedAt));
  assert.equal(content.branch, 'main');
  assert.equal(content.behindBy, 9);
  assert.equal(content.behindByText, '9 commits behind origin/main');
  assert.equal(content.classificationLabel, 'Includes server changes — needs the daemon to restart');
  assert.deepEqual(content.commits, status.incomingCommits);
  assert.equal(content.commitsTruncatedCount, 7);
  assert.deepEqual(content.blocking, [
    { key: 'testRuns', label: 'Running test runs', count: 0 },
    { key: 'commands', label: 'Running commands', count: 0 },
    { key: 'terminalSessions', label: 'Open terminal sessions', count: 1 },
  ]);

  const webOnly = describeAppUpdatePopover(baseStatus({ availability: 'available', classification: 'web-only' }), Date.now());
  assert.equal(webOnly.classificationLabel, "Web only — won't interrupt any work");

  const devMode = describeAppUpdatePopover(baseStatus({ mode: 'dev', availability: 'available', classification: 'web-only' }), Date.now());
  assert.equal(devMode.classificationLabel, 'Dev mode — read only', 'dev mode overrides the web-only/server badge');
});

// ---- 26: action set per state, exactly the spec's table ----

test('26: action set per state matches the table exactly', () => {
  assert.deepEqual(appUpdateActions(baseStatus({ availability: 'up-to-date' })), ['check']);
  assert.deepEqual(appUpdateActions(baseStatus({ availability: 'cant-auto-update' })), ['check']);
  assert.deepEqual(appUpdateActions(baseStatus({ availability: 'could-not-check' })), ['check']);
  assert.deepEqual(appUpdateActions(baseStatus({ mode: 'dev', availability: 'available', classification: 'web-only' })), ['check']);
  assert.deepEqual(appUpdateActions(baseStatus({ mode: 'dev', availability: 'cant-auto-update' })), ['check'], 'dev mode never offers update/retry, whatever the availability');
  assert.deepEqual(appUpdateActions(baseStatus({ availability: 'available', classification: 'web-only' })), ['update', 'check']);
  assert.deepEqual(appUpdateActions(baseStatus({ availability: 'available', classification: 'server' })), ['updateWhenIdle', 'check']);
  assert.deepEqual(appUpdateActions(baseStatus({ phase: 'held', availability: 'available', classification: 'server' })), ['cancel', 'check']);
  assert.deepEqual(appUpdateActions(baseStatus({ phase: 'updating' })), []);
  assert.deepEqual(appUpdateActions(baseStatus({ phase: 'updated' })), ['check'], 'Code Review round 1 issue 2: "Check now" must never disappear, even right after a success');
  assert.deepEqual(appUpdateActions(baseStatus({ phase: 'failed' })), ['retry', 'check']);
});

// ---- 27: relative "last checked" string, injected clock ----

test('27: relative "last checked" string against an injected clock', () => {
  const now = Date.parse('2026-10-05T00:10:00.000Z');
  assert.equal(describeAppUpdatePopover(baseStatus({ checkedAt: '2026-10-05T00:10:00.000Z' }), now).lastCheckedText, 'Last checked just now');
  assert.equal(describeAppUpdatePopover(baseStatus({ checkedAt: '2026-10-05T00:05:00.000Z' }), now).lastCheckedText, 'Last checked 5 minutes ago');
  assert.equal(describeAppUpdatePopover(baseStatus({ checkedAt: null }), now).lastCheckedText, 'Not checked yet');
});

// ---- 28: reload-banner state machine ----

test('28: reload-banner state machine — served, dismiss, later distinct build re-shows even though the prior one was dismissed', () => {
  const own = 'aaa1111';
  assert.equal(nextReloadBannerVisibility({ ownBuildCommit: own, servingCommit: own, dismissedCommit: null }), 'hidden', 'serving its own build');
  assert.equal(nextReloadBannerVisibility({ ownBuildCommit: own, servingCommit: 'bbb2222', dismissedCommit: null }), 'shown', 'served → shown');
  assert.equal(nextReloadBannerVisibility({ ownBuildCommit: own, servingCommit: 'bbb2222', dismissedCommit: 'bbb2222' }), 'hidden', 'dismiss → hidden');
  assert.equal(
    nextReloadBannerVisibility({ ownBuildCommit: own, servingCommit: 'ccc3333', dismissedCommit: 'bbb2222' }),
    'shown',
    'a later, distinct build re-shows it even though the previous one was dismissed',
  );
  assert.equal(nextReloadBannerVisibility({ ownBuildCommit: own, servingCommit: null, dismissedCommit: null }), 'hidden', 'no status loaded yet');
});

test('28b: reload is a plain navigation the component performs — not something the pure function can call itself', () => {
  assert.match(reloadBannerSrc, /onClick=\{\(\) => window\.location\.reload\(\)\}/);
  assert.doesNotMatch(appUpdateSrc, /location\.reload/, 'the pure lib stays side-effect free; only the component navigates');
});

// ---- 29: reconnect state machine ----

test('29: reconnect state machine — connected/lost/reconnected, independent of any form state', () => {
  assert.equal(reconnectBannerVisible({ wsConnected: true, lastKnownPhase: 'updating' }), false, 'connected');
  assert.equal(reconnectBannerVisible({ wsConnected: false, lastKnownPhase: 'updating' }), true, 'lost mid-update');
  assert.equal(reconnectBannerVisible({ wsConnected: true, lastKnownPhase: 'updating' }), false, 'reconnected');
  assert.equal(reconnectBannerVisible({ wsConnected: false, lastKnownPhase: 'idle' }), false, 'disconnected for an unrelated reason');
  assert.equal(reconnectBannerVisible({ wsConnected: false, lastKnownPhase: null }), false, 'disconnected before any status was ever known');

  // An opaque external value (e.g. a form's typed draft) passed alongside the real inputs is never
  // read or mutated by this decision — the banner's own state is fully independent of it.
  const draft = { text: 'unsent planning message' };
  const input = { wsConnected: false, lastKnownPhase: 'updating', draft };
  const before = input.draft;
  reconnectBannerVisible(input);
  assert.equal(input.draft, before);
});

test('Code Review round 1, issue 3: the reload banner is suppressed while the reconnect banner is showing, so the two never overlap', () => {
  const own = 'aaa1111';
  // An earlier, undismissed web-only update's reload banner would be 'shown' on its own...
  assert.equal(nextReloadBannerVisibility({ ownBuildCommit: own, servingCommit: 'bbb2222', dismissedCommit: null }), 'shown');
  // ...but a server-path update now disconnecting this tab must suppress it — the reconnect banner
  // is the more urgent, active state, and the two are fixed to the same spot above the footer.
  assert.equal(
    reloadBannerVisible({ ownBuildCommit: own, servingCommit: 'bbb2222', dismissedCommit: null, wsConnected: false, lastKnownPhase: 'updating' }),
    false,
    'suppressed while disconnected mid-update',
  );
  // Once reconnected, it takes back over.
  assert.equal(
    reloadBannerVisible({ ownBuildCommit: own, servingCommit: 'bbb2222', dismissedCommit: null, wsConnected: true, lastKnownPhase: 'updating' }),
    true,
    'reappears once reconnected',
  );
  // An ordinary disconnect unrelated to an update never suppresses it.
  assert.equal(
    reloadBannerVisible({ ownBuildCommit: own, servingCommit: 'bbb2222', dismissedCommit: null, wsConnected: false, lastKnownPhase: 'idle' }),
    true,
    'an unrelated disconnect does not suppress the reload banner',
  );
});

// ---- 68: live WS pushes reflected in the popover; phase 'updating' with no blocking yields no actions ----

test('68: a live AppUpdateStatus push (WS) is reflected by describeAppUpdatePopover, and updating-with-zero-blocking yields []', () => {
  const held = baseStatus({
    phase: 'held',
    availability: 'available',
    classification: 'server',
    blocking: { testRuns: 0, commands: 0, terminalSessions: 1 },
  });
  const pushed = { ...held, blocking: ZERO_BLOCKING };
  const before = describeAppUpdatePopover(held, Date.now());
  const after = describeAppUpdatePopover(pushed, Date.now());
  assert.ok(before.blocking.some((row) => row.count > 0));
  assert.ok(after.blocking.every((row) => row.count === 0));
  assert.notDeepEqual(before.blocking, after.blocking);

  assert.deepEqual(appUpdateActions(baseStatus({ phase: 'updating', blocking: ZERO_BLOCKING })), []);

  // The store's own merge: a WS 'appUpdate' event replaces state.appUpdate and tracks its phase —
  // see worldStore.ts's mergeWorkerEvent and the reconnect banner's lastKnownAppUpdatePhase.
  const status = baseStatus({ phase: 'held' });
  const patch = mergeWorkerEvent({}, { type: 'appUpdate', status });
  assert.deepEqual(patch, { appUpdate: status, lastKnownAppUpdatePhase: 'held' });
});

// ---- 62-66, 70-72: source-level checks (this repo's "component test" convention — no DOM harness) ----

test('62: the footer item renders its label via describeAppUpdateFooterLabel, never hand-rolled text', () => {
  assert.match(footer, /describeAppUpdateFooterLabel\(appUpdate\)/);
});

test('63: the app-update popover reuses FooterCountPopover\'s shell rather than reimplementing hover/Esc/outside-click', () => {
  assert.match(footer, /<FooterCountPopover\s+id="app-update"/);
  assert.doesNotMatch(appUpdatePopoverSrc, /addEventListener\(/);
});

test('64: popover content comes from describeAppUpdatePopover, not inline template strings', () => {
  assert.match(appUpdatePopoverSrc, /describeAppUpdatePopover\(status, now\)/);
});

test('65: rendered action buttons iterate appUpdateActions(status) rather than hand-listing per state', () => {
  assert.match(appUpdatePopoverSrc, /appUpdateActions\(status\)/);
  assert.match(appUpdatePopoverSrc, /actions\.map\(\(action\)/);
});

test('66: no looping CSS animation in any new app-update file', () => {
  for (const src of [footer, appUpdatePopoverSrc, reloadBannerSrc, reconnectBannerSrc]) {
    assert.doesNotMatch(src, /animate-(pulse|ping|spin|bounce)/);
  }
});

test('67: no new toast-timing code — app.update_available rides the existing generic Notification pipeline (notificationsToToast) unchanged', () => {
  assert.doesNotMatch(appUpdateSrc, /toast\(|TOAST_AUTO_DISMISS|notificationsToToast/);
});

test("69: \"up to date\" is an always-visible, low-emphasis state — not a signal to render nothing", () => {
  const label = describeAppUpdateFooterLabel(baseStatus({ availability: 'up-to-date' }));
  assert.ok(label.text.length > 0);
  assert.equal(label.tone, 'muted');
  // The footer section only ever returns null for "no status loaded yet" (appUpdate === null); it
  // never branches on a particular availability value to hide itself.
  assert.match(footer, /if \(!appUpdate\) return null;/);
  assert.doesNotMatch(footer, /availability === 'up-to-date'/);
});

test('70: dev mode shows availability text with no apply-looking action, and surfaces applyBlockedReason', () => {
  const status = baseStatus({
    mode: 'dev',
    availability: 'available',
    behindBy: 3,
    classification: 'web-only',
    applyBlockedReason: 'This is a npm run dev run. Updates can only be applied from a production-style run.',
  });
  assert.deepEqual(describeAppUpdateFooterLabel(status), { text: 'Update available (3) · read only', tone: 'warning' });
  assert.deepEqual(appUpdateActions(status), ['check']);
  const content = describeAppUpdatePopover(status, Date.now());
  assert.equal(content.applyBlockedReasonText, status.applyBlockedReason);
  assert.match(appUpdatePopoverSrc, /applyBlockedReasonText/);
});

test('71: the reload banner is persistent and dismissable, not a toast — no auto-dismiss timer; reload is the only thing that clears it for that build', () => {
  assert.doesNotMatch(reloadBannerSrc, /setTimeout|TOAST_AUTO_DISMISS_MS|toast\(/);
  assert.match(reloadBannerSrc, /dismissAppUpdateReloadBanner/);
  assert.match(reloadBannerSrc, /window\.location\.reload\(\)/);
});

test('72: the reconnect banner is independent of any form/draft state — a global "disable everything while disconnected" mechanism is explicitly out of scope here', () => {
  assert.match(reconnectBannerSrc, /reconnectBannerVisible\(\{ wsConnected, lastKnownPhase \}\)/);
  assert.doesNotMatch(reconnectBannerSrc, /disabled=|formErrors|openErrorScope|draft/i);
});

// ---- 10.016: blocking files panel ----

const files = (count) => Array.from({ length: count }, (_, i) => ({ path: `dir/file${i}.json`, kind: i === 1 ? 'deleted' : i === 2 ? 'untracked' : 'modified' }));

test('blocking files: no panel when nothing overlaps, even for a status from an older daemon without the fields', () => {
  assert.equal(describeBlockingFiles({ blockingFiles: [], blockingFilesTotal: 0 }), null);
  assert.equal(describeBlockingFiles({}), null);
  assert.equal(describeAppUpdatePopover(baseStatus({ availability: 'available', behindBy: 1 }), 0).blockingFiles, null);
});

test('blocking files: title counts files with singular/plural wording; kinds are spelled out', () => {
  assert.equal(describeBlockingFiles({ blockingFiles: files(1), blockingFilesTotal: 1 }).title, 'Local changes block this update (1 file)');
  const view = describeBlockingFiles({ blockingFiles: files(3), blockingFilesTotal: 3 });
  assert.equal(view.title, 'Local changes block this update (3 files)');
  assert.deepEqual(view.files.map((f) => f.kindLabel), ['modified', 'deleted', 'untracked, would be overwritten']);
  assert.equal(view.moreCount, 0);
});

test('blocking files: lists 10 and counts the rest from the server total, not the list length', () => {
  const view = describeBlockingFiles({ blockingFiles: files(10), blockingFilesTotal: 23 });
  assert.equal(view.files.length, 10);
  assert.equal(view.moreCount, 13);
  assert.equal(describeBlockingFiles({ blockingFiles: files(10), blockingFilesTotal: 10 }).moreCount, 0);
  assert.equal(describeBlockingFiles({ blockingFiles: files(12), blockingFilesTotal: 12 }).files.length, 10);
});

test('blocking files: explanation says nothing is changed for you; copy text is one path per line; no discard anywhere', async () => {
  const view = describeBlockingFiles({ blockingFiles: files(2), blockingFilesTotal: 2 });
  assert.match(view.explanation, /incoming update changes these same files/i);
  assert.match(view.explanation, /Nothing is changed for you/);
  assert.equal(view.copyText, 'dir/file0.json\ndir/file1.json');
  assert.doesNotMatch(appUpdatePopoverSrc + appUpdateSrc, /discard/i);
});

test('blocking files: the panel is an announced group with a labelled list, and other blockers keep the plain reason line', () => {
  assert.match(appUpdatePopoverSrc, /role="group" aria-labelledby="app-update-blocking-title"/);
  assert.match(appUpdatePopoverSrc, /<ul role="list"/);
  assert.match(appUpdatePopoverSrc, /Can't update automatically:/);
  assert.match(appUpdatePopoverSrc, /cantUpdateReasonText && !content\.blockingFiles/);
});
