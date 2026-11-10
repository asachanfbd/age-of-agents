import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanItemRecord, WorkflowRecord, WorkflowStep } from '../src/domain/types.ts';
import {
  EARLY_STEP_ID, earlyStepOf, evaluateParent, parseUiPlanningWaits, uiPlanningWaitsLockedReason, unsatisfiedReasons, wantsEarlyRun,
} from '../src/projects/dependencies.ts';
import type { ParentFacts } from '../src/projects/dependencies.ts';

/** Unit cases of task 38.002: which workflows have an early UI Planning step, when a waiting task runs it, and when its setting can change. */

const step = (id: string, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id, name: id, agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: '', ...extra,
});
const workflow = (steps: WorkflowStep[]): WorkflowRecord => ({ id: 'w', name: 'W', description: '', enabled: true, steps });
const SOFTWARE = workflow([step('ui-planning', { requiresApproval: true }), step('test-case-planning'), step('development', { canEditCode: true })]);

function item(extra: Partial<PlanItemRecord> = {}): PlanItemRecord {
  return {
    id: 'child', projectId: 'p', title: '38.002: Child', description: '', status: 'pending', order: 1, taskIds: [], milestoneId: null,
    workflowRunId: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', dependsOn: ['parent'], ...extra,
  } as PlanItemRecord;
}
const wants = (overrides: { item?: Partial<PlanItemRecord>; options?: Parameters<typeof wantsEarlyRun>[0]['options']; hasRepository?: boolean; earlyStepId?: string | null } = {}) =>
  wantsEarlyRun({ item: item(overrides.item), options: overrides.options ?? {}, hasRepository: overrides.hasRepository ?? true, earlyStepId: overrides.earlyStepId === undefined ? EARLY_STEP_ID : overrides.earlyStepId });

test('U1 the shipped Software Development workflow starts with the early step ui-planning', () => {
  assert.equal(earlyStepOf(SOFTWARE), 'ui-planning');
});

test('U2 a first ui-planning step without approval is not an early step', () => {
  assert.equal(earlyStepOf(workflow([step('ui-planning'), step('development', { canEditCode: true })])), null);
});

test('U3 ui-planning that is not the first step is not an early step', () => {
  assert.equal(earlyStepOf(workflow([step('test-case-planning'), step('ui-planning', { requiresApproval: true })])), null);
});

test('U4 a ui-planning step that may edit code is not an early step', () => {
  assert.equal(earlyStepOf(workflow([step('ui-planning', { requiresApproval: true, canEditCode: true })])), null);
});

test('U5 an empty workflow, a bug-fix and an seo-audit workflow have no early step', () => {
  assert.equal(earlyStepOf(workflow([])), null);
  assert.equal(earlyStepOf(workflow([step('reproduce', { requiresApproval: true }), step('fix', { canEditCode: true })])), null);
  assert.equal(earlyStepOf(workflow([step('audit'), step('report', { requiresApproval: true })])), null);
});

test('U6 setting off, parents, an early step, its own branch and UI Planning selected: runs early', () => {
  assert.equal(wants({ item: { uiPlanningWaitsForParent: false }, options: { createBranch: true, skippedStepIds: ['development'] } }), true);
});

test('U7 the setting on: does not run early', () => {
  assert.equal(wants({ item: { uiPlanningWaitsForParent: true } }), false);
});

test('U8 a legacy task without the setting reads as off: runs early', () => {
  assert.equal(wants({ item: {} }), true);
});

test('U9 UI Planning left out at start: does not run early', () => {
  assert.equal(wants({ options: { skippedStepIds: ['ui-planning'] } }), false);
});

test('U10 an in-place start (createBranch false) never runs early', () => {
  assert.equal(wants({ options: { createBranch: false } }), false);
});

test('U11 no parents (empty or absent): does not run early', () => {
  assert.equal(wants({ item: { dependsOn: [] } }), false);
  assert.equal(wants({ item: { dependsOn: undefined } }), false);
});

test('U12 a project without a repository never runs early', () => {
  assert.equal(wants({ hasRepository: false }), false);
});

test('U13 testing-setup and PR-conflict items never run early, nor does a workflow without the early step', () => {
  assert.equal(wants({ item: { testingSetup: { mode: 'create' } as PlanItemRecord['testingSetup'] } }), false);
  assert.equal(wants({ item: { prConflict: { number: 1 } as PlanItemRecord['prConflict'] } }), false);
  assert.equal(wants({ earlyStepId: null }), false);
});

test('U14 parseUiPlanningWaits accepts only booleans', () => {
  assert.equal(parseUiPlanningWaits(true), true);
  assert.equal(parseUiPlanningWaits(false), false);
  for (const value of [null, 'true', 'false', 1, 0, 'on', {}, [], undefined]) assert.equal(parseUiPlanningWaits(value), null, JSON.stringify(value));
});

test('U16 the setting is editable on a ready or waiting task with parents and no early run, and locked otherwise', () => {
  assert.equal(uiPlanningWaitsLockedReason(item(), false), null, 'ready');
  const waiting = item({ waiting: { options: {}, state: 'waiting', reasons: [], since: '', longWaitNotified: false, updatedAt: '' } });
  assert.equal(uiPlanningWaitsLockedReason(waiting, false), null, 'waiting, nothing started (setting on, or queued for a slot)');
  assert.equal(uiPlanningWaitsLockedReason(item({ ...waiting, workflowRunId: 'r', status: 'developing' }), true), 'UI Planning has already started, so this can\'t change now.');
  assert.match(uiPlanningWaitsLockedReason(item({ dependsOn: [] }), false)!, /no parent tasks/);
  assert.match(uiPlanningWaitsLockedReason(item({ archived: true }), false)!, /archived or finished/);
  assert.match(uiPlanningWaitsLockedReason(item({ status: 'done', workflowRunId: 'r', pullRequest: { state: 'merged' } as PlanItemRecord['pullRequest'] }), false)!, /archived or finished/);
  assert.match(uiPlanningWaitsLockedReason(item({ status: 'developing', workflowRunId: 'r', taskIds: ['t'] }), false)!, /already started/);
});

test('U18 an early run of the child changes nothing in the parent verdicts; a blocked parent still blocks', () => {
  const facts = (overrides: Partial<ParentFacts>): ParentFacts => ({
    parentId: 'p1', label: '#12', exists: true, archived: false, runStatus: 'running', autoMerge: null, lastCommitPresent: false,
    mergeCommitPresent: false, noCommits: false, prMerged: false, targetBranch: 'main', checkedOutBranch: 'main', sync: null, ...overrides,
  });
  assert.equal((evaluateParent(facts({ runStatus: 'held' })) as { reason: { text: string } }).reason.text, 'Waiting for #12 to finish', 'a held parent has not finished');
  const reasons = unsatisfiedReasons([evaluateParent(facts({})), evaluateParent(facts({ parentId: 'p2', label: '#13', runStatus: 'failed' }))]);
  assert.deepEqual(reasons.map((reason) => reason.blocked), [true, false]);
  assert.equal(reasons[0]!.text, 'Blocked: parent #13 failed');
});
