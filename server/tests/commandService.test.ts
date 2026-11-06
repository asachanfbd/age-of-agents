import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let commandService: typeof import('../src/commands/commandService.ts');
let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'command-service-test-'));
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  commandService = await import('../src/commands/commandService.ts');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test('createCommand starts un-highlighted; listCommands scopes to the project, oldest first', async () => {
  const a1 = await commandService.createCommand({ projectId: 'proj-a', name: 'Build', command: 'npm run build' });
  const a2 = await commandService.createCommand({ projectId: 'proj-a', name: 'Test', command: 'npm test' });
  await commandService.createCommand({ projectId: 'proj-b', name: 'Other project', command: 'echo hi' });

  assert.equal(a1.highlighted, false);
  const items = await commandService.listCommands('proj-a');
  assert.deepEqual(items.map((c) => c.name), ['Build', 'Test']);
  assert.deepEqual(items.map((c) => c.id), [a1.id, a2.id]);
});

test('updateCommand patches given fields and leaves others alone', async () => {
  const command = await commandService.createCommand({ projectId: 'proj-c', name: 'Lint', command: 'npm run lint' });
  const updated = await commandService.updateCommand(command.id, { command: 'npm run lint --fix' });
  assert.equal(updated.name, 'Lint');
  assert.equal(updated.command, 'npm run lint --fix');
});

test('updateCommand throws CommandNotFoundError for an unknown id', async () => {
  await assert.rejects(() => commandService.updateCommand('no-such-id', { name: 'x' }), commandService.CommandNotFoundError);
});

test('deleteCommand removes a command; getCommand then throws CommandNotFoundError', async () => {
  const command = await commandService.createCommand({ projectId: 'proj-d', name: 'Deploy', command: 'npm run deploy' });
  await commandService.deleteCommand(command.id);
  await assert.rejects(() => commandService.getCommand(command.id), commandService.CommandNotFoundError);
});

test('deleteCommand throws CommandNotFoundError for an unknown id', async () => {
  await assert.rejects(() => commandService.deleteCommand('no-such-id'), commandService.CommandNotFoundError);
});

test('at most 3 commands can be highlighted per project', async () => {
  const commands = await Promise.all(
    ['A', 'B', 'C', 'D'].map((name) => commandService.createCommand({ projectId: 'proj-e', name, command: `echo ${name}` })),
  );

  for (const command of commands.slice(0, 3)) {
    const updated = await commandService.updateCommand(command.id, { highlighted: true });
    assert.equal(updated.highlighted, true);
  }

  await assert.rejects(
    () => commandService.updateCommand(commands[3]!.id, { highlighted: true }),
    commandService.CommandHighlightLimitError,
  );

  // Un-highlighting one frees a slot for another.
  await commandService.updateCommand(commands[0]!.id, { highlighted: false });
  const nowHighlighted = await commandService.updateCommand(commands[3]!.id, { highlighted: true });
  assert.equal(nowHighlighted.highlighted, true);
});

test('re-saving an already-highlighted command (e.g. renaming it) never counts against the cap', async () => {
  const commands = await Promise.all(
    ['A', 'B', 'C'].map((name) => commandService.createCommand({ projectId: 'proj-f', name, command: `echo ${name}` })),
  );
  for (const command of commands) await commandService.updateCommand(command.id, { highlighted: true });

  const renamed = await commandService.updateCommand(commands[0]!.id, { name: 'A renamed', highlighted: true });
  assert.equal(renamed.name, 'A renamed');
  assert.equal(renamed.highlighted, true);
});

test('the highlight cap is scoped per project, not global', async () => {
  const projA = await Promise.all(
    ['A1', 'A2', 'A3'].map((name) => commandService.createCommand({ projectId: 'proj-g', name, command: `echo ${name}` })),
  );
  for (const command of projA) await commandService.updateCommand(command.id, { highlighted: true });

  const otherProjectCommand = await commandService.createCommand({ projectId: 'proj-h', name: 'B1', command: 'echo B1' });
  const updated = await commandService.updateCommand(otherProjectCommand.id, { highlighted: true });
  assert.equal(updated.highlighted, true);
});

test('createCommand can highlight a command at creation, and still enforces the 3-highlighted cap there', async () => {
  const highlightedAtCreation = await commandService.createCommand({ projectId: 'proj-i', name: 'A', command: 'echo A', highlighted: true });
  assert.equal(highlightedAtCreation.highlighted, true);

  await commandService.createCommand({ projectId: 'proj-i', name: 'B', command: 'echo B', highlighted: true });
  await commandService.createCommand({ projectId: 'proj-i', name: 'C', command: 'echo C', highlighted: true });

  await assert.rejects(
    () => commandService.createCommand({ projectId: 'proj-i', name: 'D', command: 'echo D', highlighted: true }),
    commandService.CommandHighlightLimitError,
  );
  // The rejected create must not have persisted a 4th, un-highlighted command either.
  assert.equal((await commandService.listCommands('proj-i')).length, 3);
});
