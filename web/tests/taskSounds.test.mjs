import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  TASK_SOUND_URLS,
  allWorkflowRuns,
  attentionTaskIds,
  attentionWorkflowRunIds,
  completedTaskIds,
  completedWorkflowRunIds,
  snapshotRunStates,
  snapshotTaskStates,
} from '../src/lib/taskSounds.ts';

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

function task(overrides = {}) {
  return { id: 't1', kind: 'execute', status: 'developing', workflowRunId: null, runtimeStatus: undefined, ...overrides };
}

function run(overrides = {}) {
  return { id: 'r1', projectId: 'p1', status: 'running', ...overrides };
}

test('every sound URL points at a file shipped in web/public', async () => {
  for (const url of Object.values(TASK_SOUND_URLS)) {
    await access(new URL(`../public${url}`, import.meta.url));
  }
});

test('snapshotTaskStates maps id to status, folding a terminal Task waiting for input to its own state', () => {
  assert.deepEqual(
    snapshotTaskStates({ t1: task(), t2: task({ id: 't2', status: 'done' }), t3: task({ id: 't3', runtimeStatus: 'waiting_input' }) }),
    { t1: 'developing', t2: 'done', t3: 'waiting_input' },
  );
});

test('snapshotRunStates maps id to status', () => {
  assert.deepEqual(snapshotRunStates([run(), run({ id: 'r2', status: 'completed' })]), { r1: 'running', r2: 'completed' });
});

// ---- Completion ----

test('completedTaskIds reports an execute Task moving to done', () => {
  assert.deepEqual(completedTaskIds({ t1: 'developing' }, { t1: task({ status: 'done' }) }), ['t1']);
  assert.deepEqual(completedTaskIds({ t1: 'blocked' }, { t1: task({ status: 'done' }) }), ['t1']);
});

test('completedTaskIds ignores history, unchanged and non-done Tasks', () => {
  assert.deepEqual(completedTaskIds({}, { t1: task({ status: 'done' }) }), [], 'first sighting is history');
  assert.deepEqual(completedTaskIds({ t1: 'done' }, { t1: task({ status: 'done' }) }), [], 'already done — no re-trigger');
  assert.deepEqual(completedTaskIds({ t1: 'developing' }, { t1: task({ status: 'failed' }) }), []);
});

test('completedTaskIds skips planning chats and workflow step Tasks', () => {
  assert.deepEqual(completedTaskIds({ t1: 'developing' }, { t1: task({ kind: 'plan', status: 'done' }) }), []);
  assert.deepEqual(completedTaskIds({ t1: 'developing' }, { t1: task({ workflowRunId: 'r1', status: 'done' }) }), []);
});

test('allWorkflowRuns flattens runs across projects', () => {
  const runs = allWorkflowRuns({ p1: [run()], p2: [run({ id: 'r2', projectId: 'p2' })] });
  assert.deepEqual(runs.map((r) => r.id), ['r1', 'r2']);
});

test('completedWorkflowRunIds reports only a live transition into completed', () => {
  assert.deepEqual(completedWorkflowRunIds({ r1: 'completing' }, [run({ status: 'completed' })]), ['r1']);
  assert.deepEqual(completedWorkflowRunIds({}, [run({ status: 'completed' })]), [], 'first sighting is history');
  assert.deepEqual(completedWorkflowRunIds({ r1: 'completed' }, [run({ status: 'completed' })]), [], 'already completed — no re-trigger');
});

test('completedWorkflowRunIds does not chime a run merely advancing between running steps', () => {
  assert.deepEqual(completedWorkflowRunIds({ r1: 'running' }, [run({ status: 'running' })]), []);
});

test('completedWorkflowRunIds does not chime completing — only the final completed', () => {
  assert.deepEqual(completedWorkflowRunIds({ r1: 'running' }, [run({ status: 'completing' })]), []);
});

// ---- Attention ----

test('attentionTaskIds reports a plain Task entering blocked', () => {
  assert.deepEqual(attentionTaskIds({ t1: 'developing' }, { t1: task({ status: 'blocked' }) }), ['t1']);
});

test('attentionTaskIds reports a plain Task entering failed', () => {
  assert.deepEqual(attentionTaskIds({ t1: 'developing' }, { t1: task({ status: 'failed' }) }), ['t1']);
});

test('attentionTaskIds reports a planning session entering blocked or failed too — attention has no kind exclusion', () => {
  assert.deepEqual(attentionTaskIds({ t1: 'developing' }, { t1: task({ kind: 'plan', status: 'blocked' }) }), ['t1']);
  assert.deepEqual(attentionTaskIds({ t1: 'developing' }, { t1: task({ kind: 'plan', status: 'failed' }) }), ['t1']);
});

test('attentionTaskIds reports a terminal Task entering waiting_input via runtimeStatus, not status', () => {
  assert.deepEqual(
    attentionTaskIds({ t1: 'developing' }, { t1: task({ status: 'developing', runtimeStatus: 'waiting_input' }) }),
    ['t1'],
  );
});

test('attentionTaskIds skips workflow step Tasks — their attention signal is the run\'s own status', () => {
  assert.deepEqual(attentionTaskIds({ t1: 'developing' }, { t1: task({ workflowRunId: 'r1', status: 'failed' }) }), []);
});

test('attentionTaskIds ignores history and does not re-trigger on a duplicate event already in an attention state', () => {
  assert.deepEqual(attentionTaskIds({}, { t1: task({ status: 'blocked' }) }), [], 'first sighting is history');
  assert.deepEqual(attentionTaskIds({ t1: 'blocked' }, { t1: task({ status: 'blocked' }) }), [], 'already blocked — no re-trigger');
});

test('attentionWorkflowRunIds reports a run entering awaiting-approval', () => {
  assert.deepEqual(attentionWorkflowRunIds({ r1: 'running' }, [run({ status: 'awaiting-approval' })]), ['r1']);
});

test('attentionWorkflowRunIds reports a run entering needs-attention', () => {
  assert.deepEqual(attentionWorkflowRunIds({ r1: 'running' }, [run({ status: 'needs-attention' })]), ['r1']);
});

test('attentionWorkflowRunIds reports a run entering failed', () => {
  assert.deepEqual(attentionWorkflowRunIds({ r1: 'running' }, [run({ status: 'failed' })]), ['r1']);
});

test('attentionWorkflowRunIds does not chime a run merely advancing between running steps', () => {
  assert.deepEqual(attentionWorkflowRunIds({ r1: 'running' }, [run({ status: 'running' })]), []);
});

test('attentionWorkflowRunIds ignores history and does not re-trigger on a duplicate event already needing attention', () => {
  assert.deepEqual(attentionWorkflowRunIds({}, [run({ status: 'needs-attention' })]), [], 'first sighting is history');
  assert.deepEqual(attentionWorkflowRunIds({ r1: 'needs-attention' }, [run({ status: 'needs-attention' })]), [], 'already needs-attention — no re-trigger');
});

test('App mounts TaskSounds', () => {
  assert.match(appSource, /<TaskSounds \/>/);
});

// ---- Auto-merge: the chime waits for the merge, the horn sounds when it needs the person ----

import {
  attentionAutoMergeItemIds,
  autoMergeOnItemIds,
  mergedAutoMergeItemIds,
  snapshotAutoMergeStates,
} from '../src/lib/taskSounds.ts';

const planItem = (id, autoMerge) => ({ id, ...(autoMerge ? { autoMerge: { enabled: true, state: 'waiting', ...autoMerge } } : {}) });
const planOf = (...items) => ({ p1: { items } });
const states = (...items) => snapshotAutoMergeStates(planOf(...items));

test('WU1 a run ending with Auto-merge on does not chime, for a Task or a workflow run', () => {
  const on = autoMergeOnItemIds(planOf(planItem('i1', { state: 'waiting' })));
  assert.deepEqual(completedTaskIds({ t1: 'developing' }, { t1: task({ status: 'done', planItemId: 'i1' }) }, on), []);
  assert.deepEqual(completedWorkflowRunIds({ r1: 'running' }, [run({ status: 'completed', planItemId: 'i1' })], on), []);
});

test('WU2/WU3 with Auto-merge off, or no record at all, the run end still chimes', () => {
  const off = autoMergeOnItemIds(planOf(planItem('i1', { enabled: false }), planItem('i2')));
  assert.equal(off.size, 0);
  assert.deepEqual(completedTaskIds({ t1: 'developing' }, { t1: task({ status: 'done', planItemId: 'i1' }) }, off), ['t1']);
  assert.deepEqual(completedWorkflowRunIds({ r1: 'running' }, [run({ status: 'completed', planItemId: 'i2' })], off), ['r1']);
  assert.deepEqual(completedWorkflowRunIds({ r1: 'running' }, [run({ status: 'completed', planItemId: 'i2' })]), ['r1'], 'the default is no Auto-merge');
});

test('WU4 one chime when Auto-merge on becomes Merged', () => {
  assert.deepEqual(mergedAutoMergeItemIds(states(planItem('i1', { state: 'merging' })), states(planItem('i1', { state: 'merged' }))), ['i1']);
  assert.deepEqual(mergedAutoMergeItemIds(states(planItem('i1', { state: 'blocked' })), states(planItem('i1', { state: 'merged' }))), ['i1'], 'a PR merged by hand while blocked');
});

test('WU5 a repeat of Merged by a duplicate push does not chime again', () => {
  const merged = states(planItem('i1', { state: 'merged' }));
  assert.deepEqual(mergedAutoMergeItemIds(merged, states(planItem('i1', { state: 'merged' }))), []);
});

test('WU6 Merged arriving as history (an id not in the previous snapshot) never chimes', () => {
  assert.deepEqual(mergedAutoMergeItemIds({}, states(planItem('i1', { state: 'merged' }))), []);
  assert.deepEqual(attentionAutoMergeItemIds({}, states(planItem('i1', { state: 'blocked' }))), []);
});

test('WU7 Auto-merge turned off before the merge: neither the switch nor a later Merged record chimes', () => {
  const waiting = states(planItem('i1', { state: 'waiting' }));
  const off = states(planItem('i1', { enabled: false, state: 'waiting' }));
  assert.deepEqual(mergedAutoMergeItemIds(waiting, off), []);
  assert.deepEqual(mergedAutoMergeItemIds(off, states(planItem('i1', { enabled: false, state: 'merged' }))), []);
});

test('WU8 turned on after the run completed: no chime for the switch, one on Merged', () => {
  const none = states(planItem('i1'));
  assert.deepEqual(mergedAutoMergeItemIds(none, states(planItem('i1', { state: 'waiting' }))), []);
  assert.deepEqual(mergedAutoMergeItemIds(states(planItem('i1', { state: 'waiting' })), states(planItem('i1', { state: 'merged' }))), ['i1']);
});

test('WU9 done and Auto-merge enabled in the same update: no run-end chime', () => {
  const on = autoMergeOnItemIds(planOf(planItem('i1', { state: 'waiting' })));
  assert.deepEqual(completedWorkflowRunIds({ r1: 'running' }, [run({ status: 'completed', planItemId: 'i1' })], on), []);
});

test('WU10 a task known before with no record that becomes Merged (on) chimes; a Merged record switched back on does not', () => {
  assert.deepEqual(mergedAutoMergeItemIds(states(planItem('i1')), states(planItem('i1', { state: 'merged' }))), ['i1']);
  assert.deepEqual(mergedAutoMergeItemIds(states(planItem('i1', { enabled: false, state: 'merged' })), states(planItem('i1', { state: 'merged' }))), []);
});

test('WU11-WU13 the horn sounds on entering blocked, failed, cannot-merge or no-pr', () => {
  for (const state of ['blocked', 'failed', 'cannot-merge', 'no-pr']) {
    assert.deepEqual(attentionAutoMergeItemIds(states(planItem('i1', { state: 'waiting' })), states(planItem('i1', { state }))), ['i1'], state);
  }
});

test('WU14 no horn for the states that need nothing from the person', () => {
  for (const state of ['waiting', 'merging', 'resolving', 'provider', 'agent', 'merged']) {
    assert.deepEqual(attentionAutoMergeItemIds(states(planItem('i1', { state: 'blocked' })), states(planItem('i1', { state }))), [], state);
  }
});

test('WU16/WU17 the same attention state does not repeat; blocked then failed sounds again', () => {
  const blocked = states(planItem('i1', { state: 'blocked' }));
  assert.deepEqual(attentionAutoMergeItemIds(blocked, states(planItem('i1', { state: 'blocked', reasons: ['x'] }))), []);
  assert.deepEqual(attentionAutoMergeItemIds(blocked, states(planItem('i1', { state: 'failed' }))), ['i1']);
});

test('WU18 an attention state entered with Auto-merge off sounds nothing', () => {
  assert.deepEqual(attentionAutoMergeItemIds(states(planItem('i1', { state: 'waiting' })), states(planItem('i1', { enabled: false, state: 'blocked' }))), []);
});

test('WU21 plans that are missing, empty or hold items without a record are tolerated', () => {
  assert.deepEqual(snapshotAutoMergeStates({ p1: undefined, p2: { items: [] } }), {});
  assert.deepEqual(snapshotAutoMergeStates(planOf(planItem('i1'))), { i1: 'none' });
  assert.equal(autoMergeOnItemIds({ p1: undefined }).size, 0);
});

test('WU26 an item removed between snapshots sounds nothing', () => {
  assert.deepEqual(mergedAutoMergeItemIds(states(planItem('i1', { state: 'merging' })), states()), []);
  assert.deepEqual(attentionAutoMergeItemIds(states(planItem('i1', { state: 'merging' })), states()), []);
});

test('C1/C2 TaskSounds baselines plan items on the first render, plays the chime for a merge and the horn for attention, behind the mute', async () => {
  const source = await readFile(new URL('../src/ui/TaskSounds.tsx', import.meta.url), 'utf8');
  assert.match(source, /s\.planByProject/);
  assert.match(source, /!previousAutoMerge\) return;/);
  assert.match(source, /attentionAutoMergeItemIds\(previousAutoMerge, autoMerge\)/);
  assert.match(source, /mergedAutoMergeItemIds\(previousAutoMerge, autoMerge\)/);
  assert.match(source, /completedTaskIds\(previousTasks, tasksById, autoMergeItems\)/);
  assert.match(source, /completedWorkflowRunIds\(previousRuns, runs, autoMergeItems\)/);
  assert.match(source, /if \(getSoundsMuted\(\)\) return;/);
  assert.match(source, /if \(needsAttention\) playTaskSound\('attention'\);\s*else if \(completed\) playTaskSound\('complete'\);/);
});
