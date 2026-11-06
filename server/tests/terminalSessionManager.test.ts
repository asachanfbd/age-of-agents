import assert from 'node:assert/strict';
import { chmodSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeReadOnlyDirArgs, HOOK_ENV_KEYS, interactiveCliArgs } from '../src/terminal/terminalSessionManager.ts';
import { claudeMcpArgs, codexMcpArgs } from '../src/terminal/mcpServers.ts';
import { stepTaskMcpServer } from '../src/terminal/stepTaskTool.ts';
import { testTaskMcpServer } from '../src/terminal/testTaskTool.ts';
import { cliSessionExists, codexSessionIdFromNewFile, nodePtySpawnHelperPath, TerminalSessionManager } from '../src/terminal/terminalSessionManager.ts';

test('Claude CLI launches interactively with the initial prompt and no print mode', () => {
  const args = interactiveCliArgs({ kind: 'claude-cli', prompt: 'Build it', systemPrompt: 'Be careful', autonomy: 'approval' });
  assert.deepEqual(args, ['--append-system-prompt', 'Be careful', 'Build it']);
  assert.equal(args.includes('-p'), false);
});

test('Claude CLI auto mode explicitly bypasses permission prompts', () => {
  const args = interactiveCliArgs({ kind: 'claude-cli', prompt: 'Build it', systemPrompt: '', autonomy: 'auto' });
  assert.deepEqual(args, ['--dangerously-skip-permissions', 'Build it']);
});

test('Claude CLI can start and resume an explicitly identified persisted session', () => {
  const initial = interactiveCliArgs({
    kind: 'claude-cli', prompt: 'Build it', systemPrompt: '', autonomy: 'approval', sessionId: '11111111-1111-4111-8111-111111111111', resume: false,
  });
  assert.deepEqual(initial, ['--session-id', '11111111-1111-4111-8111-111111111111', 'Build it']);

  const resumed = interactiveCliArgs({
    kind: 'claude-cli', prompt: 'Now add tests', systemPrompt: '', autonomy: 'approval', sessionId: '11111111-1111-4111-8111-111111111111', resume: true,
  });
  assert.deepEqual(resumed, ['--resume', '11111111-1111-4111-8111-111111111111', 'Now add tests']);
});

test('Claude CLI can resume into its interactive prompt without injecting a message', () => {
  const args = interactiveCliArgs({
    kind: 'claude-cli', prompt: '', systemPrompt: '', autonomy: 'approval', sessionId: '11111111-1111-4111-8111-111111111111', resume: true,
  });
  assert.deepEqual(args, ['--resume', '11111111-1111-4111-8111-111111111111']);
});

test('Claude CLI denies tools outright ahead of every other flag so the prompt is never read as a tool name', () => {
  const args = interactiveCliArgs({
    kind: 'claude-cli', prompt: 'Plan it', systemPrompt: 'Be careful', autonomy: 'auto', disallowedTools: ['Bash', 'BashOutput'], sessionId: 'abc', resume: false,
  });
  assert.deepEqual(args, ['--disallowed-tools', 'Bash,BashOutput', '--dangerously-skip-permissions', '--append-system-prompt', 'Be careful', '--session-id', 'abc', 'Plan it']);
});

test('several session MCP servers share one registration: the same slice the structured runners build', () => {
  const servers = [stepTaskMcpServer('t1'), testTaskMcpServer('t1')];
  const claude = interactiveCliArgs({ kind: 'claude-cli', prompt: 'Build it', systemPrompt: '', autonomy: 'auto', mcpServers: servers, sessionId: 'abc' });
  assert.deepEqual(claude, [...claudeMcpArgs(servers), '--dangerously-skip-permissions', '--session-id', 'abc', 'Build it'], 'variadic MCP flags still end before --session-id and the prompt');

  const expected = codexMcpArgs(servers);
  const fresh = interactiveCliArgs({ kind: 'codex-cli', prompt: 'Build it', systemPrompt: '', autonomy: 'auto', mcpServers: servers });
  assert.deepEqual(fresh, ['--dangerously-bypass-approvals-and-sandbox', ...expected, 'Build it']);
  const resumed = interactiveCliArgs({ kind: 'codex-cli', prompt: '', systemPrompt: '', autonomy: 'auto', mcpServers: servers, sessionId: 's1', resume: true });
  assert.deepEqual(resumed, ['resume', '--dangerously-bypass-approvals-and-sandbox', ...expected, '-c', 'tui.resume_cwd="current"', 's1']);
});

const MCP_SERVER = { name: 'avos', command: '/bin/node', args: ['/srv/mcp.mjs'], env: { TOKEN: 'secret' }, tools: ['create_task'] };

test('Claude CLI registers a session MCP server and pre-approves its tools ahead of the prompt', () => {
  const args = interactiveCliArgs({
    kind: 'claude-cli', prompt: 'Plan it', systemPrompt: '', autonomy: 'approval', disallowedTools: ['Bash'], mcpServers: [MCP_SERVER], sessionId: 'abc', resume: false,
  });
  const config = { mcpServers: { avos: { type: 'stdio', command: '/bin/node', args: ['/srv/mcp.mjs'], env: { TOKEN: 'secret' } } } };
  assert.deepEqual(args, ['--disallowed-tools', 'Bash', '--mcp-config', JSON.stringify(config), '--allowed-tools', 'mcp__avos__create_task', '--session-id', 'abc', 'Plan it']);
});

test('Claude CLI skips --allowed-tools for an MCP server with nothing to pre-approve', () => {
  const args = interactiveCliArgs({ kind: 'claude-cli', prompt: 'Plan it', systemPrompt: '', autonomy: 'approval', mcpServers: [{ ...MCP_SERVER, tools: [] }], sessionId: 'abc' });
  assert.equal(args.includes('--allowed-tools'), false);
  assert.equal(args[0], '--mcp-config');
});

test('Codex CLI registers a session MCP server through TOML config overrides, on resume too', () => {
  const overrides = ['-c', 'mcp_servers.avos.command="/bin/node"', '-c', 'mcp_servers.avos.args=["/srv/mcp.mjs"]', '-c', 'mcp_servers.avos.env={ TOKEN = "secret" }', '-c', 'mcp_servers.avos.tools.create_task.approval_mode="approve"'];
  const fresh = interactiveCliArgs({ kind: 'codex-cli', prompt: 'Plan it', systemPrompt: '', autonomy: 'auto', mcpServers: [MCP_SERVER] });
  assert.deepEqual(fresh, ['--dangerously-bypass-approvals-and-sandbox', ...overrides, 'Plan it']);

  const resumed = interactiveCliArgs({ kind: 'codex-cli', prompt: '', systemPrompt: '', autonomy: 'auto', mcpServers: [MCP_SERVER], sessionId: 's1', resume: true });
  assert.deepEqual(resumed, ['resume', '--dangerously-bypass-approvals-and-sandbox', ...overrides, '-c', 'tui.resume_cwd="current"', 's1']);
});

test('a read-only Codex CLI session pre-approves its MCP tools, since approval policy "never" would refuse them', () => {
  const args = interactiveCliArgs({ kind: 'codex-cli', prompt: 'Plan it', systemPrompt: '', autonomy: 'approval', readOnly: true, mcpServers: [{ ...MCP_SERVER, tools: ['create_task', 'list_tasks'] }] });
  assert.ok(args.includes('mcp_servers.avos.tools.create_task.approval_mode="approve"'));
  assert.ok(args.includes('mcp_servers.avos.tools.list_tasks.approval_mode="approve"'));
  assert.deepEqual(args.slice(0, 4), ['--sandbox', 'read-only', '--ask-for-approval', 'never']);
});

test('Codex CLI skips tool approvals for an MCP server with nothing to pre-approve', () => {
  const args = interactiveCliArgs({ kind: 'codex-cli', prompt: 'Plan it', systemPrompt: '', autonomy: 'auto', mcpServers: [{ ...MCP_SERVER, tools: [] }] });
  assert.equal(args.some((arg) => arg.includes('approval_mode')), false);
});

test('Codex CLI has no per-tool deny flag, so disallowed tools leave its arguments unchanged', () => {
  const args = interactiveCliArgs({ kind: 'codex-cli', prompt: 'Plan it', systemPrompt: '', autonomy: 'auto', disallowedTools: ['Bash'] });
  assert.deepEqual(args, ['--dangerously-bypass-approvals-and-sandbox', 'Plan it']);
});

test('a read-only Codex CLI session runs in the read-only sandbox with no escalation, whatever its autonomy', () => {
  for (const autonomy of ['auto', 'approval'] as const) {
    const fresh = interactiveCliArgs({ kind: 'codex-cli', prompt: 'Plan it', systemPrompt: '', autonomy, readOnly: true });
    assert.deepEqual(fresh, ['--sandbox', 'read-only', '--ask-for-approval', 'never', 'Plan it']);
    const resumed = interactiveCliArgs({ kind: 'codex-cli', prompt: '', systemPrompt: '', autonomy, readOnly: true, sessionId: 's1', resume: true });
    assert.deepEqual(resumed, ['resume', '--sandbox', 'read-only', '--ask-for-approval', 'never', '-c', 'tui.resume_cwd="current"', 's1']);
  }
});

test('Codex CLI approval mode keeps the interactive TUI and relays approvals', () => {
  const args = interactiveCliArgs({ kind: 'codex-cli', prompt: 'Build it', systemPrompt: 'Be careful', autonomy: 'approval' });
  assert.deepEqual(args, ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '-c', 'developer_instructions="Be careful"', 'Build it']);
  assert.equal(args.includes('exec'), false);
});

test('Codex CLI auto mode uses its explicit unattended interactive flag', () => {
  const args = interactiveCliArgs({ kind: 'codex-cli', prompt: 'Build it', systemPrompt: '', autonomy: 'auto' });
  assert.deepEqual(args, ['--dangerously-bypass-approvals-and-sandbox', 'Build it']);
});

test('Codex CLI resumes an exact session in the new task workspace', () => {
  const args = interactiveCliArgs({
    kind: 'codex-cli', prompt: 'Now add tests', systemPrompt: '', autonomy: 'approval', sessionId: 'codex-session-1', resume: true,
  });
  assert.deepEqual(args, [
    'resume', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request',
    '-c', 'tui.resume_cwd="current"', 'codex-session-1', 'Now add tests',
  ]);
});

test('Codex CLI can resume into its interactive prompt without injecting a message', () => {
  const args = interactiveCliArgs({
    kind: 'codex-cli', prompt: '', systemPrompt: '', autonomy: 'approval', sessionId: 'codex-session-1', resume: true,
  });
  assert.deepEqual(args, [
    'resume', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request',
    '-c', 'tui.resume_cwd="current"', 'codex-session-1',
  ]);
});

test('Codex session discovery selects only a newly-created session for the Task workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
  const now = new Date(2026, 8, 21, 12, 0, 0);
  const day = join(root, '2026', '09', '21');
  await mkdir(day, { recursive: true });
  const oldFile = join(day, 'rollout-old.jsonl');
  const otherFile = join(day, 'rollout-other.jsonl');
  const wantedFile = join(day, 'rollout-wanted.jsonl');
  await writeFile(oldFile, `${JSON.stringify({ type: 'session_meta', payload: { id: 'old', cwd: '/project' } })}\n`);
  await writeFile(otherFile, `${JSON.stringify({ type: 'session_meta', payload: { id: 'other', cwd: '/somewhere-else' } })}\n`);
  await writeFile(wantedFile, `${JSON.stringify({ type: 'session_meta', payload: { id: 'wanted', cwd: '/project' } })}\n`);
  try {
    assert.equal(codexSessionIdFromNewFile(root, '/project', new Set([oldFile]), now), 'wanted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Starts a real PTY process and resolves with its output once it exits. */
function runToExit(sessions: TerminalSessionManager, input: { taskId: string; bin: string; reportHooks?: boolean }): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('PTY process did not exit')), 3_000);
    let output = '';
    sessions.start({
      ...input, kind: 'claude-cli', cwd: process.cwd(), env: {}, prompt: '', systemPrompt: '', autonomy: 'approval',
      onExit: () => { clearTimeout(timeout); resolve(output); },
    });
    sessions.attach(input.taskId, (data) => { output += data; });
  });
}

test('a session with hook reporting off never hands the CLI the hook env, even one the daemon itself inherited', async () => {
  const inherited = process.env.AGENT_VISUAL_OS_TASK_ID;
  process.env.AGENT_VISUAL_OS_TASK_ID = 'inherited-task';
  try {
    const sessions = new TerminalSessionManager();
    const quiet = await runToExit(sessions, { taskId: 'quiet', bin: '/usr/bin/env', reportHooks: false });
    for (const key of HOOK_ENV_KEYS) assert.doesNotMatch(quiet, new RegExp(`^${key}=`, 'm'));
    const reporting = await runToExit(sessions, { taskId: 'reporting', bin: '/usr/bin/env' });
    assert.match(reporting, /AGENT_VISUAL_OS_TASK_ID=reporting/);
    assert.match(reporting, /AGENT_VISUAL_OS_HOOK_TOKEN=/);
  } finally {
    if (inherited === undefined) delete process.env.AGENT_VISUAL_OS_TASK_ID;
    else process.env.AGENT_VISUAL_OS_TASK_ID = inherited;
  }
});

test('a session with hook reporting off still inherits non-hook AGENT_VISUAL_OS_ variables, such as the test runner\'s', async () => {
  const inherited = process.env.AGENT_VISUAL_OS_TEST_ARTIFACTS_DIR;
  process.env.AGENT_VISUAL_OS_TEST_ARTIFACTS_DIR = '/tmp/artifacts';
  try {
    const quiet = await runToExit(new TerminalSessionManager(), { taskId: 'quiet-inherit', bin: '/usr/bin/env', reportHooks: false });
    assert.match(quiet, /^AGENT_VISUAL_OS_TEST_ARTIFACTS_DIR=\/tmp\/artifacts/m);
    for (const key of HOOK_ENV_KEYS) assert.doesNotMatch(quiet, new RegExp(`^${key}=`, 'm'));
  } finally {
    if (inherited === undefined) delete process.env.AGENT_VISUAL_OS_TEST_ARTIFACTS_DIR;
    else process.env.AGENT_VISUAL_OS_TEST_ARTIFACTS_DIR = inherited;
  }
});

test('an endWhenDetached session ends itself once no terminal stays attached, and tells an attached terminal it ended', async () => {
  const sessions = new TerminalSessionManager(30);
  const exited = new Promise<void>((resolve) => {
    sessions.start({
      taskId: 'inspect', kind: 'claude-cli', bin: '/bin/cat', cwd: process.cwd(), env: {}, prompt: '', systemPrompt: '',
      autonomy: 'approval', endWhenDetached: true, onExit: () => resolve(),
    });
  });
  let ended = 0;
  const detach = sessions.attach('inspect', () => undefined, () => { ended += 1; })!;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(sessions.has('inspect'), true, 'an attached session stays up past the grace period');
  const second = sessions.attach('inspect', () => undefined)!;
  second();
  assert.equal(sessions.has('inspect'), true, 'detaching one of two terminals keeps it up');
  detach();
  await exited;
  assert.equal(sessions.has('inspect'), false);
  assert.equal(ended, 0, 'a detached listener is not called');

  let endedLate = false;
  sessions.attach('inspect', () => undefined, () => { endedLate = true; });
  assert.equal(endedLate, true, 'attaching to an already-ended session reports it ended at once');
});

test('a session without endWhenDetached outlives its terminals', async () => {
  const sessions = new TerminalSessionManager(10);
  sessions.start({
    taskId: 'owned', kind: 'claude-cli', bin: '/bin/cat', cwd: process.cwd(), env: {}, prompt: '', systemPrompt: '',
    autonomy: 'approval', onExit: () => undefined,
  });
  sessions.attach('owned', () => undefined)!();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sessions.has('owned'), true);
  assert.equal(sessions.stop('owned'), true);
});

test('the installed PTY backend can launch a real process', async () => {
  const helperPath = nodePtySpawnHelperPath();
  const originalMode = helperPath ? statSync(helperPath).mode & 0o777 : null;
  // Recreate the broken npm-install state on macOS so this stays red-capable even after an earlier
  // test/session repaired the real helper in place.
  if (helperPath && originalMode !== null) chmodSync(helperPath, originalMode & ~0o111);
  const sessions = new TerminalSessionManager();
  let output = '';
  const attachment: { detach: (() => void) | null } = { detach: null };
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('PTY process did not exit')), 2_000);
      try {
        sessions.start({
          taskId: 'real-process',
          kind: 'claude-cli',
          bin: '/bin/echo',
          cwd: process.cwd(),
          env: {},
          prompt: 'pty-ok',
          systemPrompt: '',
          autonomy: 'approval',
          onExit: (exitCode) => {
            clearTimeout(timeout);
            assert.equal(sessions.has('real-process'), false);
            if (exitCode !== 0) reject(new Error(`PTY exited with ${exitCode}`));
            else resolve();
          },
        });
        attachment.detach = sessions.attach('real-process', (data) => { output += data; });
        assert.equal(sessions.isAttached('real-process'), true);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  } finally {
    if (helperPath && originalMode !== null) chmodSync(helperPath, originalMode);
  }
  attachment.detach?.();
  assert.equal(sessions.isAttached('real-process'), false);
  assert.match(output, /pty-ok/);
});

test('cliSessionExists finds a Claude session file under any project of the executor\'s config dir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-sessions-'));
  try {
    const env = { CLAUDE_CONFIG_DIR: root };
    assert.equal(cliSessionExists({ kind: 'claude-cli', env, sessionId: 'abc' }), false, 'no projects dir yet');
    await mkdir(join(root, 'projects', '-Users-me-repo'), { recursive: true });
    await writeFile(join(root, 'projects', '-Users-me-repo', 'abc.jsonl'), '{}\n');
    assert.equal(cliSessionExists({ kind: 'claude-cli', env, sessionId: 'abc' }), true);
    assert.equal(cliSessionExists({ kind: 'claude-cli', env, sessionId: 'other' }), false);
    assert.equal(new TerminalSessionManager().sessionExists({ kind: 'claude-cli', env, sessionId: 'abc' }), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cliSessionExists finds a Codex rollout file by its session id suffix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
  try {
    const env = { CODEX_HOME: root };
    assert.equal(cliSessionExists({ kind: 'codex-cli', env, sessionId: 'id-1' }), false, 'no sessions dir yet');
    await mkdir(join(root, 'sessions', '2026', '09', '30'), { recursive: true });
    await writeFile(join(root, 'sessions', '2026', '09', '30', 'rollout-2026-09-30T10-00-00-id-1.jsonl'), '{}\n');
    assert.equal(cliSessionExists({ kind: 'codex-cli', env, sessionId: 'id-1' }), true);
    assert.equal(cliSessionExists({ kind: 'codex-cli', env, sessionId: 'd-1' }), false, 'the id must match whole');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cliSessionExists leaves an unreadable session directory for the CLI to judge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-unreadable-'));
  try {
    await writeFile(join(root, 'projects'), 'not a directory');
    assert.equal(cliSessionExists({ kind: 'claude-cli', env: { CLAUDE_CONFIG_DIR: root }, sessionId: 'abc' }), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- Read access to saved step outputs (task 5.020) ----

const OUTPUTS_DIR = '/srv/data/step-outputs/p1/r1';
const READ_RULE = `Read(/${OUTPUTS_DIR}/**)`;
const EDIT_RULE = `Edit(/${OUTPUTS_DIR}/**)`;

test('claudeReadOnlyDirArgs allows reading and denies editing each folder, as absolute-path rules', () => {
  assert.deepEqual(claudeReadOnlyDirArgs([`${OUTPUTS_DIR}/`]), ['--allowed-tools', READ_RULE, '--disallowed-tools', EDIT_RULE]);
  assert.equal(READ_RULE, 'Read(//srv/data/step-outputs/p1/r1/**)');
  assert.deepEqual(claudeReadOnlyDirArgs([]), []);
});

for (const autonomy of ['approval', 'auto'] as const) {
  test(`Claude ${autonomy}: a code-editing step reads the outputs folder without prompting and can't edit it, and the prompt stays last`, () => {
    const args = interactiveCliArgs({ kind: 'claude-cli', prompt: 'Build it', systemPrompt: '', autonomy, readOnlyDirs: [OUTPUTS_DIR], mcpServers: [MCP_SERVER], sessionId: 'abc' });
    assert.deepEqual(args.slice(0, 4), ['--allowed-tools', READ_RULE, '--disallowed-tools', EDIT_RULE]);
    assert.equal(args.includes('--dangerously-skip-permissions'), autonomy === 'auto', 'deny rules still hold in bypass mode');
    assert.deepEqual(args.slice(-3), ['--session-id', 'abc', 'Build it']);
  });

  test(`Claude ${autonomy}: a read-only step keeps its denied tools and gets the same read grant, on resume too`, () => {
    for (const resume of [false, true]) {
      const args = interactiveCliArgs({
        kind: 'claude-cli', prompt: 'Review it', systemPrompt: '', autonomy, disallowedTools: ['Bash', 'Edit', 'Write'], readOnly: true, readOnlyDirs: [OUTPUTS_DIR], sessionId: 'abc', resume,
      });
      assert.deepEqual(args.slice(0, 6), ['--disallowed-tools', 'Bash,Edit,Write', '--allowed-tools', READ_RULE, '--disallowed-tools', EDIT_RULE]);
      assert.deepEqual(args.slice(-3), [resume ? '--resume' : '--session-id', 'abc', 'Review it']);
    }
  });

  test(`Codex ${autonomy}: the outputs folder is never passed as a writable root — every sandbox already reads the whole disk`, () => {
    for (const readOnly of [false, true]) {
      for (const resume of [false, true]) {
        const withDirs = interactiveCliArgs({ kind: 'codex-cli', prompt: 'Go', systemPrompt: '', autonomy, readOnly, readOnlyDirs: [OUTPUTS_DIR], sessionId: 's1', resume });
        const without = interactiveCliArgs({ kind: 'codex-cli', prompt: 'Go', systemPrompt: '', autonomy, readOnly, sessionId: 's1', resume });
        assert.deepEqual(withDirs, without);
        assert.ok(!withDirs.some((arg) => arg.includes(OUTPUTS_DIR) || arg === '--add-dir' || arg.includes('writable_roots')));
      }
    }
    const readOnlyArgs = interactiveCliArgs({ kind: 'codex-cli', prompt: 'Go', systemPrompt: '', autonomy, readOnly: true, readOnlyDirs: [OUTPUTS_DIR] });
    assert.deepEqual(readOnlyArgs.slice(0, 4), ['--sandbox', 'read-only', '--ask-for-approval', 'never']);
  });
}

test('Claude without readOnlyDirs gets no read grant', () => {
  const args = interactiveCliArgs({ kind: 'claude-cli', prompt: 'Plan it', systemPrompt: '', autonomy: 'approval', sessionId: 'abc' });
  assert.ok(!args.some((arg) => arg.startsWith('Read(') || arg.startsWith('Edit(')));
});

test('Codex runs a read-only step that may run commands in a command-permitting sandbox without escalation', () => {
  for (const autonomy of ['approval', 'auto'] as const) {
    const args = interactiveCliArgs({ kind: 'codex-cli', prompt: 'RCA', systemPrompt: '', autonomy, readOnly: true, canRunCommands: true });
    assert.deepEqual(args, ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '--ask-for-approval', 'never', 'RCA']);
  }
  const readOnly = interactiveCliArgs({ kind: 'codex-cli', prompt: 'x', systemPrompt: '', autonomy: 'auto', readOnly: true });
  assert.deepEqual(readOnly, ['--sandbox', 'read-only', '--ask-for-approval', 'never', 'x']);
});

test('Claude denies only edit tools for a command step, so the shell stays available', () => {
  const args = interactiveCliArgs({ kind: 'claude-cli', prompt: 'RCA', systemPrompt: '', autonomy: 'approval', readOnly: true, canRunCommands: true, disallowedTools: ['Edit', 'Write', 'NotebookEdit'] });
  assert.deepEqual(args, ['--disallowed-tools', 'Edit,Write,NotebookEdit', 'RCA']);
});

// ---- Catalog skill directories: read access for on-demand skills (task 29.002) ----

const SKILL_DIRS = ['/srv/catalog/skills/commit-style/', '/srv/catalog/skills/lint-rules'];

test('Claude: attached skill dirs get a Read allow and an Edit deny each, next to the step-output dir, with or without bypass permissions', () => {
  for (const autonomy of ['approval', 'auto'] as const) {
    const args = interactiveCliArgs({ kind: 'claude-cli', prompt: 'Go', systemPrompt: '', autonomy, readOnlyDirs: [OUTPUTS_DIR, ...SKILL_DIRS], sessionId: 'abc' });
    const allowed = args.slice(args.indexOf('--allowed-tools') + 1, args.indexOf('--disallowed-tools'));
    assert.deepEqual(allowed, [READ_RULE, 'Read(//srv/catalog/skills/commit-style/**)', 'Read(//srv/catalog/skills/lint-rules/**)']);
    assert.ok(args.includes('Edit(//srv/catalog/skills/lint-rules/**)'));
  }
});

test('Claude: a session with no read-only dirs gets no read rules', () => {
  const args = interactiveCliArgs({ kind: 'claude-cli', prompt: 'Go', systemPrompt: 'p', autonomy: 'approval', sessionId: 'abc' });
  assert.ok(!args.includes('--allowed-tools') && !args.includes('--disallowed-tools'));
});

test('Codex: skill dirs need no extra argument; its sandboxes already read absolute paths outside the cwd, and the index prompt travels as developer_instructions', () => {
  const indexPrompt = '## Available skills (read on demand)\n- X (`x`): d\n  SKILL.md: /srv/catalog/skills/x/SKILL.md';
  const base = { kind: 'codex-cli' as const, prompt: 'Go', systemPrompt: indexPrompt, readOnlyDirs: SKILL_DIRS };
  const modes = [
    [{ autonomy: 'approval' as const, readOnly: true }, ['--sandbox', 'read-only', '--ask-for-approval', 'never']],
    [{ autonomy: 'approval' as const, readOnly: true, canRunCommands: true }, ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '--ask-for-approval', 'never']],
    [{ autonomy: 'approval' as const }, ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']],
    [{ autonomy: 'auto' as const }, ['--dangerously-bypass-approvals-and-sandbox']],
  ] as const;
  for (const [extra, sandbox] of modes) {
    const args = interactiveCliArgs({ ...base, ...extra });
    assert.deepEqual(args.slice(0, sandbox.length), [...sandbox]);
    assert.ok(args.includes(`developer_instructions=${JSON.stringify(indexPrompt)}`));
    assert.ok(!args.some((arg) => arg.includes('/srv/catalog/skills/') && !arg.startsWith('developer_instructions=')), 'no per-dir sandbox option');
  }
});
