import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PLAN_DIR, PLAN_DOC_KEYS, PLAN_DOC_FILENAMES, stubPlanDoc } from '../src/projects/plan.ts';
import { PathTraversalError } from '../src/projects/fileTree.ts';
import { UnknownPlanDocumentError, listProjectDocuments, readPlanDocumentRaw } from '../src/projects/documents.ts';

let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'documents-test-'));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** Nothing in application code writes all five plan docs at once any more — this test-only helper seeds them directly. */
async function writeAllStubPlanDocs(project: string): Promise<void> {
  await mkdir(path.join(project, PLAN_DIR), { recursive: true });
  await Promise.all(PLAN_DOC_KEYS.map((key) => writeFile(path.join(project, PLAN_DIR, PLAN_DOC_FILENAMES[key]), stubPlanDoc(key))));
}

test('listProjectDocuments always lists the blueprint file, plus every real file in the plan directory', async () => {
  const project = path.join(tempRoot, 'proj-1');
  await writeAllStubPlanDocs(project);

  const documents = await listProjectDocuments(project);
  assert.deepEqual(documents.blueprint, { name: 'blueprint.md', title: 'Blueprint' });
  assert.equal(documents.plan.length, 5, 'the five stub plan docs, read from disk rather than a hardcoded count');
  const specs = documents.plan.find((d) => d.name === 'specifications.md');
  assert.deepEqual(specs, { name: 'specifications.md', title: 'Specifications', docKey: 'specifications' });
});

test('listProjectDocuments reflects the plan directory as it actually is, not a fixed 5-key assumption', async () => {
  const project = path.join(tempRoot, 'proj-2-custom');
  await mkdir(path.join(project, PLAN_DIR), { recursive: true });
  await writeFile(path.join(project, PLAN_DIR, 'requirements.md'), '# Requirements\n');
  await writeFile(path.join(project, PLAN_DIR, 'notes.md'), '# Extra notes\n');

  const documents = await listProjectDocuments(project);
  assert.equal(documents.plan.length, 2, 'only the files that actually exist, not the full fixed set');
  const requirements = documents.plan.find((d) => d.name === 'requirements.md');
  assert.equal(requirements?.docKey, 'requirements');
  const notes = documents.plan.find((d) => d.name === 'notes.md');
  assert.equal(notes?.docKey, null, 'an unrecognized file is still listed, just without a known doc key');
});

test('listProjectDocuments returns an empty plan list (not an error) when the plan directory does not exist yet', async () => {
  const project = path.join(tempRoot, 'proj-3-no-plan-dir');
  const documents = await listProjectDocuments(project);
  assert.deepEqual(documents.plan, []);
});

test('listProjectDocuments orders known docs first in their fixed display order, then extras alphabetically', async () => {
  const project = path.join(tempRoot, 'proj-4-order');
  await writeAllStubPlanDocs(project);
  await writeFile(path.join(project, PLAN_DIR, 'zz-extra.md'), 'x');
  await writeFile(path.join(project, PLAN_DIR, 'aa-extra.md'), 'x');

  const names = (await listProjectDocuments(project)).plan.map((d) => d.name);
  assert.deepEqual(names, [
    'specifications.md', 'requirements.md', 'test-cases.md', 'e2e-testing.md', 'performance-testing.md',
    'aa-extra.md', 'zz-extra.md',
  ]);
});

test('readPlanDocumentRaw reads an unrecognized plan-dir file read-only', async () => {
  const project = path.join(tempRoot, 'proj-5-raw');
  await mkdir(path.join(project, PLAN_DIR), { recursive: true });
  await writeFile(path.join(project, PLAN_DIR, 'notes.md'), '# Notes\n\nSome extra notes.\n');

  const content = await readPlanDocumentRaw(project, 'notes.md');
  assert.equal(content, '# Notes\n\nSome extra notes.\n');
});

test('readPlanDocumentRaw 404s (UnknownPlanDocumentError) for a file that does not exist', async () => {
  const project = path.join(tempRoot, 'proj-6-missing');
  await mkdir(path.join(project, PLAN_DIR), { recursive: true });
  await assert.rejects(() => readPlanDocumentRaw(project, 'does-not-exist.md'), UnknownPlanDocumentError);
});

test('readPlanDocumentRaw rejects a path-traversal attempt rather than reading outside the plan directory', async () => {
  const project = path.join(tempRoot, 'proj-7-traversal');
  await mkdir(path.join(project, PLAN_DIR), { recursive: true });
  await writeFile(path.join(project, 'secret.md'), 'top secret project file');

  await assert.rejects(() => readPlanDocumentRaw(project, '../secret.md'), PathTraversalError);
  await assert.rejects(() => readPlanDocumentRaw(project, '/etc/passwd'), PathTraversalError);
});
