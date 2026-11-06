import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { daemonTurns } from '../seo/keywordAgent.ts';
import type { AgentTurnDeps } from '../seo/keywordAgent.ts';

/** The language model behind the writing-style retro: one tool-less turn whose answer text is checked by `parseRetroAnswer`. Tests inject a fake. */
export interface RetroAgent {
  run(input: { buildingId: string; prompt: string; instructions: string }): Promise<string>;
}

export const NO_AGENT_REASON = 'No agent is available: every configured agent has used up its limit, or none is set up';

const SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['blocked', 'done'] }, message: { type: 'string' }, text: { type: 'string' } },
  required: ['status', 'message', 'text'],
} as const;
const DISALLOWED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'];

/** The daemon's default agent, run in a throwaway folder (never the Building's) with every tool disallowed. */
export function createRetroAgent(deps: AgentTurnDeps = daemonTurns): RetroAgent {
  return {
    async run({ buildingId, prompt, instructions }) {
      const executor = await deps.selectExecutor();
      if (!executor) throw new Error(NO_AGENT_REASON);
      const scratch = await mkdtemp(path.join(tmpdir(), 'agent-visual-os-retro-'));
      try {
        const result = await deps.runTurn(executor, {
          cwd: scratch, prompt, appendSystemPrompt: instructions, jsonSchema: SCHEMA, disallowedTools: DISALLOWED_TOOLS, onProcess: () => undefined,
        }, { purpose: 'Content Studio writing-style retro', projectId: buildingId });
        const text = result.extra?.text;
        if (result.status !== 'done' || typeof text !== 'string') throw new Error(`The agent did not answer: ${result.message}`);
        return text;
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
