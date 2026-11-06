import { randomBytes, timingSafeEqual } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../projects/git.ts';

type JsonObject = Record<string, unknown>;

const REPORTER_PATH = fileURLToPath(new URL('../../bin/report-cli-hook.mjs', import.meta.url));
const REPORTER_MARKER = 'report-cli-hook.mjs';
export const CLI_HOOK_TOKEN = randomBytes(32).toString('hex');

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'] as const;
const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Interrupt', 'Stop', 'SessionEnd'] as const;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonObject(file: string): Promise<JsonObject> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (!isObject(parsed)) throw new Error('expected a JSON object');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot install Agent Visual OS CLI hooks because ${file} is not valid JSON: ${(error as Error).message}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function containsReporter(value: unknown): boolean {
  if (!isObject(value)) return false;
  const handlers = Array.isArray(value.hooks) ? value.hooks : [];
  return handlers.some((handler) => isObject(handler)
    && (String(handler.command ?? '').includes(REPORTER_MARKER)
      || (Array.isArray(handler.args) && handler.args.some((arg) => String(arg).includes(REPORTER_MARKER)))));
}

function mergeHook(config: JsonObject, event: string, handler: JsonObject): void {
  const hooks = isObject(config.hooks) ? config.hooks : {};
  config.hooks = hooks;
  const existing = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
  hooks[event] = [...existing.filter((entry) => !containsReporter(entry)), { hooks: [handler] }];
}

async function writeJson(file: string, value: JsonObject): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function ensureGitExcluded(projectRoot: string): Promise<void> {
  try {
    const gitPath = await git(projectRoot, ['rev-parse', '--git-path', 'info/exclude']);
    const excludePath = path.isAbsolute(gitPath) ? gitPath : path.resolve(projectRoot, gitPath);
    let current = '';
    try { current = await readFile(excludePath, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const missing = ['.claude/settings.local.json', '.codex/hooks.json'].filter((entry) => !current.split(/\r?\n/).includes(entry));
    if (!missing.length) return;
    await mkdir(path.dirname(excludePath), { recursive: true });
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    await writeFile(excludePath, `${current}${prefix}# Agent Visual OS local CLI integration\n${missing.join('\n')}\n`, 'utf8');
  } catch {
    // Non-git projects already live under Agent Visual OS's ignored projects/ directory.
  }
}

/** Installs additive, local-only lifecycle reporting without replacing a project's own hooks. */
export async function ensureProjectCliHooks(projectRoot: string): Promise<void> {
  await access(projectRoot, constants.R_OK | constants.W_OK);

  const claudePath = path.join(projectRoot, '.claude', 'settings.local.json');
  const claude = await readJsonObject(claudePath);
  const claudeHandler = {
    type: 'command',
    command: process.execPath,
    args: [REPORTER_PATH],
    timeout: 3,
  };
  for (const event of CLAUDE_EVENTS) mergeHook(claude, event, claudeHandler);
  await writeJson(claudePath, claude);

  const codexPath = path.join(projectRoot, '.codex', 'hooks.json');
  const codex = await readJsonObject(codexPath);
  if (typeof codex.description !== 'string') codex.description = 'Local Agent Visual OS terminal-status integration.';
  const codexHandler = {
    type: 'command',
    command: `${shellQuote(process.execPath)} ${shellQuote(REPORTER_PATH)}`,
    timeout: 3,
  };
  for (const event of CODEX_EVENTS) mergeHook(codex, event, codexHandler);
  await writeJson(codexPath, codex);

  await ensureGitExcluded(projectRoot);
}

export function validCliHookToken(value: string | undefined): boolean {
  if (!value) return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(CLI_HOOK_TOKEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const cliHookReporterPath = REPORTER_PATH;
