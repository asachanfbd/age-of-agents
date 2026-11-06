import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { WorkflowInput } from '../src/catalog/workflowService.ts';

let tempRoot: string;
let catalogDir: string;
let workflowService: typeof import('../src/catalog/workflowService.ts');
let catalogService: typeof import('../src/catalog/catalogService.ts');
let projectService: typeof import('../src/projects/projectService.ts');

/** A minimal, valid Workflow input: one editable step, no loop, no skills/executor overrides — the base every test tweaks. */
function validInput(id: string): WorkflowInput {
  return {
    id,
    name: 'Simple Flow',
    description: 'A minimal one-step workflow.',
    steps: [
      { id: 'development', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Build it.' },
    ],
  };
}

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'workflow-service-test-'));
  catalogDir = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), catalogDir, { recursive: true });
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = catalogDir;
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  catalogService = await import('../src/catalog/catalogService.ts');
  workflowService = await import('../src/catalog/workflowService.ts');
  projectService = await import('../src/projects/projectService.ts');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('createWorkflow persists a `catalog/workflows/<id>.json` file and round-trips through getWorkflow/listWorkflows', async () => {
  const created = await workflowService.createWorkflow(validInput('flow-a'));
  assert.equal(created.id, 'flow-a');
  assert.equal(created.enabled, true, 'defaults to enabled');

  const onDisk = JSON.parse(await readFile(path.join(catalogDir, 'workflows', 'flow-a.json'), 'utf-8'));
  assert.equal(onDisk.id, 'flow-a');

  const fetched = await workflowService.getWorkflow('flow-a');
  assert.deepEqual(fetched, created);

  const listed = await workflowService.listWorkflows();
  assert.ok(listed.some((w) => w.id === 'flow-a'));
});

test('a Workflow validates and saves with only its configured steps (no Requirement Analysis stage)', async () => {
  const created = await workflowService.createWorkflow(validInput('flow-steps-only'));
  assert.deepEqual(Object.keys(created).sort(), ['description', 'enabled', 'id', 'name', 'steps']);
});

test('a branch type is saved when set, kept by an update that leaves it out, and cleared by null', async () => {
  const created = await workflowService.createWorkflow({ ...validInput('flow-branch-type'), branchType: 'bugfix' });
  assert.equal(created.branchType, 'bugfix');
  assert.equal((await workflowService.getWorkflow('flow-branch-type'))?.branchType, 'bugfix');

  assert.equal((await workflowService.updateWorkflow('flow-branch-type', { name: 'Renamed' })).branchType, 'bugfix');
  assert.equal((await workflowService.updateWorkflow('flow-branch-type', { branchType: 'hotfix' })).branchType, 'hotfix');
  const cleared = await workflowService.updateWorkflow('flow-branch-type', { branchType: null });
  assert.ok(!('branchType' in cleared));
  const onDisk = JSON.parse(await readFile(path.join(catalogDir, 'workflows', 'flow-branch-type.json'), 'utf-8'));
  assert.ok(!('branchType' in onDisk));
});

test('a blank or null branch type on create is left out', async () => {
  assert.ok(!('branchType' in await workflowService.createWorkflow({ ...validInput('flow-branch-null'), branchType: null })));
  assert.ok(!('branchType' in await workflowService.createWorkflow({ ...validInput('flow-branch-blank'), branchType: '' })));
});

test('a branch type that is not a lowercase slug is refused on create and update', async () => {
  for (const branchType of ['Bugfix', 'bug/fix', '-bug', 'bug fix', 'bug.fix']) {
    await assert.rejects(
      () => workflowService.createWorkflow({ ...validInput(`flow-bad-type-${branchType.length}`), branchType }),
      (error: Error) => error instanceof workflowService.InvalidWorkflowError && /branchType must be lowercase/.test(error.message),
      branchType,
    );
  }
  await workflowService.createWorkflow(validInput('flow-bad-type-update'));
  await assert.rejects(() => workflowService.updateWorkflow('flow-bad-type-update', { branchType: 'Bug/Fix' }), workflowService.InvalidWorkflowError);
  assert.equal(await workflowService.getWorkflow('flow-bad-type-update').then((w) => w?.branchType), undefined, 'nothing saved');
});

test('a legacy Workflow file carrying requirementAnalysis still loads, without it, and is saved back clean', async () => {
  const filePath = path.join(catalogDir, 'workflows', 'flow-legacy.json');
  await writeFile(filePath, JSON.stringify({
    ...validInput('flow-legacy'),
    enabled: true,
    requirementAnalysis: { agentId: 'builder', instructions: 'Plan the work.' },
  }), 'utf-8');

  const loaded = await workflowService.getWorkflow('flow-legacy');
  assert.ok(loaded);
  assert.ok(!('requirementAnalysis' in loaded));
  assert.ok((await workflowService.listWorkflows()).some((w) => w.id === 'flow-legacy' && !('requirementAnalysis' in w)));

  await workflowService.updateWorkflow('flow-legacy', { name: 'Renamed Legacy' });
  const onDisk = JSON.parse(await readFile(filePath, 'utf-8'));
  assert.equal(onDisk.name, 'Renamed Legacy');
  assert.ok(!('requirementAnalysis' in onDisk));
});

test('createWorkflow ignores a requirementAnalysis sent by an older client', async () => {
  const legacyInput = { ...validInput('flow-legacy-input'), requirementAnalysis: { agentId: 'builder', instructions: 'x' } } as WorkflowInput;
  const created = await workflowService.createWorkflow(legacyInput);
  assert.ok(!('requirementAnalysis' in created));
});

test('createWorkflow refuses a duplicate id', async () => {
  await workflowService.createWorkflow(validInput('flow-dup'));
  await assert.rejects(() => workflowService.createWorkflow(validInput('flow-dup')), workflowService.WorkflowAlreadyExistsError);
});

test('createWorkflow validates the id shape via the shared Catalog id pattern', async () => {
  await assert.rejects(() => workflowService.createWorkflow(validInput('not a valid id')), workflowService.InvalidIdError);
});

test('createWorkflow requires name/description and rejects a non-array steps value', async () => {
  await assert.rejects(() => workflowService.createWorkflow({ ...validInput('flow-b'), name: '' }), workflowService.InvalidWorkflowError);
  await assert.rejects(() => workflowService.createWorkflow({ ...validInput('flow-c'), description: '   ' }), workflowService.InvalidWorkflowError);
  await assert.rejects(
    () => workflowService.createWorkflow({ ...validInput('flow-d'), steps: 'nope' as unknown as WorkflowInput['steps'] }),
    workflowService.InvalidWorkflowError,
  );
});

test('createWorkflow rejects an agentId/skillId/executorId that does not exist in the Catalog/executors config', async () => {
  await assert.rejects(
    () => workflowService.createWorkflow({
      ...validInput('flow-e'),
      steps: [{ id: 'a', name: 'A', agentId: 'no-such-agent', canEditCode: false, requiresApproval: false, instructions: 'x' }],
    }),
    /step "A": its agent is not in the Catalog/,
  );
  await assert.rejects(
    () => workflowService.createWorkflow({
      ...validInput('flow-f'),
      steps: [{ id: 'a', name: 'A', agentId: 'builder', skillIds: ['no-such-skill'], canEditCode: false, requiresApproval: false, instructions: 'x' }],
    }),
    /step "A": one of its skills is not in the Catalog/,
  );
  await assert.rejects(
    () => workflowService.createWorkflow({
      ...validInput('flow-g'),
      steps: [{ id: 'a', name: 'A', agentId: 'builder', executorId: 'no-such-executor', canEditCode: false, requiresApproval: false, instructions: 'x' }],
    }),
    /step "A": its executor is not configured/,
  );
});

test('createWorkflow rejects duplicate step ids within one workflow', async () => {
  await assert.rejects(
    () => workflowService.createWorkflow({
      ...validInput('flow-h'),
      steps: [
        { id: 'dup', name: 'A', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'x' },
        { id: 'dup', name: 'B', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'y' },
      ],
    }),
    /Step "B" has the same id as an earlier step/,
  );
});

test('createWorkflow rejects a loopBack that targets a step at or after its own position', async () => {
  const forward: WorkflowInput = {
    ...validInput('flow-i'),
    steps: [
      { id: 'a', name: 'A', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'x', loopBack: { toStepId: 'b', maxRounds: 2 } },
      { id: 'b', name: 'B', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'y' },
    ],
  };
  await assert.rejects(() => workflowService.createWorkflow(forward), /step "A": its loop must go back to an earlier step/);

  const selfTarget: WorkflowInput = {
    ...validInput('flow-j'),
    steps: [{ id: 'a', name: 'A', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'x', loopBack: { toStepId: 'a', maxRounds: 2 } }],
  };
  await assert.rejects(() => workflowService.createWorkflow(selfTarget), /step "A": its loop must go back to an earlier step/);
});

test('createWorkflow rejects a loopBack.maxRounds outside 1..10', async () => {
  const withLoop = (maxRounds: number): WorkflowInput => ({
    ...validInput('flow-k'),
    steps: [
      { id: 'a', name: 'A', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'x' },
      { id: 'b', name: 'B', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'y', loopBack: { toStepId: 'a', maxRounds } },
    ],
  });
  await assert.rejects(() => workflowService.createWorkflow(withLoop(0)), /between 1 and 10/);
  await assert.rejects(() => workflowService.createWorkflow(withLoop(11)), /between 1 and 10/);
  await assert.rejects(() => workflowService.createWorkflow(withLoop(1.5)), /between 1 and 10/);
});

test('createWorkflow accepts a valid loopBack to an earlier step with maxRounds in range', async () => {
  const withLoop: WorkflowInput = {
    ...validInput('flow-l'),
    steps: [
      { id: 'a', name: 'A', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'x' },
      { id: 'b', name: 'B', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'y', loopBack: { toStepId: 'a', maxRounds: 3 } },
    ],
  };
  const created = await workflowService.createWorkflow(withLoop);
  assert.deepEqual(created.steps[1]?.loopBack, { toStepId: 'a', maxRounds: 3 });
});

/** Build → review → an approval step, with `signoff` set as given — the base for the Request changes target cases. */
function withRequestChangesTarget(id: string, signoff: Record<string, unknown>): WorkflowInput {
  return {
    ...validInput(id),
    steps: [
      { id: 'build', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'x' },
      { id: 'review', name: 'Code Review', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'y' },
      { id: 'signoff', name: 'Sign-off', agentId: 'builder', canEditCode: false, requiresApproval: true, instructions: 'z', ...signoff },
    ],
  };
}

test('an approval step may send Request changes back to an earlier step; absent or null means unset', async () => {
  const created = await workflowService.createWorkflow(withRequestChangesTarget('flow-rc-ok', { requestChangesToStepId: 'build' }));
  assert.equal(created.steps[2]?.requestChangesToStepId, 'build');
  assert.equal((await workflowService.getWorkflow('flow-rc-ok'))?.steps[2]?.requestChangesToStepId, 'build');
  await workflowService.createWorkflow(withRequestChangesTarget('flow-rc-null', { requestChangesToStepId: null }));
  await workflowService.createWorkflow(withRequestChangesTarget('flow-rc-absent', {}));
});

test('a Request changes target must be an earlier step of the same workflow, on an approval step', async () => {
  const earlierStep = /step "Sign-off": Request changes must go back to an earlier step/;
  for (const target of ['signoff', 'nope', '', 42]) {
    await assert.rejects(() => workflowService.createWorkflow(withRequestChangesTarget('flow-rc-bad', { requestChangesToStepId: target })), earlierStep, `target ${JSON.stringify(target)}`);
  }
  const later: WorkflowInput = withRequestChangesTarget('flow-rc-later', { requestChangesToStepId: 'after' });
  later.steps.push({ id: 'after', name: 'After', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'w' });
  await assert.rejects(() => workflowService.createWorkflow(later), earlierStep);
  await assert.rejects(
    () => workflowService.createWorkflow(withRequestChangesTarget('flow-rc-no-approval', { requiresApproval: false, requestChangesToStepId: 'build' })),
    /step "Sign-off": only a step that requires approval can send Request changes back to an earlier step/,
  );
  assert.equal(await workflowService.getWorkflow('flow-rc-bad'), undefined, 'nothing was saved');
});

test('updateWorkflow rejects a reorder that leaves the Request changes target after its approval step', async () => {
  const created = await workflowService.createWorkflow(withRequestChangesTarget('flow-rc-reorder', { requestChangesToStepId: 'review' }));
  const [build, review, signoff] = created.steps;
  await assert.rejects(
    () => workflowService.updateWorkflow('flow-rc-reorder', { steps: [build!, signoff!, review!] }),
    (error: Error) => error instanceof workflowService.InvalidWorkflowError && /Request changes must go back to an earlier step/.test(error.message),
  );
});

test('every Quick look kind round-trips through create and get; absent and null are accepted as none', async () => {
  const kinds = ['none', 'code', 'diff', 'documents', 'commands'] as const;
  const input = validInput('flow-quick-look');
  input.steps = [
    ...kinds.map((quickLook, index) => ({ ...input.steps[0]!, id: `step-${index}`, name: `Step ${index}`, quickLook })),
    { ...input.steps[0]!, id: 'step-null', name: 'Step null', quickLook: null },
    { ...input.steps[0]!, id: 'step-absent', name: 'Step absent' },
  ];
  await workflowService.createWorkflow(input);
  const fetched = await workflowService.getWorkflow('flow-quick-look');
  assert.deepEqual(fetched?.steps.map((step) => step.quickLook), [...kinds, null, undefined]);
});

test('an unknown Quick look value is rejected with a message naming the step and the allowed values', async () => {
  for (const quickLook of ['files', 'Code', 3, true]) {
    const input = validInput(`flow-bad-quick-look-${String(quickLook).toLowerCase()}`);
    input.steps = [{ ...input.steps[0]!, quickLook: quickLook as never }];
    await assert.rejects(
      () => workflowService.createWorkflow(input),
      (error: Error) => error instanceof workflowService.InvalidWorkflowError
        && /Development/.test(error.message)
        && /quickLook must be one of none, code, diff, documents, commands/.test(error.message),
      String(quickLook),
    );
  }
});

test('a changed Quick look reaches new snapshots while an earlier snapshot keeps its value', async () => {
  const created = await workflowService.createWorkflow({ ...validInput('flow-quick-look-edit'), steps: [{ ...validInput('x').steps[0]!, quickLook: 'code' }] });
  const earlierRun = workflowService.snapshotWorkflow(created);
  const updated = await workflowService.updateWorkflow('flow-quick-look-edit', { steps: [{ ...created.steps[0]!, quickLook: 'diff' }] });
  assert.equal(workflowService.snapshotWorkflow(updated).steps[0]!.quickLook, 'diff');
  assert.equal(earlierRun.steps[0]!.quickLook, 'code');
});

test('updateWorkflow patches fields and re-validates the merged result', async () => {
  await workflowService.createWorkflow(validInput('flow-m'));
  const updated = await workflowService.updateWorkflow('flow-m', { name: 'Renamed', enabled: false });
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.enabled, false);
  assert.equal(updated.description, 'A minimal one-step workflow.', 'untouched fields are kept');

  await assert.rejects(() => workflowService.updateWorkflow('flow-m', { name: '' }), workflowService.InvalidWorkflowError);
  await assert.rejects(() => workflowService.updateWorkflow('does-not-exist', { name: 'x' }), workflowService.WorkflowNotFoundError);
});

test('deleteWorkflow removes the file and resets every Project that had selected it back to the default (null)', async () => {
  await workflowService.createWorkflow(validInput('flow-n'));
  const project = await projectService.createProject({ name: 'Uses Flow N', position: null });
  await projectService.patchProject(project.id, { workflowId: 'flow-n' });
  assert.equal((await projectService.getProject(project.id)).workflowId, 'flow-n');

  await workflowService.deleteWorkflow('flow-n');
  assert.equal(await workflowService.getWorkflow('flow-n'), undefined);
  assert.equal((await projectService.getProject(project.id)).workflowId, null);
});

test('deleteWorkflow on a missing id throws WorkflowNotFoundError', async () => {
  await assert.rejects(() => workflowService.deleteWorkflow('never-existed'), workflowService.WorkflowNotFoundError);
});

test('snapshotWorkflow returns a deep, independent copy — mutating it never touches the original', async () => {
  const workflow = await workflowService.createWorkflow(validInput('flow-o'));
  const snapshot = workflowService.snapshotWorkflow(workflow);
  assert.deepEqual(snapshot, workflow);
  snapshot.steps[0]!.name = 'Mutated';
  assert.equal(workflow.steps[0]?.name, 'Development', 'the original is untouched');
});

test('createWorkflow accepts a boolean or absent canRunCommands and rejects anything else', async () => {
  const step = { id: 'a', name: 'A', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'x' };
  const created = await workflowService.createWorkflow({ ...validInput('flow-cmd-ok'), steps: [{ ...step, canRunCommands: true }] });
  assert.equal(created.steps[0]?.canRunCommands, true);
  await workflowService.createWorkflow({ ...validInput('flow-cmd-false'), steps: [{ ...step, canRunCommands: false }] });
  const absent = await workflowService.createWorkflow({ ...validInput('flow-cmd-absent'), steps: [step] });
  assert.equal('canRunCommands' in absent.steps[0]!, false);
  for (const [index, bad] of ['true', 1, 0, null, {}, []].entries()) {
    await assert.rejects(
      () => workflowService.createWorkflow({ ...validInput(`flow-cmd-bad-${index}`), steps: [{ ...step, canRunCommands: bad as unknown as boolean }] }),
      /step "A": canRunCommands must be a boolean/,
    );
  }
});

test('createWorkflow accepts a preloadSkillIds subset (round-trips) and an absent one, and rejects a non-subset or malformed one', async () => {
  await catalogService.createSkill({ id: 'lint-rules', name: 'Lint', description: 'Lint.', body: 'x' }).catch(() => undefined);
  await catalogService.createSkill({ id: 'commit-style', name: 'Commit', description: 'Commit.', body: 'x' }).catch(() => undefined);
  const step = (extra: object) => ({ id: 'a', name: 'A', agentId: 'builder', skillIds: ['lint-rules'], canEditCode: false, requiresApproval: false, instructions: 'x', ...extra });
  const saved = await workflowService.createWorkflow({ ...validInput('flow-preload-ok'), steps: [step({ preloadSkillIds: ['lint-rules'] })] });
  assert.deepEqual(saved.steps[0]!.preloadSkillIds, ['lint-rules']);
  await workflowService.createWorkflow({ ...validInput('flow-preload-absent'), steps: [step({})] });
  await workflowService.createWorkflow({ ...validInput('flow-preload-empty'), steps: [step({ preloadSkillIds: [] })] });
  await assert.rejects(
    () => workflowService.createWorkflow({ ...validInput('flow-preload-bad'), steps: [step({ preloadSkillIds: ['commit-style'] })] }),
    /step "A": preloadSkillIds must be a subset of skillIds: "commit-style" is not an attached skill/,
  );
  await assert.rejects(
    () => workflowService.createWorkflow({ ...validInput('flow-preload-nostr'), steps: [step({ preloadSkillIds: [1] })] }),
    /preloadSkillIds must be an array of strings/,
  );
});
