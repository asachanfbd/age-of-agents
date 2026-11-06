import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { extractTokenUsage, runClaudeTurn, STATUS_SCHEMA, type SpawnFn } from '../src/worker/claudeProcess.ts';
import { claudeMcpArgs, type McpServerLaunch } from '../src/terminal/mcpServers.ts';
import { stepTaskMcpServer } from '../src/terminal/stepTaskTool.ts';
import { testTaskMcpServer } from '../src/terminal/testTaskTool.ts';

/**
 * A fake child process good enough for claudeProcess.ts's needs: readable
 * stdout/stderr, an EventEmitter for 'error'/'close', nothing else. Tests
 * drive it by writing to `stdout`/`stderr` and calling `close(code)`.
 */
function fakeChildProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, { stdout, stderr }) as unknown as ReturnType<SpawnFn>;
  return {
    child,
    emitLine: (obj: unknown) => stdout.write(`${JSON.stringify(obj)}\n`),
    emitRawLine: (text: string) => stdout.write(`${text}\n`),
    emitStderr: (text: string) => stderr.write(text),
    close: (code: number | null) => emitter.emit('close', code),
    fail: (error: Error) => emitter.emit('error', error),
  };
}

test('sends the expected CLI arguments for a fresh turn with full autonomy', async () => {
  let capturedArgs: string[] = [];
  const fake = fakeChildProcess();
  const spawnFn: SpawnFn = (command, args) => {
    capturedArgs = args;
    return fake.child;
  };

  const resultPromise = runClaudeTurn({
    cwd: '/tmp/some-project',
    prompt: 'Build the thing',
    permissionMode: 'bypassPermissions',
    appendSystemPrompt: 'You are a builder.',
    spawnFn,
  });

  fake.emitLine({ type: 'result', session_id: 's1', result: JSON.stringify({ status: 'done', message: 'ok' }) });
  fake.close(0);
  await resultPromise;

  assert.deepEqual(capturedArgs, [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt', 'You are a builder.',
    '--json-schema', JSON.stringify(STATUS_SCHEMA),
    'Build the thing',
  ]);
});

test('spawns the given bin (not the default) and merges given env vars over process.env', async () => {
  let capturedCommand = '';
  let capturedEnv: NodeJS.ProcessEnv = {};
  const fake = fakeChildProcess();
  const spawnFn: SpawnFn = (command, _args, options) => {
    capturedCommand = command;
    capturedEnv = options.env;
    return fake.child;
  };

  const resultPromise = runClaudeTurn({
    cwd: '/tmp',
    prompt: 'go',
    permissionMode: 'bypassPermissions',
    bin: '/Users/someone/.local/bin/claude',
    env: { CLAUDE_CONFIG_DIR: '/Users/someone/.claude-ds' },
    spawnFn,
  });

  fake.emitLine({ type: 'result', session_id: 's1', result: JSON.stringify({ status: 'done', message: 'ok' }) });
  fake.close(0);
  await resultPromise;

  assert.equal(capturedCommand, '/Users/someone/.local/bin/claude');
  assert.equal(capturedEnv.CLAUDE_CONFIG_DIR, '/Users/someone/.claude-ds');
  // process.env itself is still present alongside the override, not replaced wholesale.
  assert.equal(capturedEnv.PATH, process.env.PATH);
});

test('passes --disallowed-tools when given, and a custom --json-schema in place of the default', async () => {
  let capturedArgs: string[] = [];
  const fake = fakeChildProcess();
  const spawnFn: SpawnFn = (command, args) => {
    capturedArgs = args;
    return fake.child;
  };
  const customSchema = { type: 'object', properties: { status: { type: 'string' } } };

  const resultPromise = runClaudeTurn({
    cwd: '/tmp',
    prompt: 'Plan it',
    permissionMode: 'bypassPermissions',
    disallowedTools: ['Bash', 'BashOutput'],
    jsonSchema: customSchema,
    spawnFn,
  });

  fake.emitLine({ type: 'result', session_id: 's1', result: JSON.stringify({ status: 'done', message: 'ok' }) });
  fake.close(0);
  await resultPromise;

  assert.ok(capturedArgs.includes('--disallowed-tools'));
  assert.equal(capturedArgs[capturedArgs.indexOf('--disallowed-tools') + 1], 'Bash,BashOutput');
  assert.equal(capturedArgs[capturedArgs.indexOf('--json-schema') + 1], JSON.stringify(customSchema));
});

test('omits --disallowed-tools entirely when none are given', async () => {
  let capturedArgs: string[] = [];
  const fake = fakeChildProcess();
  const spawnFn: SpawnFn = (command, args) => {
    capturedArgs = args;
    return fake.child;
  };

  const resultPromise = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn });
  fake.emitLine({ type: 'result', session_id: 's1', result: JSON.stringify({ status: 'done', message: 'ok' }) });
  fake.close(0);
  await resultPromise;

  assert.ok(!capturedArgs.includes('--disallowed-tools'));
});

test('surfaces extra top-level JSON fields (e.g. planTasks) alongside status/message', async () => {
  const fake = fakeChildProcess();
  const resultPromise = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn: () => fake.child });

  fake.emitLine({
    type: 'result',
    session_id: 'abc',
    result: JSON.stringify({ status: 'done', message: 'Updated the plan', planTasks: { add: [{ title: 'A', description: 'B' }] } }),
  });
  fake.close(0);

  const result = await resultPromise;
  assert.deepEqual(result.extra, { planTasks: { add: [{ title: 'A', description: 'B' }] } });
});

test('extra is empty when the result has no fields beyond status/message, or failed to parse as JSON', async () => {
  const fake1 = fakeChildProcess();
  const p1 = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn: () => fake1.child });
  fake1.emitLine({ type: 'result', session_id: 'abc', result: JSON.stringify({ status: 'done', message: 'ok' }) });
  fake1.close(0);
  assert.deepEqual((await p1).extra, {});

  const fake2 = fakeChildProcess();
  const p2 = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn: () => fake2.child });
  fake2.emitLine({ type: 'result', session_id: 'abc', result: 'not json' });
  fake2.close(0);
  assert.deepEqual((await p2).extra, {});
});

test('extractTokenUsage reads input/output/cache tokens and cost off a raw result event', () => {
  const usage = extractTokenUsage({
    type: 'result',
    session_id: 'abc',
    result: '{}',
    total_cost_usd: 0.0234,
    usage: {
      input_tokens: 120,
      output_tokens: 45,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 500,
    },
  });

  assert.deepEqual(usage, {
    inputTokens: 120,
    outputTokens: 45,
    cacheCreationInputTokens: 10,
    cacheReadInputTokens: 500,
    totalCostUsd: 0.0234,
  });
});

test('extractTokenUsage returns null when the result event carries no usage object', () => {
  assert.equal(extractTokenUsage({ type: 'result', session_id: 'abc', result: '{}' }), null);
  assert.equal(extractTokenUsage({ type: 'result', session_id: 'abc', result: '{}', usage: 'not an object' }), null);
});

test('extractTokenUsage treats missing individual usage fields as zero rather than throwing', () => {
  const usage = extractTokenUsage({ type: 'result', session_id: 'abc', result: '{}', usage: { input_tokens: 7 } });
  assert.deepEqual(usage, {
    inputTokens: 7,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalCostUsd: 0,
  });
});

test('runClaudeTurn threads token usage from the result event onto every outcome', async () => {
  const withUsage = (result: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'result',
    session_id: 'abc',
    result,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    total_cost_usd: 0.01,
    ...extra,
  });

  const doneFake = fakeChildProcess();
  const donePromise = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn: () => doneFake.child });
  doneFake.emitLine(withUsage(JSON.stringify({ status: 'done', message: 'ok' })));
  doneFake.close(0);
  assert.deepEqual((await donePromise).usage, { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0.01 });

  const blockedFake = fakeChildProcess();
  const blockedPromise = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn: () => blockedFake.child });
  blockedFake.emitLine(withUsage(JSON.stringify({ status: 'blocked', message: 'which?' })));
  blockedFake.close(0);
  assert.equal((await blockedPromise).usage?.inputTokens, 100);

  const errorFake = fakeChildProcess();
  const errorPromise = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn: () => errorFake.child });
  errorFake.emitLine(withUsage('denied', { is_error: true }));
  errorFake.close(1);
  assert.equal((await errorPromise).usage?.inputTokens, 100);
});

test('inserts --resume right after -p when continuing a session', async () => {
  let capturedArgs: string[] = [];
  const fake = fakeChildProcess();
  const spawnFn: SpawnFn = (command, args) => {
    capturedArgs = args;
    return fake.child;
  };

  const resultPromise = runClaudeTurn({
    cwd: '/tmp/some-project',
    prompt: 'Use Node.js',
    resumeSessionId: 'session-42',
    permissionMode: 'bypassPermissions',
    spawnFn,
  });

  fake.emitLine({ type: 'result', session_id: 'session-42', result: JSON.stringify({ status: 'done', message: 'ok' }) });
  fake.close(0);
  await resultPromise;

  assert.deepEqual(capturedArgs.slice(0, 3), ['-p', '--resume', 'session-42']);
});

test('a resumed turn still spawns the given non-default bin/env, in the same call as --resume', async () => {
  // Regression coverage: a resumed session must run against the same configured executor
  // (bin/account), not silently fall back to the default binary once a session is resumed.
  let capturedCommand = '';
  let capturedEnv: NodeJS.ProcessEnv = {};
  let capturedArgs: string[] = [];
  const fake = fakeChildProcess();
  const spawnFn: SpawnFn = (command, args, options) => {
    capturedCommand = command;
    capturedEnv = options.env;
    capturedArgs = args;
    return fake.child;
  };

  const resultPromise = runClaudeTurn({
    cwd: '/tmp/some-project',
    prompt: 'Continue where we left off',
    permissionMode: 'bypassPermissions',
    resumeSessionId: 'session-alt-42',
    bin: '/Users/someone/.local/bin/claude-alt',
    env: { CLAUDE_CONFIG_DIR: '/Users/someone/.claude-alt-account' },
    spawnFn,
  });

  fake.emitLine({ type: 'result', session_id: 'session-alt-42', result: JSON.stringify({ status: 'done', message: 'ok' }) });
  fake.close(0);
  await resultPromise;

  assert.equal(capturedCommand, '/Users/someone/.local/bin/claude-alt');
  assert.equal(capturedEnv.CLAUDE_CONFIG_DIR, '/Users/someone/.claude-alt-account');
  assert.deepEqual(capturedArgs.slice(0, 3), ['-p', '--resume', 'session-alt-42']);
});

test('parses a "done" result and calls onEvent for every stream-json line', async () => {
  const fake = fakeChildProcess();
  const events: unknown[] = [];
  const resultPromise = runClaudeTurn({
    cwd: '/tmp',
    prompt: 'go',
    permissionMode: 'bypassPermissions',
    spawnFn: () => fake.child,
    onEvent: (e) => events.push(e),
  });

  fake.emitLine({ type: 'system', subtype: 'init' });
  fake.emitLine({ type: 'assistant', text: 'working...' });
  fake.emitLine({ type: 'result', session_id: 'abc', result: JSON.stringify({ status: 'done', message: 'All done' }) });
  fake.close(0);

  const result = await resultPromise;
  assert.equal(result.status, 'done');
  assert.equal(result.message, 'All done');
  assert.equal(result.sessionId, 'abc');
  assert.equal(events.length, 3);
});

test('parses a "blocked" result, surfacing the question as the message', async () => {
  const fake = fakeChildProcess();
  const resultPromise = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn: () => fake.child });

  fake.emitLine({ type: 'result', session_id: 'abc', result: JSON.stringify({ status: 'blocked', message: 'Python or Node?' }) });
  fake.close(0);

  const result = await resultPromise;
  assert.equal(result.status, 'blocked');
  assert.equal(result.message, 'Python or Node?');
});

test('treats is_error results as "error", regardless of the schema contract', async () => {
  const fake = fakeChildProcess();
  const resultPromise = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn: () => fake.child });

  fake.emitLine({ type: 'result', session_id: 'abc', is_error: true, result: 'permission denied' });
  fake.close(1);

  const result = await resultPromise;
  assert.equal(result.status, 'error');
  assert.equal(result.message, 'permission denied');
});

test('fails open as "done" when the final message does not honor --json-schema', async () => {
  const fake = fakeChildProcess();
  const resultPromise = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn: () => fake.child });

  fake.emitLine({ type: 'result', session_id: 'abc', result: 'plain free-text answer, not JSON' });
  fake.close(0);

  const result = await resultPromise;
  assert.equal(result.status, 'done');
  assert.equal(result.message, 'plain free-text answer, not JSON');
});

test('rejects when the process exits with no result event at all', async () => {
  const fake = fakeChildProcess();
  const resultPromise = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn: () => fake.child });

  fake.emitStderr('something went wrong');
  fake.close(1);

  await assert.rejects(() => resultPromise, /exited \(code 1\)/);
});

test('rejects when the child process itself errors (e.g. claude binary not found)', async () => {
  const fake = fakeChildProcess();
  const resultPromise = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn: () => fake.child });

  fake.fail(new Error('spawn claude ENOENT'));

  await assert.rejects(() => resultPromise, /ENOENT/);
});

test('lines that are not valid JSON are ignored rather than crashing the turn', async () => {
  const fake = fakeChildProcess();
  const resultPromise = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn: () => fake.child });

  fake.emitRawLine('not json at all');
  fake.emitLine({ type: 'result', session_id: 'abc', result: JSON.stringify({ status: 'done', message: 'fine' }) });
  fake.close(0);

  const result = await resultPromise;
  assert.equal(result.status, 'done');
});

test('reports the immediate spawn failure when spawnFn throws synchronously', async () => {
  const spawnFn: SpawnFn = () => {
    throw new Error('EACCES');
  };
  await assert.rejects(
    () => runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', spawnFn }),
    /EACCES/,
  );
});

test('registers every session MCP server through the shared builder, before --json-schema, and none when none are given', async () => {
  const servers = [stepTaskMcpServer('t1'), testTaskMcpServer('t1')];
  const run = async (mcpServers?: McpServerLaunch[]) => {
    let capturedArgs: string[] = [];
    const fake = fakeChildProcess();
    const resultPromise = runClaudeTurn({ cwd: '/tmp', prompt: 'go', permissionMode: 'bypassPermissions', mcpServers, spawnFn: (_command, args) => { capturedArgs = args; return fake.child; } });
    fake.emitLine({ type: 'result', session_id: 's1', result: JSON.stringify({ status: 'done', message: 'ok' }) });
    fake.close(0);
    await resultPromise;
    return capturedArgs;
  };

  const args = await run(servers);
  const start = args.indexOf('--mcp-config');
  assert.deepEqual(args.slice(start, start + 4), claudeMcpArgs(servers), 'the same MCP slice an interactive session gets');
  assert.equal(args[start + 4], '--json-schema');
  assert.match(args[start + 3]!, /mcp__agent_visual_os_tests__run_test_action/);

  for (const none of [undefined, []]) {
    const bare = await run(none);
    assert.equal(bare.includes('--mcp-config'), false);
    assert.equal(bare.includes('--allowed-tools'), false);
  }
});
