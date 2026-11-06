import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_BRANCH_TYPE,
  branchSummaryFromTitle,
  buildBranchName,
  planningRefSegment,
  defaultBranchName,
  slugifyBranchSummary,
  uniqueBranchName,
} from '../src/projects/branchName.ts';

test('U01-U03 a branch is <type>/<ref>-<summary>, <type>/<summary> with no ref, and the type is feature unless the workflow fixes one', () => {
  assert.equal(defaultBranchName({ title: '5.004: Add thing', branchType: null, planningRef: { session: 5, task: 4 } }), 'feature/5-004-add-thing');
  assert.equal(defaultBranchName({ title: 'By hand', branchType: null, planningRef: null }), 'feature/by-hand');
  assert.equal(defaultBranchName({ title: 'By hand', branchType: 'bugfix', planningRef: null }), 'bugfix/by-hand');
  // I46: a bug has no planning ref, takes the Bug Fix workflow's branch type, and its number is not part of the summary.
  assert.equal(defaultBranchName({ title: '4.002.001: Crash on save', branchType: 'bugfix', planningRef: null }), 'bugfix/crash-on-save');
  assert.equal(defaultBranchName({ title: 'B.003: Crash on save', branchType: 'bugfix', planningRef: null }), 'bugfix/crash-on-save');
  assert.equal(DEFAULT_BRANCH_TYPE, 'feature');
});

test('U04/U05 the summary drops a "3.002: " or legacy "P.3 T2: " prefix', () => {
  assert.equal(branchSummaryFromTitle('3.002: Live step progress'), 'live-step-progress');
  assert.equal(branchSummaryFromTitle('P.3 T2: Live step progress'), 'live-step-progress');
});

test('U06 the slug is lowercase a-z0-9 with single dashes, trimmed; accents, emoji and CJK collapse to dashes', () => {
  assert.equal(slugifyBranchSummary('  Hello,   World!! '), 'hello-world');
  assert.equal(slugifyBranchSummary('Café ☕ 日本語 test'), 'caf-test');
  assert.equal(slugifyBranchSummary('--a--b--'), 'a-b');
});

test('U07 a title with nothing usable falls back to "task"', () => {
  for (const title of ['', '   ', '3.001: ', '!!! ???', '日本語']) assert.equal(branchSummaryFromTitle(title), 'task', JSON.stringify(title));
});

test('U08/U09 the summary is capped at 60 characters with no trailing dash, even for a huge title', () => {
  const cutOnDash = `${'a'.repeat(59)}-bbb`;
  assert.equal(slugifyBranchSummary(cutOnDash), 'a'.repeat(59));
  assert.equal(slugifyBranchSummary('word '.repeat(2000)).length <= 60, true);
  assert.doesNotMatch(slugifyBranchSummary('word '.repeat(2000)), /-$/);
});

test('U10 the ref segment pads the task number to three digits and survives out-of-range numbers', () => {
  assert.equal(planningRefSegment({ session: 5, task: 4 }), '5-004');
  assert.equal(planningRefSegment({ session: 5, task: 1000 }), '5-1000');
  assert.equal(planningRefSegment({ session: 99999, task: 0 }), '99999-000');
  assert.equal(planningRefSegment(null), null);
  assert.equal(buildBranchName('feature', '5-004', 'x'), 'feature/5-004-x');
  assert.equal(buildBranchName('bugfix', null, 'typed-by-hand'), 'bugfix/typed-by-hand');
});

test('U11-U13 uniqueBranchName keeps a free name and appends -2, then -3, past taken ones', async () => {
  assert.equal(await uniqueBranchName('/repo', 'feature/x', async () => false), 'feature/x');
  const taken = new Set(['feature/x']);
  assert.equal(await uniqueBranchName('/repo', 'feature/x', async (_cwd, branch) => taken.has(branch)), 'feature/x-2');
  taken.add('feature/x-2');
  assert.equal(await uniqueBranchName('/repo', 'feature/x', async (_cwd, branch) => taken.has(branch)), 'feature/x-3');
});
