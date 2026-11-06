import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { daemonTurns } from '../seo/keywordAgent.ts';
import type { AgentTurnDeps } from '../seo/keywordAgent.ts';
import { NO_AGENT_REASON } from './retroAgent.ts';

/** The one-shot agent behind the Insights document. It reads the data file and answers with text that `parseInsightsAnswer` checks. Tests inject a fake. */
export interface InsightsAgent {
  run(input: { buildingId: string; dataFile: string; instructions: string; signal: AbortSignal }): Promise<string>;
}

export const INSIGHTS_DATA_FILE = 'insights-input.json';

const SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['blocked', 'done'] }, message: { type: 'string' }, text: { type: 'string' } },
  required: ['status', 'message', 'text'],
} as const;
/** Everything except Read, so the agent can open its data file and change nothing. */
const DISALLOWED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'];

/** The daemon's default agent with read-only access, run in a throwaway folder (never the Building's). */
export function createInsightsAgent(deps: AgentTurnDeps = daemonTurns): InsightsAgent {
  return {
    async run({ buildingId, dataFile, instructions, signal }) {
      const executor = await deps.selectExecutor();
      if (!executor) throw new Error(NO_AGENT_REASON);
      const scratch = await mkdtemp(path.join(tmpdir(), 'agent-visual-os-insights-'));
      try {
        const result = await deps.runTurn(executor, {
          cwd: scratch, prompt: `Read the data file ${dataFile} and write the Insights document as the instructions say.`, appendSystemPrompt: instructions,
          jsonSchema: SCHEMA, disallowedTools: DISALLOWED_TOOLS,
          onProcess: (child) => { if (signal.aborted) child.kill(); else signal.addEventListener('abort', () => child.kill(), { once: true }); },
        }, { purpose: 'Content Studio insights', projectId: buildingId });
        const text = result.extra?.text;
        if (result.status !== 'done' || typeof text !== 'string') throw new Error(`The agent did not answer: ${result.message}`);
        return text;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}
