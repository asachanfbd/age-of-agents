import assert from 'node:assert/strict';
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

const { describeSyncBlocking, isOutOfSync, describeSync, mainFolderReloadKey, isAutoPullOn } = await import('../src/lib/gitSync.ts');

const sync = (status, extra = {}) => ({ projectId: 'p1', branch: 'main', aheadBy: 0, behindBy: 0, checkedAt: 't', status, ...extra });

test('isOutOfSync is true only for behind/diverged, and false for null/undefined', () => {
  assert.equal(isOutOfSync(sync('behind')), true);
  assert.equal(isOutOfSync(sync('diverged')), true);
  assert.equal(isOutOfSync(sync('synced')), false);
  assert.equal(isOutOfSync(sync('ahead')), false);
  assert.equal(isOutOfSync(sync('no-remote')), false);
  assert.equal(isOutOfSync(sync('unknown')), false);
  assert.equal(isOutOfSync(null), false);
  assert.equal(isOutOfSync(undefined), false);
});

test('describeSync reports "checking" for a not-yet-known reading', () => {
  assert.match(describeSync(null), /checking/i);
  assert.match(describeSync(undefined), /checking/i);
});

test('describeSync reads naturally for every status, singular vs. plural commit counts included', () => {
  assert.match(describeSync(sync('synced')), /up to date with origin\/main/i);
  assert.match(describeSync(sync('ahead', { aheadBy: 1 })), /1 commit ahead/i);
  assert.match(describeSync(sync('ahead', { aheadBy: 3 })), /3 commits ahead/i);
  assert.match(describeSync(sync('behind', { behindBy: 1 })), /1 commit behind/i);
  assert.match(describeSync(sync('behind', { behindBy: 2 })), /2 commits behind/i);
  assert.match(describeSync(sync('diverged', { aheadBy: 1, behindBy: 2 })), /diverged.*1 ahead.*2 behind/i);
  assert.match(describeSync(sync('no-remote')), /hasn't been pushed/i);
  assert.match(describeSync(sync('unknown')), /could not check/i);
});

test('describeSync says why a behind or diverged branch was not pulled, and keeps the old wording without a reason', () => {
  assert.match(describeSync(sync('behind', { behindBy: 2, deferredReason: 'not pulled: a task is running in the main folder' })), /2 commits behind origin\/main — not pulled: a task is running in the main folder/);
  assert.match(describeSync(sync('behind', { behindBy: 1, deferredReason: 'auto-pull is off for this project' })), /auto-pull is off for this project/);
  assert.match(describeSync(sync('diverged', { aheadBy: 1, behindBy: 2, deferredReason: 'not pulled: your branch has diverged from origin' })), /1 ahead, 2 behind — not pulled: your branch has diverged from origin/);
  assert.match(describeSync(sync('behind', { behindBy: 1 })), /fetch and pull to catch up/);
  assert.doesNotMatch(describeSync(sync('diverged', { aheadBy: 1, behindBy: 2 })), /not pulled/);
});

test('describeSync shows the automatic pull after success, singular and plural', () => {
  const at = new Date(2030, 0, 2, 3, 4).toISOString();
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  assert.equal(describeSync(sync('synced', { lastAutoPull: { commits: 1, at } })), `Pulled 1 commit automatically at ${time}`);
  assert.equal(describeSync(sync('synced', { lastAutoPull: { commits: 7, at } })), `Pulled 7 commits automatically at ${time}`);
  assert.match(describeSync(sync('synced')), /up to date/i);
});

test('mainFolderReloadKey changes only when an automatic pull lands', () => {
  assert.equal(mainFolderReloadKey(null), '');
  assert.equal(mainFolderReloadKey(sync('synced')), '');
  assert.equal(mainFolderReloadKey(sync('synced', { lastAutoPull: { commits: 1, at: 't1' } })), 't1');
  assert.notEqual(mainFolderReloadKey(sync('synced', { lastAutoPull: { commits: 1, at: 't2' } })), 't1');
});

test('isAutoPullOn reads an absent setting as on', () => {
  assert.equal(isAutoPullOn({}), true);
  assert.equal(isAutoPullOn({ autoPullEnabled: true }), true);
  assert.equal(isAutoPullOn({ autoPullEnabled: false }), false);
});

// ---- 10.016: blocking files in the sync detail ----

const blockingFiles = (n) => Array.from({ length: n }, (_, i) => ({ path: `dir/f${i}.json`, kind: i === 1 ? 'deleted' : i === 2 ? 'untracked' : 'modified' }));

test('sync blocking: nothing shown without overlap, for an older reading, or for no reading', () => {
  assert.equal(describeSyncBlocking(sync('behind', { behindBy: 1 }), 'Alpha'), null);
  assert.equal(describeSyncBlocking(null, 'Alpha'), null);
  assert.equal(describeSyncBlocking(sync('behind', { blockingFiles: [], blockingFilesTotal: 0 }), 'Alpha'), null);
});

test('sync blocking: title names the project and the count, singular and plural', () => {
  assert.equal(describeSyncBlocking(sync('behind', { blockingFiles: blockingFiles(1), blockingFilesTotal: 1 }), 'Alpha').title, 'Not pulled: local changes in Alpha block 1 file');
  assert.equal(describeSyncBlocking(sync('behind', { blockingFiles: blockingFiles(2), blockingFilesTotal: 2 }), 'Alpha').title, 'Not pulled: local changes in Alpha block 2 files');
});

test('sync blocking: lists three files with kind labels, then "and N more" from the exact total', () => {
  const three = describeSyncBlocking(sync('behind', { blockingFiles: blockingFiles(3), blockingFilesTotal: 3 }), 'A');
  assert.deepEqual(three.files.map((f) => f.kindLabel), ['modified', 'deleted', 'untracked, would be overwritten']);
  assert.equal(three.moreText, null);
  const many = describeSyncBlocking(sync('behind', { blockingFiles: blockingFiles(10), blockingFilesTotal: 14 }), 'A');
  assert.equal(many.files.length, 3);
  assert.equal(many.moreText, 'and 11 more');
  assert.equal(describeSyncBlocking(sync('behind', { blockingFiles: blockingFiles(4), blockingFilesTotal: 4 }), 'A').moreText, 'and 1 more');
});

test('sync blocking: hint says nothing is changed for you; the menu is an announced group with a Check again button and no discard', async () => {
  const { readFile } = await import('node:fs/promises');
  const menu = await readFile(new URL('../src/ui/project-popup/BranchMenu.tsx', import.meta.url), 'utf8');
  const view = describeSyncBlocking(sync('behind', { blockingFiles: blockingFiles(1), blockingFilesTotal: 1 }), 'A');
  assert.match(view.hint, /Commit, stash or move these files yourself/);
  assert.match(view.hint, /Nothing is changed for you/);
  assert.match(menu, /role="group" aria-labelledby="sync-blocking-title"/);
  assert.match(menu, /<ul role="list"/);
  assert.match(menu, /Check again/);
  assert.doesNotMatch(menu, /discard/i);
});

test('sync blocking: a long path is truncated in view with the full path as title; the path is rendered as text', async () => {
  const { readFile } = await import('node:fs/promises');
  const menu = await readFile(new URL('../src/ui/project-popup/BranchMenu.tsx', import.meta.url), 'utf8');
  assert.match(menu, /truncate" title=\{file\.path\}>\{file\.path\}/);
});
