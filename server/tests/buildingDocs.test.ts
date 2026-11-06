import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '..', '..');
const read = (file: string) => readFile(path.join(repo, file), 'utf8');

test('AC7 the docs describe Building Types, the contract, the bulk data layer with the engine and benchmark, and the tenancy constraints', async () => {
  const architecture = await read('docs/architecture.md');
  for (const needle of ['Building Type', 'coded, not configured', 'Workflow slots', 'Repository-only features', 'better-sqlite3', 'Benchmark', 'p95', 'Tenancy is design constraints only', 'SecretsStore', 'ownerId', 'Retention', 'Migrations']) {
    assert.ok(architecture.includes(needle), `docs/architecture.md should mention "${needle}"`);
  }
  const blueprint = await read('.docs/blueprint.md');
  for (const needle of ['Building Types and the bulk data layer', 'read-only', 'Not yet implemented']) assert.ok(blueprint.includes(needle), `.docs/blueprint.md should mention "${needle}"`);
  const glossary = await read('docs/glossary.md');
  for (const term of ['## Building Type', '## Workflow slot', '## Bulk data layer', '## Retention rule', '## Read-only Building']) assert.ok(glossary.includes(term), `docs/glossary.md should define "${term}"`);
});
