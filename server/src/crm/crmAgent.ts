import { daemonTurns } from '../seo/keywordAgent.ts';
import type { AgentTurnDeps } from '../seo/keywordAgent.ts';
import type { CrmAgent, DraftRequest } from './context.ts';
import { CrmUpstreamError } from './errors.ts';

const SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['blocked', 'done'] }, message: { type: 'string' }, text: { type: 'string' } },
  required: ['status', 'message', 'text'],
} as const;

const INSTRUCTIONS: Record<DraftRequest['kind'], string> = {
  message: 'You draft one short outreach message for a sales contact. Do not use any tools. Respond only with your final JSON per the given schema: "status" (always "done"), "message" (one short line) and "text" (the message only).',
  work: 'You write a short update for a customer about work done for them. Do not use any tools. Respond only with your final JSON per the given schema: "status" (always "done"), "message" (one short line) and "text" (one or two plain sentences, customer-friendly, no jargon).',
  mapping: 'You read a sample of a pasted contact list and say what each column holds. Do not use any tools. Respond only with your final JSON per the given schema: "status" (always "done"), "message" (one short line) and "text" (only the JSON object the prompt asks for, with no code fence or other words).',
  mom: 'You work on meeting notes for a sales contact. You may use any tool available on this machine, for example to transcribe an audio file or read an attachment. Respond only with your final JSON per the given schema: "status" (always "done"), "message" (one short line) and "text" (the requested text only).',
};
const PURPOSES: Record<DraftRequest['kind'], string> = { message: 'CRM message draft', mom: 'CRM meeting notes', work: 'CRM customer work update', mapping: 'CRM paste column mapping' };
const MESSAGE_DISALLOWED = ['Bash', 'BashOutput', 'KillShell', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'];

/** The daemon's agent for CRM drafts, MOMs and paste column mappings. A drafting, work-update or mapping turn gets no tools; a MOM turn may use any tool on the machine (audio is best effort). */
export function createCrmAgent(buildingId: () => string, cwd: () => Promise<string>, deps: AgentTurnDeps = daemonTurns): CrmAgent {
  return {
    async run({ kind, prompt }) {
      const executor = await deps.selectExecutor();
      if (!executor) throw new CrmUpstreamError('No agent is available: every configured agent has used up its limit, or none is set up');
      const result = await deps.runTurn(executor, {
        cwd: await cwd(), prompt, appendSystemPrompt: INSTRUCTIONS[kind], jsonSchema: SCHEMA, disallowedTools: kind === 'mom' ? [] : MESSAGE_DISALLOWED, onProcess: () => undefined,
      }, { purpose: PURPOSES[kind], projectId: buildingId() });
      const text = result.extra?.text;
      if (result.status !== 'done' || typeof text !== 'string') throw new CrmUpstreamError(`The agent did not answer: ${result.message.slice(0, 200)}`);
      return text;
    },
  };
}

