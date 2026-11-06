import { SeoUpstreamError } from './errors.ts';

export interface ClusterAgentInput {
  buildingId: string;
  /** Names the agent may reuse, including clusters the person made. */
  clusters: string[];
  keywords: Array<{ keyword: string; cluster: string | null; pinned: boolean; impressions: number }>;
}

export interface ResearchAgentInput {
  buildingId: string;
  siteUrl: string;
  topQueries: Array<{ keyword: string; impressions: number; position: number | null }>;
  pages: string[];
  competitors: string[];
  /** Keywords the agent must not propose again. */
  known: string[];
}

export interface ReportAgentInput {
  buildingId: string;
  /** The site's host, nothing else that identifies the Building's accounts. */
  site: string;
  period: string;
  /** What the report says: one line per metric, and the biggest movers. */
  scorecard: string[];
  movers: string[];
  notes: string[];
}

/**
 * The language model behind clustering, research and report summaries. It only reads what it is given and answers with JSON; the daemon
 * checks and applies the answer. Tests inject a scripted one.
 */
export interface KeywordAgent {
  /** Answers `{ clusters: [{ name, keywords: [text] }] }`. */
  cluster(input: ClusterAgentInput, signal: AbortSignal): Promise<unknown>;
  /** Answers `{ keywords: [{ keyword, reason }] }`. */
  research(input: ResearchAgentInput, signal: AbortSignal): Promise<unknown>;
  /** Answers `{ paragraph, actions: [text] }`. */
  summarise(input: ReportAgentInput, signal: AbortSignal): Promise<unknown>;
}

const CLUSTER_INSTRUCTIONS = `You group search keywords for one website into named topic clusters. You are given JSON: existing cluster names and a list of keywords, each with its current cluster (or null), whether the person pinned it (pinned keywords must not move, but you may still list them in the cluster you think fits so the person can review it), and its impressions. Put every keyword in exactly one cluster, reuse an existing cluster name when the keyword fits it, and otherwise invent a short descriptive name. Use the keyword text exactly as given. Do not use any tools. Respond only with your final JSON per the given schema: "status" (always "done"), "message" (one short line) and "clusters".`;

const RESEARCH_INSTRUCTIONS = `You suggest new search keywords for one website. You are given JSON: the site address, the queries it already gets impressions for, its pages, competitor domains the person named, and keywords already known (never suggest those). Suggest keywords people could search for that the site could rank for, with a one-sentence reason each. Do not use any tools and do not browse. Respond only with your final JSON per the given schema: "status" (always "done"), "message" (one short line) and "keywords".`;

const REPORT_INSTRUCTIONS = `You write the summary of one website's SEO progress report. You are given JSON: the site, the period compared, one line per metric with its change, the biggest movers and notes about the data. Write one short plain-language paragraph (at most 120 words) saying what changed and why it may matter, then up to five suggested next actions, each one sentence. Use only the numbers given, never invent figures, and say so when data is missing. Do not use any tools. Respond only with your final JSON per the given schema: "status" (always "done"), "message" (one short line), "paragraph" and "actions".`;

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['blocked', 'done'] }, message: { type: 'string' },
    paragraph: { type: 'string' }, actions: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'message', 'paragraph', 'actions'],
} as const;

const CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['blocked', 'done'] }, message: { type: 'string' },
    clusters: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } } }, required: ['name', 'keywords'] } },
  },
  required: ['status', 'message', 'clusters'],
} as const;

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['blocked', 'done'] }, message: { type: 'string' },
    keywords: { type: 'array', items: { type: 'object', properties: { keyword: { type: 'string' }, reason: { type: 'string' } }, required: ['keyword', 'reason'] } },
  },
  required: ['status', 'message', 'keywords'],
} as const;

const DISALLOWED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'];

/** What `turn` needs from the outside: which executor to use and how to run one turn on it. Tests pass fakes. */
export interface AgentTurnDeps {
  /** The configured claude/codex executor with the most rate limit left, or null when none is usable. */
  selectExecutor(): Promise<unknown | null>;
  runTurn(executor: unknown, options: { cwd: string; prompt: string; appendSystemPrompt: string; jsonSchema: object; disallowedTools: string[]; onProcess: (child: { kill(): unknown }) => void }, context: { purpose: string; projectId: string }): Promise<{ status: string; message: string; extra?: Record<string, unknown> }>;
}

/** The daemon's own executors, loaded on first use so importing this module stays cheap. */
export const daemonTurns: AgentTurnDeps = {
  async selectExecutor() {
    const { selectLeastUsedExecutor } = await import('../executors/leastUsedExecutor.ts');
    return selectLeastUsedExecutor();
  },
  async runTurn(executor, options, context) {
    const [{ runClaudeTurn }, { runCodexTurn }, { isCodex }, { trackBackgroundTurn }] = await Promise.all([
      import('../worker/claudeProcess.ts'), import('../worker/codexProcess.ts'), import('../executors/leastUsedExecutor.ts'), import('../analytics/index.ts'),
    ]);
    const profile = executor as Parameters<typeof isCodex>[0];
    const run = isCodex(profile) ? runCodexTurn : runClaudeTurn;
    return trackBackgroundTurn(profile, context, () => run({ ...options, bin: profile.bin, env: profile.env, permissionMode: 'default', onProcess: (child) => options.onProcess(child) }));
  },
};

/** One throwaway, tool-less turn: a scratch folder, the input as JSON, the answer as JSON. Stopping kills the process; the folder is always removed. */
async function turn(deps: AgentTurnDeps, buildingId: string, purpose: string, instructions: string, schema: object, input: object, signal: AbortSignal): Promise<unknown> {
  const [{ mkdtemp, rm }, { tmpdir }, path] = await Promise.all([import('node:fs/promises'), import('node:os'), import('node:path')]);
  const executor = await deps.selectExecutor();
  if (!executor) throw new SeoUpstreamError('No agent is available: every configured agent has used up its limit, or none is set up');
  const scratch = await mkdtemp(path.join(tmpdir(), 'agent-visual-os-keywords-'));
  try {
    const result = await deps.runTurn(executor, {
      cwd: scratch, prompt: JSON.stringify(input), appendSystemPrompt: instructions, jsonSchema: schema, disallowedTools: DISALLOWED_TOOLS,
      onProcess: (child) => { if (signal.aborted) child.kill(); else signal.addEventListener('abort', () => child.kill(), { once: true }); },
    }, { purpose, projectId: buildingId });
    if (signal.aborted) throw new SeoUpstreamError('The agent run was stopped');
    if (result.status !== 'done' || !result.extra) throw new SeoUpstreamError(`The agent did not answer: ${result.message.slice(0, 200)}`);
    return result.extra;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createKeywordAgent(deps: AgentTurnDeps = daemonTurns): KeywordAgent {
  return {
    cluster: (input, signal) => turn(deps, input.buildingId, 'SEO keyword clustering', CLUSTER_INSTRUCTIONS, CLUSTER_SCHEMA, input, signal),
    research: (input, signal) => turn(deps, input.buildingId, 'SEO keyword research', RESEARCH_INSTRUCTIONS, RESEARCH_SCHEMA, input, signal),
    summarise: (input, signal) => turn(deps, input.buildingId, 'SEO report summary', REPORT_INSTRUCTIONS, REPORT_SCHEMA, input, signal),
  };
}

export const defaultKeywordAgent: KeywordAgent = createKeywordAgent();
