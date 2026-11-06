import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createInsightsAgent } from '../src/content/insightsAgent.ts';

type Options = { cwd: string; prompt: string; appendSystemPrompt: string; disallowedTools: string[]; onProcess: (child: { kill(): unknown }) => void };
const input = (signal = new AbortController().signal) => ({ buildingId: 'b', dataFile: '/tmp/data.json', instructions: 'INSTR', signal });

test('the default insights agent runs in a throwaway folder with only Read allowed, returns the answer text and removes the folder', async () => {
  let seen: Options | undefined;
  const agent = createInsightsAgent({
    selectExecutor: async () => ({}),
    runTurn: async (_e, options) => { seen = options as Options; return { status: 'done', message: 'ok', extra: { text: '{"markdown":"x"}' } }; },
  });
  assert.equal(await agent.run(input()), '{"markdown":"x"}');
  assert.ok(seen!.prompt.includes('/tmp/data.json'));
  assert.equal(seen!.appendSystemPrompt, 'INSTR');
  assert.equal(seen!.disallowedTools.includes('Read'), false);
  for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch']) assert.ok(seen!.disallowedTools.includes(tool), tool);
  assert.equal(existsSync(seen!.cwd), false);
});

test('no executor, an unanswered turn and a missing text are errors; an abort kills the process', async () => {
  await assert.rejects(createInsightsAgent({ selectExecutor: async () => null, runTurn: async () => ({ status: 'done', message: '' }) }).run(input()), /No agent is available/);
  await assert.rejects(createInsightsAgent({ selectExecutor: async () => ({}), runTurn: async () => ({ status: 'blocked', message: 'limit', extra: {} }) }).run(input()), /did not answer: limit/);
  const kills: string[] = [];
  const controller = new AbortController();
  const agent = createInsightsAgent({
    selectExecutor: async () => ({}),
    runTurn: async (_e, options) => {
      (options as Options).onProcess({ kill: () => kills.push('late') });
      controller.abort();
      return { status: 'done', message: '', extra: { text: 't' } };
    },
  });
  await agent.run(input(controller.signal));
  assert.deepEqual(kills, ['late']);
  controller.abort();
  const already: string[] = [];
  await createInsightsAgent({ selectExecutor: async () => ({}), runTurn: async (_e, options) => { (options as Options).onProcess({ kill: () => already.push('now') }); return { status: 'done', message: '', extra: { text: 't' } }; } }).run(input(controller.signal));
  assert.deepEqual(already, ['now']);
});
