import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { WorkflowInput } from '../src/catalog/workflowService.ts';

/**
 * `getDefaultWorkflow`/`resolveWorkflowForProject`'s fallback chain depends on which workflows
 * exist and are enabled at the moment of the call — this file starts from a completely empty
 * Catalog (no agents/skills fixture needed since no test here creates a Workflow that references
 * one) and builds it up one ordered test at a time, so each assertion sees an unambiguous state.
 * Kept apart from workflowService.test.ts, whose CRUD/validation tests freely create workflows in
 * whatever order and would otherwise make "no workflow available yet" impossible to observe.
 */

let tempRoot: string;
let workflowService: typeof import('../src/catalog/workflowService.ts');

function validInput(id: string, enabled = true): WorkflowInput {
  return {
    id,
    name: 'Flow',
    description: 'desc',
    enabled,
    steps: [{ id: 'step-1', name: 'Step 1', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Do it.' }],
  };
}

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'workflow-defaults-test-'));
  const catalogDir = path.join(tempRoot, 'catalog');
  await mkdir(path.join(catalogDir, 'agents'), { recursive: true });
  await writeFile(
    path.join(catalogDir, 'agents', 'builder.md'),
    '---\nname: builder\ndescription: test builder\n---\n\nBuild things.\n',
  );
  await writeFile(path.join(catalogDir, 'catalog-index.json'), JSON.stringify({
    agents: { builder: { name: 'Builder', avatar: '🤖', manager: false, defaultAutonomy: 'auto', enabled: true } },
    skills: {},
  }));
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = catalogDir;
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  workflowService = await import('../src/catalog/workflowService.ts');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('an empty Catalog has no default workflow, and resolving one for a Project throws NoWorkflowAvailableError', async () => {
  assert.equal(await workflowService.getDefaultWorkflow(), undefined);
  await assert.rejects(() => workflowService.resolveWorkflowForProject({ workflowId: null }), workflowService.NoWorkflowAvailableError);
  await assert.rejects(() => workflowService.resolveWorkflowForProject({ workflowId: 'nope' }), workflowService.NoWorkflowAvailableError);
});

test('with only a non-seeded enabled workflow, getDefaultWorkflow falls back to the first enabled one', async () => {
  await workflowService.createWorkflow(validInput('backup-flow'));
  const chosen = await workflowService.getDefaultWorkflow();
  assert.equal(chosen?.id, 'backup-flow');
  assert.equal((await workflowService.resolveWorkflowForProject({ workflowId: null })).id, 'backup-flow');
});

test('once the seeded "software-development" id exists and is enabled, it wins over any other enabled workflow', async () => {
  await workflowService.createWorkflow(validInput('software-development'));
  const chosen = await workflowService.getDefaultWorkflow();
  assert.equal(chosen?.id, 'software-development');
});

test('a Project\'s own workflowId wins over the default when it resolves to an enabled workflow', async () => {
  const resolved = await workflowService.resolveWorkflowForProject({ workflowId: 'backup-flow' });
  assert.equal(resolved.id, 'backup-flow');
});

test('a Project workflowId that is disabled or missing falls back to the Catalog default rather than throwing', async () => {
  await workflowService.updateWorkflow('backup-flow', { enabled: false });
  assert.equal((await workflowService.resolveWorkflowForProject({ workflowId: 'backup-flow' })).id, 'software-development');
  assert.equal((await workflowService.resolveWorkflowForProject({ workflowId: 'never-created' })).id, 'software-development');
});

test('disabling the seeded id falls getDefaultWorkflow back to the first remaining enabled workflow', async () => {
  await workflowService.updateWorkflow('software-development', { enabled: false });
  await workflowService.createWorkflow(validInput('third-flow'));
  const chosen = await workflowService.getDefaultWorkflow();
  assert.equal(chosen?.id, 'third-flow');
});
