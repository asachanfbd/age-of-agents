import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access } from 'node:fs/promises';
import { codexArgs, codexSchema, extractCodexUsage, runCodexTurn } from '../src/worker/codexProcess.ts';
import type { SpawnFn } from '../src/worker/claudeProcess.ts';
import { codexMcpArgs } from '../src/terminal/mcpServers.ts';
import { stepTaskMcpServer } from '../src/terminal/stepTaskTool.ts';
import { testTaskMcpServer } from '../src/terminal/testTaskTool.ts';

const options = { cwd: '/tmp', prompt: 'go', permissionMode: 'default' as const };
test('fresh and resumed calls preserve schema, persona, permissions and disabled shell', () => {
  for (const resumeSessionId of [null, 'session-123']) {
    const args = codexArgs({ ...options, resumeSessionId, appendSystemPrompt: 'Builder', disallowedTools: ['Bash'] }, '/tmp/schema.json');
    assert.ok(args.includes('sandbox_mode="read-only"'));
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes('features.shell_tool=false'));
    assert.ok(args.includes('developer_instructions="Builder"'));
    assert.equal(args.includes('resume'), !!resumeSessionId);
    assert.equal(args.at(-1), 'go');
    if (resumeSessionId) assert.equal(args.at(-2), resumeSessionId);
  }
  assert.ok(codexArgs({ ...options, permissionMode: 'bypassPermissions' }, 'schema').includes('sandbox_mode="danger-full-access"'));
});
test('an optional schema field becomes required-but-nullable for strict structured output', () => {
  const schema = codexSchema({
    type: 'object',
    properties: { status: { type: 'string' }, message: { type: 'string' }, note: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } } },
    required: ['status', 'message'],
  }) as any;
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('note'));
  assert.deepEqual(schema.properties.note.anyOf[1], { type: 'null' });
});
test('cached tokens are included exactly once', () => {
  assert.deepEqual(extractCodexUsage({ input_tokens: 100, cached_input_tokens: 75, output_tokens: 10 }), { inputTokens: 25, outputTokens: 10, cacheReadInputTokens: 75, cacheCreationInputTokens: 0, totalCostUsd: 0 });
  assert.equal(extractCodexUsage(null), null);
});

for (const outcome of ['done', 'blocked', 'failed', 'invalid', 'nonzero', 'missing']) {
  test(`Codex subprocess ${outcome} outcome and cleanup`, async () => {
    let schemaPath = '';
    const events: unknown[] = [];
    const spawnFn: SpawnFn = (bin, args, config) => {
      assert.equal(bin, '/custom/codex');
      assert.equal(config.env.CODEX_HOME, '/custom/account');
      schemaPath = args[args.indexOf('--output-schema') + 1]!;
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough() });
      setImmediate(() => {
        const emit = (event: unknown) => stdout.write(JSON.stringify(event) + '\n');
        emit({ type: 'thread.started', thread_id: 'session-1' });
        emit({ type: 'item.completed', item: { type: 'agent_message', text: outcome === 'invalid' ? 'oops' : JSON.stringify({ status: outcome === 'blocked' ? 'blocked' : 'done', message: 'result', note: { tags: [], other: null } }) } });
        if (outcome === 'failed') emit({ type: 'turn.failed', error: { message: 'rate limited' } });
        else if (outcome !== 'missing') emit({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 2 } });
        child.emit('close', outcome === 'nonzero' ? 1 : 0);
      });
      return child as unknown as ReturnType<SpawnFn>;
    };
    const result = await runCodexTurn({ ...options, bin: '/custom/codex', env: { CODEX_HOME: '/custom/account' }, spawnFn, onEvent: e => events.push(e) });
    assert.equal(result.sessionId, 'session-1');
    assert.equal(result.status, outcome === 'done' || outcome === 'blocked' ? outcome : 'error');
    assert.ok(events.length >= 2);
    if (outcome === 'done') assert.deepEqual(result.extra, { note: { tags: [] } });
    await assert.rejects(access(schemaPath));
  });
}
test('spawn errors reject and clean up schema', async () => {
  let schema = '';
  await assert.rejects(runCodexTurn({ ...options, spawnFn: (_bin, args) => { schema = args[args.indexOf('--output-schema') + 1]!; throw new Error('ENOENT'); } }), /ENOENT/);
  await assert.rejects(access(schema));
});

test('resumed cumulative usage subtracts previously recorded session tokens', () => {
  assert.deepEqual(extractCodexUsage({ input_tokens: 250, cached_input_tokens: 150, output_tokens: 30 }, { inputTokens: 75, cacheReadInputTokens: 25, outputTokens: 10, cacheCreationInputTokens: 0, totalCostUsd: 0 }), { inputTokens: 25, cacheReadInputTokens: 125, outputTokens: 20, cacheCreationInputTokens: 0, totalCostUsd: 0 });
});

test('every session MCP server is registered through the shared builder ahead of the prompt, fresh or resumed', () => {
  const servers = [stepTaskMcpServer('t1'), testTaskMcpServer('t1')];
  const expected = codexMcpArgs(servers);
  for (const resumeSessionId of [null, 'session-123']) {
    const args = codexArgs({ ...options, resumeSessionId, mcpServers: servers }, 'schema');
    const start = args.indexOf(expected[1]!) - 1;
    assert.deepEqual(args.slice(start, start + expected.length), expected);
    assert.equal(args[start + expected.length], '--', 'the overrides come before the positional prompt');
    assert.ok(args.includes('mcp_servers.agent_visual_os_tests.tools.run_test_action.approval_mode="approve"'));
  }
  assert.equal(codexArgs(options, 'schema').some((arg) => arg.startsWith('mcp_servers.')), false);
});
