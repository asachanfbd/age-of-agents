import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { STATUS_SCHEMA, type RunClaudeTurnOptions, type ClaudeTurnResult, type StreamJsonEvent, type SpawnFn } from './claudeProcess.ts';
import type { TokenUsage } from '../domain/types.ts';
import { codexMcpArgs } from '../terminal/mcpServers.ts';

/** Codex requires every object property to be required; optional fields become nullable. */
export function codexSchema(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const schema = value as Record<string, unknown>;
  if (schema.type === 'object') {
    const required = (schema.required ?? []) as string[];
    const properties = Object.fromEntries(Object.entries(schema.properties as object).map(([key, child]) => [
      key, required.includes(key) ? codexSchema(child) : { anyOf: [codexSchema(child), { type: 'null' }] },
    ]));
    return { ...schema, properties, required: Object.keys(properties), additionalProperties: false };
  }
  return schema.items ? { ...schema, items: codexSchema(schema.items) } : schema;
}

export function codexArgs(options: RunClaudeTurnOptions, schemaPath: string): string[] {
  const args = ['exec'];
  if (options.resumeSessionId) args.push('resume');
  args.push('--json', '--skip-git-repo-check', '--output-schema', schemaPath);
  // No interactive approval relay exists in the daemon. Restricted turns deny gated calls.
  args.push('-c', 'approval_policy="never"', '-c', `sandbox_mode="${options.permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'read-only'}"`);
  if (options.disallowedTools?.length) args.push('-c', 'features.shell_tool=false');
  if (options.appendSystemPrompt) args.push('-c', `developer_instructions=${JSON.stringify(options.appendSystemPrompt)}`);
  args.push(...codexMcpArgs(options.mcpServers ?? []));
  args.push('--');
  if (options.resumeSessionId) args.push(options.resumeSessionId);
  args.push(options.prompt);
  return args;
}

export function extractCodexUsage(value: unknown, previous?: TokenUsage): TokenUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  const input = num(usage.input_tokens);
  const cached = Math.min(input, num(usage.cached_input_tokens));
  return { inputTokens: Math.max(0, input - cached - (previous?.inputTokens ?? 0)), outputTokens: Math.max(0, num(usage.output_tokens) - (previous?.outputTokens ?? 0)), cacheReadInputTokens: Math.max(0, cached - (previous?.cacheReadInputTokens ?? 0)), cacheCreationInputTokens: 0, totalCostUsd: 0 };
}

/** Run/resume a persisted Codex session using the same worker outcome contract as Claude. */
export async function runCodexTurn(options: RunClaudeTurnOptions): Promise<ClaudeTurnResult> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-visual-os-codex-'));
  try {
    const schemaPath = join(directory, 'response.json');
    await writeFile(schemaPath, JSON.stringify(codexSchema(options.jsonSchema ?? STATUS_SCHEMA)));
    const spawnFn: SpawnFn = options.spawnFn ?? ((command, args, config) => spawn(command, args, { ...config, stdio: ['ignore', 'pipe', 'pipe'] }));
    return await new Promise((resolve, reject) => {
      const child = spawnFn(options.bin ?? 'codex', codexArgs(options, schemaPath), { cwd: options.cwd, env: { ...process.env, ...options.env } });
      let sessionId = options.resumeSessionId ?? '';
      let text = '';
      let completed: StreamJsonEvent | null = null;
      let failure = '';
      let stderr = '';
      child.on('error', reject);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        let event: StreamJsonEvent;
        try { event = JSON.parse(line); } catch { return; }
        if (!event || typeof event.type !== 'string') return;
        options.onEvent?.(event);
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id;
        const item = event.item as Record<string, unknown> | undefined;
        if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') text = item.text;
        if (event.type === 'turn.completed') completed = event;
        if (event.type === 'turn.failed') failure = String((event.error as { message?: string })?.message ?? 'Codex turn failed');
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
      child.on('close', code => {
        const raw = completed ?? { type: 'turn.failed' };
        const usage = extractCodexUsage(completed?.usage, options.previousSessionUsage);
        if (failure || code !== 0 || !completed) {
          resolve({ sessionId, status: 'error', message: failure || `Codex exited (code ${code}) without completing the turn.${stderr ? ` ${stderr.trim()}` : ''}`, usage, raw });
          return;
        }
        try {
          // Nullable optional fields map back to the existing plan mutation contract.
          const { status, message, ...extra } = JSON.parse(text, (_key, value) => value === null ? undefined : value);
          if ((status !== 'done' && status !== 'blocked') || typeof message !== 'string') throw new Error('Invalid outcome');
          resolve({ sessionId, status, message, extra, usage, raw });
        } catch {
          resolve({ sessionId, status: 'error', message: 'Codex did not return a valid task outcome.', usage, raw });
        }
      });
      options.onProcess?.(child);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
