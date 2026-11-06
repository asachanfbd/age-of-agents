import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '..', '..');
const read = (file: string) => readFile(path.join(repo, file), 'utf8');

test('I73 the docs describe capabilities, events, links, which sessions get tools, and the validation contract', async () => {
  const connections = await read('docs/connections.md');
  for (const needle of [
    'Capabilities', 'Events', 'Links', 'pre-approved', 'broken', 'Which sessions get tools', 'Planning session', 'Read-only workflow step', 'validation contract',
    '404', '403', '409', '400', '`{ error }`', 'rejected, never shortened', 'Idempotency', 'depth **3**', 'Activity log', 'Building deleted', 'Not yet implemented',
  ]) {
    assert.ok(connections.includes(needle) || connections.toLowerCase().includes(needle.toLowerCase()), `docs/connections.md should mention "${needle}"`);
  }
  const architecture = await read('docs/architecture.md');
  assert.ok(architecture.includes('connections.md'), 'docs/architecture.md should link the connections doc');
  assert.equal(architecture.includes('accepted and stored but not acted on'), false, 'the old "declarations are not acted on" line should be gone');
  const glossary = await read('docs/glossary.md');
  for (const term of ['## Capability', '## Event', '## Link', '## Activity log']) assert.ok(glossary.includes(term), `docs/glossary.md should define "${term}"`);
  const blueprint = await read('.docs/blueprint.md');
  assert.ok(blueprint.includes('Connections between Buildings'));
});

test('I120 the blueprint and connections doc list the task capabilities, status words, limits and the default-on rule', async () => {
  const blueprint = await read('.docs/blueprint.md');
  const connections = await read('docs/connections.md');
  for (const needle of ['get-task-details', 'list-completed-tasks', 'waiting-for-input', 'not-started', 'truncated', '20,000', 'every capability checked', 'grantsVersion']) {
    assert.ok(blueprint.includes(needle), `.docs/blueprint.md should mention "${needle}"`);
  }
  for (const needle of ['Status vocabulary', 'Default-on grants', 'nextCursor', 'Task not found', 'descriptionTruncated']) assert.ok(connections.includes(needle), `docs/connections.md should mention "${needle}"`);
});
