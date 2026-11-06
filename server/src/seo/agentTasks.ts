import { randomUUID } from 'node:crypto';
import { assertWritable } from '../buildings/normalize.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { latestSnapshot } from './crawl/store.ts';
import { seoDeps } from './deps.ts';
import { SeoConflictError, SeoInputError, SeoNotFoundError } from './errors.ts';
import { selectCandidates } from './keywordClustering.ts';
import { competitorDomains } from './keywordResearch.ts';
import { applyClusterAnswer, storeResearchAnswer } from './keywordRuns.ts';
import { buildModel } from './keywords.ts';
import { windowsOf } from './pages.ts';
import { accepted, applyRowChange, followUpTask, handoffPrompt, parseProposalOutput, proposalCsv, reviewSummary } from './proposalRules.ts';
import type { ProposalRow } from './proposalRules.ts';
import { settingsOf } from './siteAccess.ts';
import { createManualRecord, PROPOSING_SLOTS, readTask, readTasks, saveTask, SLOT_IDS, withTaskLock } from './taskStore.ts';
import type { AgentRecord, AgentSlot, HandoffRecord } from './taskStore.ts';
import { AGENT_SLOTS } from './taskStore.ts';
import { taskPorts, TaskStartError } from './taskPorts.ts';
import { agentStatusView, requireOneOf, requireTitle, snapshotOf, TASK_LIMITS } from './taskRules.ts';
import type { HandoffState, LinkSnapshot, RunSnapshot } from './taskRules.ts';
import { isSiteHost, normalizePageUrl } from './urls.ts';

const SLOT_LABELS: Record<AgentSlot, string> = {
  research: 'Keyword research', clustering: 'Keyword clustering', 'title-meta': 'Title and meta proposals', content: 'Content proposals', audit: 'Site audit',
};

export const slotLabel = (slot: AgentSlot): string => SLOT_LABELS[slot];
const isProposing = (slot: AgentSlot): boolean => PROPOSING_SLOTS.includes(slot);
/** Handoffs this process is carrying out right now; a stored "handing-off" claim not in here was cut off by a restart. */
const inflight = new Set<string>();
const CUT_OFF = 'The daemon stopped while the handoff was being made. Retry it, or use the manual task.';

const ACTIVE_RUN: ReadonlyArray<RunSnapshot['status']> = ['running', 'awaiting-approval'];

// ---- starting -------------------------------------------------------------------------------------------------------

function selectedPages(value: unknown, siteUrl: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new SeoInputError(`pages must be a list of 1 to ${TASK_LIMITS.pagesPerRun} page addresses`);
  if (value.length > TASK_LIMITS.pagesPerRun) throw new SeoInputError(`at most ${TASK_LIMITS.pagesPerRun} pages can be chosen for one run`);
  const urls = new Set<string>();
  for (const item of value) {
    const url = normalizePageUrl(item);
    if (!url) throw new SeoInputError('every page must be a full http or https address');
    if (!isSiteHost(url, siteUrl)) throw new SeoInputError(`${url.slice(0, 200)} is not a page of this site`);
    urls.add(url);
  }
  return [...urls];
}

interface Brief { title: string; description: string; inputs: AgentRecord['inputs']; links: LinkSnapshot[] }

const JSON_BLOCK = (data: unknown): string => `\n\n\`\`\`json\n${JSON.stringify(data, null, 1)}\n\`\`\``;

async function pagesBrief(project: ProjectRecord, slot: 'title-meta' | 'content', body: Record<string, unknown>): Promise<Brief> {
  const pages = selectedPages(body.pages, (await settingsOf(project)).siteUrl);
  const crawl = await latestSnapshot(project.id);
  const known = new Map((crawl?.pages ?? []).map((p) => [p.url, p]));
  const current = Object.fromEntries(pages.map((url) => [url, { title: known.get(url)?.title ?? '', meta: known.get(url)?.description ?? '' }]));
  const what = slot === 'title-meta' ? 'new titles and meta descriptions' : 'content briefs';
  return {
    title: `${slotLabel(slot)} for ${pages.length} page${pages.length === 1 ? '' : 's'}`,
    description: `Propose ${what} for these pages of ${(await settingsOf(project)).siteUrl}. Only these pages may appear in the answer.${JSON_BLOCK({ pages: pages.map((url) => ({ url, currentTitle: current[url]!.title, currentMeta: current[url]!.meta })) })}`,
    inputs: { pages, competitors: [], sentKeys: [], current },
    links: pages.slice(0, 20).map((url) => snapshotOf('page', url)),
  };
}

async function auditBrief(project: ProjectRecord, body: Record<string, unknown>): Promise<Brief> {
  const crawl = await latestSnapshot(project.id);
  if (!crawl) throw new SeoConflictError('Run a crawl in the Internal links tab first: the audit works from crawl data');
  const siteUrl = (await settingsOf(project)).siteUrl;
  const pages = body.pages === undefined
    ? crawl.pages.filter((p) => !p.redirectTo && (p.status !== 200 || !p.title || !p.description || p.noindex || p.orphan)).map((p) => p.url).slice(0, TASK_LIMITS.pagesPerRun)
    : selectedPages(body.pages, siteUrl);
  if (!pages.length) throw new SeoConflictError('The latest crawl found no pages that need attention');
  const byUrl = new Map(crawl.pages.map((p) => [p.url, p]));
  const facts = pages.map((url) => {
    const p = byUrl.get(url);
    return { url, status: p?.status ?? null, title: p?.title ?? null, meta: p?.description ?? null, canonical: p?.canonical ?? null, noindex: p?.noindex ?? false, orphan: p?.orphan ?? false, inbound: p?.inbound ?? 0 };
  });
  return {
    title: `Site audit of ${pages.length} page${pages.length === 1 ? '' : 's'}`,
    description: `Audit these pages of ${siteUrl} from the crawl taken ${crawl.finishedAt}.${JSON_BLOCK({ pages: facts })}`,
    inputs: { pages, competitors: [], sentKeys: [], current: {} },
    links: pages.slice(0, 20).map((url) => snapshotOf('page', url)),
  };
}

async function researchBrief(project: ProjectRecord, body: Record<string, unknown>): Promise<Brief> {
  const competitors = competitorDomains(body.competitors);
  const model = await buildModel(project, (ledgers, now) => ({ windows: windowsOf({}, ledgers, now) }));
  const top = [...model.items].sort((a, b) => b.stat.current.impressions - a.stat.current.impressions || (a.key < b.key ? -1 : 1)).slice(0, 100);
  return {
    title: 'Keyword research',
    description: `Propose new keywords for ${model.ctx.siteUrl}.${JSON_BLOCK({
      siteUrl: model.ctx.siteUrl, competitors, known: model.items.map((i) => i.key).slice(0, 2000),
      topQueries: top.map((i) => ({ keyword: i.keyword, impressions: i.stat.current.impressions })),
    })}`,
    inputs: { pages: [], competitors, sentKeys: [], current: {} },
    links: [],
  };
}

async function clusteringBrief(project: ProjectRecord): Promise<Brief> {
  const model = await buildModel(project, (ledgers, now) => ({ windows: windowsOf({}, ledgers, now) }));
  if (!model.items.length) throw new SeoInputError('There are no keywords to cluster yet');
  const selection = selectCandidates(model.items.map((i) => ({ key: i.key, display: i.keyword, pinned: i.pinned, clusterId: i.clusterId, impressions: i.stat.current.impressions })), seoDeps().limits.clusterCap);
  const names = [...model.stored.clusters.values()].map((c) => c.name);
  return {
    title: `Keyword clustering of ${selection.selected.length} keywords`,
    description: `Group these keywords into topic clusters.${JSON_BLOCK({
      clusters: names,
      keywords: selection.selected.map((c) => ({ keyword: c.display, cluster: c.clusterId ? model.stored.clusters.get(c.clusterId)?.name ?? null : null, pinned: c.pinned, impressions: c.impressions })),
    })}`,
    inputs: { pages: [], competitors: [], sentKeys: selection.selected.map((c) => c.key), current: {} },
    links: [],
  };
}

async function briefFor(project: ProjectRecord, slot: AgentSlot, body: Record<string, unknown>): Promise<Brief> {
  switch (slot) {
    case 'title-meta': case 'content': return pagesBrief(project, slot, body);
    case 'audit': return auditBrief(project, body);
    case 'research': return researchBrief(project, body);
    case 'clustering': return clusteringBrief(project);
  }
}

/** Starts an agent task: a normal workflow run of the slot's workflow, with this Building's name on the global board. */
export async function startAgentTask(project: ProjectRecord, body: unknown): Promise<AgentRecord> {
  assertWritable(project);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new SeoInputError('the request must be a JSON object');
  const input = body as Record<string, unknown>;
  const slot = requireOneOf(input.slot, AGENT_SLOTS, 'slot');
  const brief = await briefFor(project, slot, input);
  const { runs } = taskPorts();
  const now = seoDeps().now().toISOString();
  const record: AgentRecord = {
    id: randomUUID(), source: 'agent', slot, title: brief.title, createdAt: now, updatedAt: now, inputs: brief.inputs, links: brief.links,
    runId: null, planItemId: null, startError: null, proposal: null, proposalError: null, proposalSkipped: 0, ingested: false, resultNote: null, approvedAt: null, handoff: null,
  };
  const launch = async (): Promise<AgentRecord> => {
    if ((slot === 'research' || slot === 'clustering') && await openRunOfSlot(project, slot)) {
      throw new SeoConflictError(`A ${slotLabel(slot).toLowerCase()} run is already in progress`);
    }
    try {
      const started = await runs.start({ project, slotId: SLOT_IDS[slot], title: `${project.name}: ${brief.title}`, description: brief.description });
      record.runId = started.runId;
      record.planItemId = started.planItemId;
    } catch (error) {
      if (!(error instanceof TaskStartError)) throw error;
      record.startError = error.message;
    }
    return (await saveTask(project, record)) as AgentRecord;
  };
  return withTaskLock(project.id, launch);
}

async function openRunOfSlot(project: ProjectRecord, slot: AgentSlot): Promise<boolean> {
  for (const task of await readTasks(project)) {
    if (task.source !== 'agent' || task.slot !== slot || !task.runId) continue;
    const run = await taskPorts().runs.state(task.runId);
    if (run && ACTIVE_RUN.includes(run.status)) return true;
  }
  return false;
}

// ---- reading the run into the task ----------------------------------------------------------------------------------

function jsonOf(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return JSON.parse((fenced?.[1] ?? text).trim());
}

async function readAnswer(runId: string): Promise<unknown> {
  const outputs = await taskPorts().runs.outputs(runId);
  for (const text of outputs) {
    try { return jsonOf(text); } catch { /* try the next output */ }
  }
  throw new SeoInputError("The agent's answer was not usable: it contains no JSON");
}

async function ingest(project: ProjectRecord, record: AgentRecord): Promise<Partial<AgentRecord>> {
  try {
    const answer = await readAnswer(record.runId!);
    if (record.slot === 'research') {
      const { proposed } = await storeResearchAnswer(project, record.runId!, answer);
      return { ingested: true, resultNote: `${proposed} new keyword idea${proposed === 1 ? '' : 's'} waiting in Keywords` };
    }
    const result = await applyClusterAnswer(project, record.runId!, record.inputs.sentKeys, answer);
    return { ingested: true, resultNote: `${result.placed} keyword${result.placed === 1 ? '' : 's'} placed, ${result.suggestions} suggestion${result.suggestions === 1 ? '' : 's'} waiting in Keywords` };
  } catch (error) {
    return { ingested: true, proposalError: (error as Error).message };
  }
}

async function readProposal(project: ProjectRecord, record: AgentRecord): Promise<Partial<AgentRecord>> {
  try {
    const parsed = parseProposalOutput(await taskPorts().runs.outputs(record.runId!), new Set(record.inputs.pages));
    if (!parsed.rows.length) return { proposalError: "The agent's answer had no usable rows" };
    const rows: ProposalRow[] = parsed.rows.map((r) => ({
      id: randomUUID(), url: r.url, currentTitle: record.inputs.current[r.url]?.title ?? '', currentMeta: record.inputs.current[r.url]?.meta ?? '',
      proposedTitle: r.proposedTitle, proposedMeta: r.proposedMeta, notes: r.notes, decision: 'pending', editedTitle: null, editedMeta: null,
    }));
    return { proposal: rows, proposalSkipped: parsed.skipped };
  } catch (error) {
    return { proposalError: (error as Error).message };
  }
}

/** Brings the task up to date with its run: reads the answer once the run has one, and checks a handoff that was still open. */
export async function settleAgent(project: ProjectRecord, id: string): Promise<AgentRecord> {
  const first = await requireAgent(project, id);
  const run = first.runId ? await taskPorts().runs.state(first.runId) : null;
  const wantsAnswer = run !== null && (run.status === 'succeeded' || (run.status === 'awaiting-approval' && isProposing(first.slot)));
  const needsAnswer = wantsAnswer && (isProposing(first.slot) ? first.proposal === null && !first.proposalError : !first.ingested);
  const cutOff = first.handoff?.state === 'handing-off' && !inflight.has(first.id);
  const needsHandoff = cutOff || (first.handoff !== null && (first.handoff.state === 'awaiting-approval' || (first.handoff.state === 'handed-off' && first.handoff.sessionId !== null)));
  if (!needsAnswer && !needsHandoff) return first;
  return withTaskLock(project.id, async () => {
    const record = await requireAgent(project, id);
    let patch: Partial<AgentRecord> = {};
    if (needsAnswer && (isProposing(record.slot) ? record.proposal === null && !record.proposalError : !record.ingested)) {
      patch = isProposing(record.slot) ? await readProposal(project, record) : await ingest(project, record);
    }
    if (record.handoff?.state === 'handing-off' && !inflight.has(id)) patch = { ...patch, handoff: { ...record.handoff, state: 'failed', error: CUT_OFF } };
    else if (record.handoff && needsHandoff) patch = { ...patch, handoff: await refreshedHandoff(project, record, record.handoff) };
    return (Object.keys(patch).length ? await saveTask(project, { ...record, ...patch }) : record) as AgentRecord;
  });
}

async function requireAgent(project: ProjectRecord, id: string): Promise<AgentRecord> {
  const record = await readTask(project, id);
  if (!record || record.source !== 'agent') throw new SeoNotFoundError('There is no such agent task');
  return record;
}

export async function agentRunState(record: AgentRecord): Promise<RunSnapshot | null> {
  return record.runId ? taskPorts().runs.state(record.runId) : null;
}

export function agentStatus(record: AgentRecord, run: RunSnapshot | null) {
  if (record.proposalError && run && run.status !== 'failed' && run.status !== 'stopped' && !record.handoff) {
    return { group: 'failed-blocked' as const, label: 'Answer unusable', note: record.proposalError };
  }
  return agentStatusView({ run, startError: record.startError, approved: record.approvedAt !== null, handoff: record.handoff?.state ?? null });
}

// ---- review ---------------------------------------------------------------------------------------------------------

export async function proposalOf(project: ProjectRecord, id: string) {
  const record = await settleAgent(project, id);
  if (!isProposing(record.slot)) throw new SeoConflictError('This kind of task has no proposal to review');
  const rows = record.proposal ?? [];
  return { rows, summary: reviewSummary(rows), error: record.proposalError, skipped: record.proposalSkipped, approved: record.approvedAt !== null };
}

export async function changeProposalRow(project: ProjectRecord, id: string, rowId: string, change: unknown): Promise<ProposalRow> {
  assertWritable(project);
  return withTaskLock(project.id, async () => {
    const record = await requireAgent(project, id);
    if (!record.proposal) throw new SeoConflictError('This task has no proposal to review yet');
    const run = await agentRunState(record);
    if (record.approvedAt || (run && run.status !== 'awaiting-approval' && run.status !== 'succeeded')) throw new SeoConflictError('This proposal can no longer be changed');
    const index = record.proposal.findIndex((r) => r.id === rowId);
    if (index < 0) throw new SeoNotFoundError('There is no such proposal row');
    const row = applyRowChange(record.proposal[index]!, change);
    const proposal = record.proposal.map((r, i) => (i === index ? row : r));
    await saveTask(project, { ...record, proposal });
    return row;
  });
}

/** Accepts or rejects every row that is still pending; returns how many changed. */
export async function decideAllPending(project: ProjectRecord, id: string, decision: unknown): Promise<number> {
  assertWritable(project);
  if (decision !== 'accepted' && decision !== 'rejected') throw new SeoInputError('decision must be accepted or rejected');
  return withTaskLock(project.id, async () => {
    const record = await requireAgent(project, id);
    if (!record.proposal) throw new SeoConflictError('This task has no proposal to review yet');
    if (record.approvedAt) throw new SeoConflictError('This proposal can no longer be changed');
    const pending = record.proposal.filter((r) => r.decision === 'pending').length;
    await saveTask(project, { ...record, proposal: record.proposal.map((r) => (r.decision === 'pending' ? { ...r, decision } : r)) });
    return pending;
  });
}

export async function proposalCsvOf(project: ProjectRecord, id: string): Promise<{ fileName: string; csv: string }> {
  const record = await requireAgent(project, id);
  if (!record.proposal) throw new SeoConflictError('This task has no proposal yet');
  if (!accepted(record.proposal).length) throw new SeoConflictError('Accept at least one row first');
  return { fileName: `seo-${record.slot}-${record.id.slice(0, 8)}.csv`, csv: proposalCsv(record.proposal) };
}

// ---- handoff --------------------------------------------------------------------------------------------------------

const newHandoff = (path: HandoffRecord['path'], state: HandoffState, now: string, extra: Partial<HandoffRecord> = {}): HandoffRecord => ({
  path, state, targetBuildingId: null, targetName: null, callId: null, sessionId: null, sessionStatus: null, error: null, manualTaskId: null, followUpTaskId: null, at: now, ...extra,
});

const TOO_LONG = `The accepted changes do not fit in one planning session (${TASK_LIMITS.handoffPrompt.toLocaleString('en-US')} characters). Use the manual task with the CSV instead.`;

async function manualFallback(project: ProjectRecord, record: AgentRecord, reason: string | null, locked = false): Promise<HandoffRecord> {
  const rows = record.proposal ?? [];
  const csv = proposalCsv(rows);
  const count = accepted(rows).length;
  const created = await createManualRecord(project, {
    title: `Apply: ${record.title}`.slice(0, TASK_LIMITS.title), kind: 'content', status: 'todo',
    notes: `${count} approved change${count === 1 ? '' : 's'} to apply on the website. The CSV is attached to this task.\n\n${handoffPrompt(record.title, rows, Number.MAX_SAFE_INTEGER)}`.slice(0, TASK_LIMITS.notes),
  }, { createdBy: 'agent', fromAgentTaskId: record.id, csv, locked });
  return newHandoff('manual', 'handed-off', seoDeps().now().toISOString(), { manualTaskId: created.id, error: reason });
}

async function softwareHandoff(project: ProjectRecord, record: AgentRecord, target: { id: string; name: string }): Promise<HandoffRecord> {
  const now = seoDeps().now().toISOString();
  const base = { targetBuildingId: target.id, targetName: target.name };
  const prompt = handoffPrompt(record.title, record.proposal ?? []);
  if (prompt === null) return newHandoff('software', 'failed', now, { ...base, error: TOO_LONG });
  try {
    const call = await taskPorts().handoff.startPlanning({ buildingId: project.id, target, prompt });
    if (call.state === 'awaiting-approval') return newHandoff('software', 'awaiting-approval', now, { ...base, callId: call.callId });
    const followUp = await followUpTaskFor(project, record);
    return newHandoff('software', 'handed-off', now, { ...base, sessionId: call.sessionId, followUpTaskId: followUp });
  } catch (error) {
    return newHandoff('software', 'failed', now, { ...base, error: (error as Error).message });
  }
}

async function followUpTaskFor(project: ProjectRecord, record: AgentRecord, locked = false): Promise<string> {
  const { title, notes } = followUpTask(record.title, accepted(record.proposal ?? []).length);
  return (await createManualRecord(project, { title, notes, kind: 'content' }, { createdBy: 'agent', fromAgentTaskId: record.id, locked })).id;
}

/** A handoff that was still open: reads the Connections call or the planning session and records where it stands. */
async function refreshedHandoff(project: ProjectRecord, record: AgentRecord, handoff: HandoffRecord): Promise<HandoffRecord> {
  const { handoff: port } = taskPorts();
  if (handoff.state === 'awaiting-approval' && handoff.callId) {
    const result = await port.callResult(handoff.callId);
    if (result.state === 'waiting') return handoff;
    if (result.state === 'failed' || !result.sessionId) return { ...handoff, state: 'failed', error: result.note ?? 'The planning session was not started' };
    const followUpTaskId = await followUpTaskFor(project, record, true);
    return { ...handoff, state: 'handed-off', sessionId: result.sessionId, followUpTaskId };
  }
  if (handoff.state === 'handed-off' && handoff.sessionId && handoff.targetBuildingId) {
    const status = await port.sessionStatus(handoff.targetBuildingId, handoff.sessionId);
    return { ...handoff, sessionStatus: status === 'unknown' ? 'unavailable' : status };
  }
  return handoff;
}

/**
 * Approves the accepted rows and hands them off. The claim (approved, handing off) is saved before anything else is
 * awaited, so a second approval of the same task answers 409 and creates nothing.
 */
export async function approveProposal(project: ProjectRecord, id: string): Promise<AgentRecord> {
  assertWritable(project);
  const claimed = await withTaskLock(project.id, async () => {
    const record = await requireAgent(project, id);
    if (!isProposing(record.slot)) throw new SeoConflictError('Only proposals can be approved');
    if (record.approvedAt) throw new SeoConflictError('This proposal was already approved');
    const run = await agentRunState(record);
    if (!record.proposal || !run || (run.status !== 'awaiting-approval' && run.status !== 'succeeded')) throw new SeoConflictError('This task is not waiting for approval');
    if (!reviewSummary(record.proposal).canApprove) throw new SeoConflictError('Accept at least one row before approving');
    const now = seoDeps().now().toISOString();
    return { saved: (await saveTask(project, { ...record, approvedAt: now, handoff: newHandoff('software', 'handing-off', now) })) as AgentRecord, run };
  });
  const undo = () => withTaskLock(project.id, async () => saveTask(project, { ...(await requireAgent(project, id)), approvedAt: null, handoff: null }));
  if (claimed.run.status === 'awaiting-approval') {
    try { await taskPorts().runs.approve(claimed.saved.runId!); } catch (error) {
      await undo();
      throw new SeoConflictError(`The run could not be approved: ${(error as Error).message}`);
    }
  }
  return performHandoff(project, claimed.saved);
}

async function performHandoff(project: ProjectRecord, record: AgentRecord): Promise<AgentRecord> {
  inflight.add(record.id);
  try {
    return await handOff(project, record);
  } catch (error) {
    // The run is already approved, so an unexpected failure is recorded as a failed handoff the person can retry.
    const failed = newHandoff('software', 'failed', seoDeps().now().toISOString(), { error: (error as Error).message });
    return withTaskLock(project.id, async () => saveTask(project, { ...(await requireAgent(project, record.id)), handoff: failed }) as Promise<AgentRecord>);
  } finally {
    inflight.delete(record.id);
  }
}

async function handOff(project: ProjectRecord, record: AgentRecord): Promise<AgentRecord> {
  const lookup = await taskPorts().handoff.lookup(project.id);
  let handoff: HandoffRecord;
  if (lookup.state === 'linked') handoff = await softwareHandoff(project, record, lookup.target);
  else if (lookup.state === 'missing') {
    handoff = newHandoff('software', 'failed', seoDeps().now().toISOString(), { error: 'The linked Software building no longer exists. Use the manual task with the CSV instead.' });
  } else {
    const reasons = { 'not-linked': null, 'wrong-type': `"${'name' in lookup ? lookup.name : ''}" is not a Software building, so nothing was sent to it.`, 'no-capability': `The link to "${'name' in lookup ? lookup.name : ''}" does not allow starting a planning session.` } as const;
    handoff = await manualFallback(project, record, reasons[lookup.state]);
  }
  return withTaskLock(project.id, async () => saveTask(project, { ...(await requireAgent(project, record.id)), handoff }) as Promise<AgentRecord>);
}

/** Tries a failed software handoff again. Exactly one attempt is claimed, so a double click starts one session. */
export async function retryHandoff(project: ProjectRecord, id: string): Promise<AgentRecord> {
  assertWritable(project);
  const record = await withTaskLock(project.id, async () => {
    const current = await requireAgent(project, id);
    if (current.handoff?.state !== 'failed' || current.handoff.path !== 'software') throw new SeoConflictError('There is no failed handoff to retry');
    return saveTask(project, { ...current, handoff: newHandoff('software', 'handing-off', seoDeps().now().toISOString()) }) as Promise<AgentRecord>;
  });
  return performHandoff(project, record);
}

/** Creates the manual task with the CSV for a failed handoff. At most one is ever made. */
export async function useManualFallback(project: ProjectRecord, id: string): Promise<AgentRecord> {
  assertWritable(project);
  return withTaskLock(project.id, async () => {
    const record = await requireAgent(project, id);
    if (record.handoff?.state !== 'failed') throw new SeoConflictError('The manual task is only offered after a failed handoff');
    if (record.handoff.manualTaskId) throw new SeoConflictError('The manual task was already created');
    const handoff = await manualFallback(project, record, record.handoff.error, true);
    return saveTask(project, { ...record, handoff }) as Promise<AgentRecord>;
  });
}

// ---- control --------------------------------------------------------------------------------------------------------

export async function stopAgentTask(project: ProjectRecord, id: string): Promise<AgentRecord> {
  assertWritable(project);
  const record = await requireAgent(project, id);
  const run = await agentRunState(record);
  if (!record.runId || !run || !ACTIVE_RUN.includes(run.status)) throw new SeoConflictError('Nothing is running for this task');
  await taskPorts().runs.stop(record.runId);
  return settleAgent(project, id);
}

/** An agent task's only editable field is its title, and not while its run is going. */
export async function patchAgentTask(project: ProjectRecord, id: string, body: Record<string, unknown>): Promise<AgentRecord> {
  assertWritable(project);
  if (body.status !== undefined) throw new SeoInputError('the status of an agent task comes from its run and cannot be set');
  return withTaskLock(project.id, async () => {
    const record = await requireAgent(project, id);
    const run = await agentRunState(record);
    if (run?.status === 'running') throw new SeoConflictError('The inputs of a running task cannot be changed');
    if (body.title === undefined) return record;
    return saveTask(project, { ...record, title: requireTitle(body.title) }) as Promise<AgentRecord>;
  });
}
