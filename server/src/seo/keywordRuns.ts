import { beginJob, endJob } from './jobs.ts';
import { randomUUID } from 'node:crypto';
import { getStore, guardedWrite } from '../buildings/buildingStorage.ts';
import { assertWritable } from '../buildings/normalize.ts';
import { SecretsStore } from '../buildings/secrets.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { seoDeps } from './deps.ts';
import { SeoConflictError, SeoInputError, SeoNotFoundError, SeoUpstreamError, ServiceError } from './errors.ts';
import type { Candidate } from './keywordClustering.ts';
import { parseClusterOutput, planClustering, selectCandidates, splitBatches } from './keywordClustering.ts';
import type { ClusterRec, KeywordRec } from './keywordClusters.ts';
import { buildModel, contextOf, gscUniverse, readRows, readStored, stepsOf, withKeywordLock } from './keywords.ts';
import type { Context } from './keywords.ts';
import { competitorDomains, freshIdeas, parseResearchOutput } from './keywordResearch.ts';
import type { Idea } from './keywordResearch.ts';
import { displayOf, MAX_BULK_KEYS, nameKeyOf, requireName, volumeFrom } from './keywordRules.ts';
import type { Volume } from './keywordRules.ts';
import { rowArray } from './keywordTables.ts';
import type { ProposalRow, RunRow } from './keywordTables.ts';
import { windowsOf } from './pages.ts';
import { updateSettings } from './settings.ts';
import { accessTokenFor, secretKeys } from './tokens.ts';

export type RunKind = 'cluster' | 'research';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped';

export interface RunView {
  id: string;
  kind: RunKind;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  progress: { done: number; total: number };
  /** Shown when the run did not cover everything (the cap) or could not use Google Ads. */
  notices: string[];
  error: string | null;
  /** Why Google Ads gave nothing during the run (quota, access), also shown in Settings. */
  adsError: string | null;
  result: Record<string, number>;
  /** Orders runs that start in the same millisecond. */
  seq: number;
}

const SWEPT = 'The daemon restarted while this run was working, so the run was stopped.';
/** Proposals one research run keeps. */
export const MAX_PROPOSALS = 200;
/** Ads volumes are refreshed for this many keywords at a time. */
export const VOLUME_REFRESH_LIMIT = 1000;

let runSeq = 0;

class Stopped extends Error {}

interface Active { runId: string; abort: AbortController; finished: Promise<void> }
const active = new Map<string, Active>();
const slot = (buildingId: string, kind: RunKind) => `${buildingId}:${kind}`;

/** Forgets a Building's runs in memory; called when the Building is deleted. */
export function forgetKeywordRuns(buildingId: string): void {
  for (const [key, a] of active) if (key.startsWith(`${buildingId}:`)) { a.abort.abort(); active.delete(key); }
}

const viewOf = (row: RunRow): RunView => {
  const data = JSON.parse(row.data) as Pick<RunView, 'progress' | 'notices' | 'error' | 'adsError' | 'result' | 'seq'>;
  return { id: row.uid, kind: row.kind as RunKind, status: row.status as RunStatus, startedAt: row.startedAt, finishedAt: row.finishedAt || null, ...data };
};

const rowOf = (view: RunView): RunRow => ({
  uid: view.id, kind: view.kind, status: view.status, startedAt: view.startedAt, finishedAt: view.finishedAt ?? '',
  data: JSON.stringify({ progress: view.progress, notices: view.notices, error: view.error, adsError: view.adsError, result: view.result, seq: view.seq }),
});

const saveRun = (project: ProjectRecord, view: RunView) =>
  guardedWrite(project, (store) => store.replaceRows([{ table: 'seo_keyword_runs', where: { uid: view.id }, rows: [rowArray('seo_keyword_runs', rowOf(view))] }]));

/** The newest run of a kind. A run still marked working that nothing in this process is running was cut off by a restart, so it is closed as failed. */
export async function latestRun(project: ProjectRecord, kind: RunKind): Promise<RunView | null> {
  const store = await getStore(project);
  const views = (await readRows<RunRow>(store, 'seo_keyword_runs')).filter((r) => r.kind === kind).map(viewOf)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : (b.seq ?? 0) - (a.seq ?? 0)));
  const view = views[0];
  if (!view) return null;
  if ((view.status === 'running' || view.status === 'queued') && active.get(slot(project.id, kind))?.runId !== view.id) {
    const swept: RunView = { ...view, status: 'failed', error: SWEPT, finishedAt: seoDeps().now().toISOString() };
    await saveRun(project, swept);
    return swept;
  }
  return view;
}

function raceAbort<T>(work: (signal: AbortSignal) => Promise<T>, outer: AbortSignal, ms: number): Promise<T> {
  const inner = new AbortController();
  return new Promise<T>((resolve, reject) => {
    if (outer.aborted) return reject(new Stopped());
    const timer = setTimeout(() => { inner.abort(); reject(new SeoUpstreamError(`The agent did not answer within ${Math.max(1, Math.round(ms / 1000))} seconds`)); }, ms);
    const onAbort = () => { inner.abort(); reject(new Stopped()); };
    outer.addEventListener('abort', onAbort, { once: true });
    work(inner.signal).then(resolve, reject).finally(() => { clearTimeout(timer); outer.removeEventListener('abort', onAbort); });
  });
}

/** Creates the run record and starts `body` in the background; at most one run of a kind per Building. */
async function start(project: ProjectRecord, kind: RunKind, total: number, notices: string[], body: (view: RunView, signal: AbortSignal, update: (patch: Partial<RunView>) => Promise<void>) => Promise<Partial<RunView>>): Promise<RunView> {
  assertWritable(project);
  const key = slot(project.id, kind);
  if (active.has(key)) throw new SeoConflictError(`A ${kind === 'cluster' ? 'clustering' : 'research'} run is already in progress`);
  const abort = new AbortController();
  let view: RunView = { id: randomUUID(), kind, status: 'queued', startedAt: seoDeps().now().toISOString(), finishedAt: null, progress: { done: 0, total }, notices, error: null, adsError: null, result: {}, seq: ++runSeq };
  const entry: Active = { runId: view.id, abort, finished: Promise.resolve() };
  active.set(key, entry);
  try { await saveRun(project, view); } catch (error) { active.delete(key); throw error; }
  beginJob({ id: view.id, buildingId: project.id, kind: kind === 'cluster' ? 'keywords-cluster' : 'keywords-research', startedAt: view.startedAt });
  const update = async (patch: Partial<RunView>) => { view = { ...view, ...patch }; await saveRun(project, view); };
  entry.finished = (async () => {
    try {
      await update({ status: 'running' });
      const patch = await body(view, abort.signal, update);
      await update({ ...patch, status: 'succeeded', finishedAt: seoDeps().now().toISOString() });
      endJob(view.id, 'complete');
    } catch (error) {
      const stopped = error instanceof Stopped || abort.signal.aborted;
      await update({ status: stopped ? 'stopped' : 'failed', error: stopped ? null : (error as Error).message, finishedAt: seoDeps().now().toISOString() }).catch(() => undefined);
      endJob(view.id, stopped ? 'stopped' : 'failed', stopped ? undefined : (error as Error).message);
    } finally {
      active.delete(key);
      endJob(view.id, 'failed');
    }
  })();
  return view;
}

/** Waits for the run in progress to finish; used by tests and by a stop request. */
export async function settleRun(buildingId: string, kind: RunKind): Promise<void> {
  await active.get(slot(buildingId, kind))?.finished;
}

export async function stopRun(project: ProjectRecord, kind: RunKind): Promise<RunView> {
  const entry = active.get(slot(project.id, kind));
  if (!entry) throw new SeoConflictError('No run is in progress');
  entry.abort.abort();
  await entry.finished;
  return (await latestRun(project, kind))!;
}

// ---- clustering -----------------------------------------------------------------------------------------------------

/** Starts a clustering run over the keywords the person has not placed by hand (capped per run). Nothing changes until every batch has answered. */
export async function startClustering(project: ProjectRecord): Promise<RunView> {
  const model = await buildModel(project, (ledgers, now) => ({ windows: windowsOf({}, ledgers, now) }));
  if (!model.items.length) throw new SeoInputError('There are no keywords to cluster yet');
  if (active.has(slot(project.id, 'cluster'))) throw new SeoConflictError('A clustering run is already in progress');
  const { limits, agent } = seoDeps();
  const candidates: Candidate[] = model.items.map((i) => ({ key: i.key, display: i.keyword, pinned: i.pinned, clusterId: i.clusterId, impressions: i.stat.current.impressions }));
  const selection = selectCandidates(candidates, limits.clusterCap);
  const batches = splitBatches(selection.selected, limits.clusterBatch);
  return start(project, 'cluster', selection.selected.length, selection.message ? [selection.message] : [], async (view, signal, update) => {
    const names = new Map([...model.stored.clusters.values()].map((c) => [c.nameKey, c.name]));
    const groups = [];
    let done = 0;
    for (const batch of batches) {
      if (signal.aborted) throw new Stopped();
      const input = { buildingId: project.id, clusters: [...names.values()], keywords: batch.map((c) => ({ keyword: c.display, cluster: c.clusterId ? model.stored.clusters.get(c.clusterId)?.name ?? null : null, pinned: c.pinned, impressions: c.impressions })) };
      const output = await raceAbort((s) => agent.cluster(input, s), signal, limits.agentTimeoutMs);
      const parsed = parseClusterOutput(output, new Set(batch.map((c) => c.key)));
      for (const g of parsed) names.set(nameKeyOf(g.name), names.get(nameKeyOf(g.name)) ?? g.name);
      groups.push(...parsed);
      done += batch.length;
      await update({ progress: { done, total: selection.selected.length } });
    }
    if (signal.aborted) throw new Stopped();
    return { result: await applyClustering(project, view.id, selection.selected.map((c) => c.key), groups) };
  });
}

/** Applies the agent's groups against the state as it is now, so a keyword pinned or moved while the run worked is never overwritten. */
async function applyClustering(project: ProjectRecord, runId: string, sentKeys: string[], groups: ReturnType<typeof parseClusterOutput>): Promise<Record<string, number>> {
  return withKeywordLock(project.id, async () => {
    const ctx = await contextOf(project);
    const stored = await readStored(ctx.store);
    const sent = new Map(sentKeys.map((key) => [key, { pinned: stored.keywords.get(key)?.pinned ?? false, clusterId: stored.keywords.get(key)?.clusterId ?? null }]));
    const plan = planClustering({ sent, clusters: stored.clusters }, groups);
    const now = seoDeps().now().toISOString();
    const clusters = new Map<string, ClusterRec>();
    for (const name of plan.createdNames) clusters.set(nameKeyOf(name), { id: randomUUID(), name: requireName(name), nameKey: nameKeyOf(name), pinned: false, createdAt: now });
    const changes = { clusters: new Map<string, ClusterRec | null>([...clusters.values()].map((c) => [c.id, c])), keywords: new Map<string, KeywordRec>() };
    const universe = await gscUniverse(ctx.store, ctx.property);
    for (const move of plan.moves) {
      const clusterId = move.clusterId ?? clusters.get(nameKeyOf(move.newName!))!.id;
      const existing = stored.keywords.get(move.key);
      const text = existing?.display ?? universe.display.get(move.key) ?? move.key;
      changes.keywords.set(move.key, { ...(existing ?? { key: move.key, display: text, sources: [], status: 'tracking' as const, pinned: false, targetPage: '', createdAt: now }), clusterId });
    }
    const existingSuggestions = await readRows<{ uid: string; key: string; toName: string; status: string }>(ctx.store, 'seo_cluster_suggestions');
    const pending = new Map(existingSuggestions.filter((s) => s.status === 'pending').map((s) => [`${s.key}\u0000${nameKeyOf(s.toName)}`, s.uid]));
    const newSuggestions = plan.suggestions.filter((s) => !pending.has(`${s.key}\u0000${nameKeyOf(s.toName)}`));
    const steps = [
      ...stepsOf(changes),
      ...newSuggestions.map((s) => {
        const id = randomUUID();
        return { table: 'seo_cluster_suggestions', where: { uid: id }, rows: [rowArray('seo_cluster_suggestions', { uid: id, runId, key: s.key, display: stored.keywords.get(s.key)?.display ?? universe.display.get(s.key) ?? s.key, fromClusterId: s.fromClusterId ?? '', toName: s.toName, status: 'pending', createdAt: now })] };
      }),
    ];
    if (steps.length) await guardedWrite(project, (store) => store.replaceRows(steps));
    return { placed: plan.moves.length, clustersCreated: plan.createdNames.length, suggestions: newSuggestions.length };
  });
}

// ---- research -------------------------------------------------------------------------------------------------------

type AdsStatus = { ok: true; access: { accessToken: string; developerToken: string; customerId: string }; market: { languageId: string; locationId: string } } | { ok: false; notice: string };

/** Whether Keyword Planner can be asked: connected, with a developer token, and a language and location chosen. */
async function adsStatus(ctx: Context & { settings: Awaited<ReturnType<typeof contextOf>>['settings'] }): Promise<AdsStatus> {
  const ads = ctx.settings.connections.ads;
  if (!ads.connected || !ads.customerId) return { ok: false, notice: 'Connect Google Ads for volume' };
  const market = ctx.settings.keywordMarket;
  if (!market?.languageId || !market.locationId) return { ok: false, notice: 'Choose a language and location for keyword research to get volumes' };
  const developerToken = await new SecretsStore(ctx.project.id).get(secretKeys.adsDeveloperToken);
  if (!developerToken) return { ok: false, notice: 'Save the Google Ads developer token in Settings to get volumes' };
  const { services, now } = seoDeps();
  const accessToken = await accessTokenFor(ctx.project.id, 'ads', { services, now });
  return { ok: true, access: { accessToken, developerToken, customerId: ads.customerId }, market };
}

/** Turns an Ads failure into the sentence shown in the run and in Settings. Stored volumes are left alone. */
async function adsFailure(project: ProjectRecord, error: unknown): Promise<string> {
  const message = error instanceof ServiceError ? error.message : `Google Ads could not be used: ${(error as Error).message}`;
  if (!(error instanceof ServiceError) || error.kind !== 'network') await updateSettings(project.id, (s) => { s.connections.ads.reason = message; }).catch(() => undefined);
  return message;
}

export async function setKeywordMarket(project: ProjectRecord, languageId: unknown, locationId: unknown): Promise<void> {
  assertWritable(project);
  const id = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !/^\d{1,12}$/.test(v.trim())) throw new SeoInputError(`${what} must be the numeric Google Ads id`);
    return v.trim();
  };
  const market = { languageId: id(languageId, 'languageId'), locationId: id(locationId, 'locationId') };
  await updateSettings(project.id, (s) => { s.keywordMarket = market; });
}

const toRow = (idea: Idea & { key: string }, runId: string, now: string, volume: Volume | null): ProposalRow => ({
  uid: randomUUID(), key: idea.key, display: displayOf(idea.keyword), origin: idea.origin, reason: idea.reason, status: 'pending',
  volKind: volume?.kind ?? '', volLow: volume?.low ?? 0, volHigh: volume?.high ?? 0, volFetchedAt: volume?.fetchedAt ?? '', runId, createdAt: now,
});

/** Starts a research run: the agent proposes keywords from Search Console data, the site's pages and the competitors named; Google Ads adds ideas and volumes when it works. Proposals wait for review. */
export async function startResearch(project: ProjectRecord, input: { competitors?: unknown }): Promise<RunView> {
  const competitors = competitorDomains(input.competitors);
  if (active.has(slot(project.id, 'research'))) throw new SeoConflictError('A research run is already in progress');
  const { agent, limits, services, now: clock } = seoDeps();
  return start(project, 'research', 1, [], async (_view, signal, update) => {
    const model = await buildModel(project, (ledgers, now) => ({ windows: windowsOf({}, ledgers, now) }));
    const proposals = await readRows<ProposalRow>(model.ctx.store, 'seo_keyword_proposals');
    const excluded = new Set([...model.items.map((i) => i.key), ...proposals.filter((p) => p.status !== 'accepted').map((p) => p.key)]);
    const top = [...model.items].sort((a, b) => b.stat.current.impressions - a.stat.current.impressions || (a.key < b.key ? -1 : 1)).slice(0, 100);
    const pageTotals = new Map<string, number>();
    for (const i of model.items) for (const p of i.stat.pages) pageTotals.set(p, (pageTotals.get(p) ?? 0) + i.stat.current.impressions);
    const output = await raceAbort((s) => agent.research({
      buildingId: project.id, siteUrl: model.ctx.siteUrl, competitors, known: [...excluded].slice(0, 2000),
      topQueries: top.map((i) => ({ keyword: i.keyword, impressions: i.stat.current.impressions, position: i.stat.current.impressions ? i.stat.current.positionImpressions / i.stat.current.impressions : null })),
      pages: [...pageTotals].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([url]) => url),
    }, s), signal, limits.agentTimeoutMs);
    const ideas: Idea[] = parseResearchOutput(output).map((i) => ({ keyword: i.keyword, reason: i.reason, origin: 'agent' as const }));

    const notices: string[] = [];
    let adsError: string | null = null;
    const volumes = new Map<string, Volume>();
    const ads = await adsStatus(model.ctx).catch(async (error) => { adsError = await adsFailure(project, error); return { ok: false as const, notice: adsError }; });
    if (!ads.ok) notices.push(ads.notice);
    else {
      const fetchedAt = clock().toISOString();
      try {
        const seeds = top.slice(0, 20).map((i) => i.keyword);
        const found = seeds.length ? await raceAbort(() => services.ads.keywordIdeas({ ...ads.access, ...ads.market, seeds }), signal, limits.agentTimeoutMs) : [];
        for (const f of found) {
          ideas.push({ keyword: f.keyword, origin: 'ads', reason: 'Suggested by Google Ads Keyword Planner' });
          const v = volumeFrom(f.volume, fetchedAt);
          const key = freshIdeas([{ keyword: f.keyword, origin: 'ads', reason: '' }], new Set())[0]?.key;
          if (v && key) volumes.set(key, v);
        }
        const needing = freshIdeas(ideas, excluded).filter((i) => !volumes.has(i.key)).slice(0, MAX_PROPOSALS);
        if (needing.length) {
          for (const f of await raceAbort(() => services.ads.keywordVolumes({ ...ads.access, ...ads.market, keywords: needing.map((i) => i.keyword) }), signal, limits.agentTimeoutMs)) {
            const v = volumeFrom(f.volume, fetchedAt);
            const key = freshIdeas([{ keyword: f.keyword, origin: 'ads', reason: '' }], new Set())[0]?.key;
            if (v && key) volumes.set(key, v);
          }
        }
        if (model.ctx.settings.connections.ads.reason) await updateSettings(project.id, (s) => { s.connections.ads.reason = null; });
      } catch (error) {
        if (error instanceof Stopped) throw error;
        adsError = await adsFailure(project, error);
        notices.push('Google Ads could not give ideas or volumes for this run');
      }
    }
    const allFresh = freshIdeas(ideas, excluded);
    const fresh = allFresh.slice(0, MAX_PROPOSALS);
    if (fresh.length) {
      const at = clock().toISOString();
      await guardedWrite(project, (store) => store.replaceRows(fresh.map((i) => {
        const row = toRow(i, _view.id, at, volumes.get(i.key) ?? null);
        return { table: 'seo_keyword_proposals', where: { uid: row.uid }, rows: [rowArray('seo_keyword_proposals', row)] };
      })));
    }
    if (allFresh.length > fresh.length) notices.push(`Kept the first ${MAX_PROPOSALS} ideas`);
    return { progress: { done: 1, total: 1 }, notices, adsError, result: { proposed: fresh.length } };
  });
}

/** Keeps the ideas an agent task's research run returned as proposals for review (no Google Ads volumes). Returns how many were new. */
export async function storeResearchAnswer(project: ProjectRecord, runId: string, output: unknown): Promise<{ proposed: number }> {
  assertWritable(project);
  const ideas: Idea[] = parseResearchOutput(output).map((i) => ({ keyword: i.keyword, reason: i.reason, origin: 'agent' as const }));
  return withKeywordLock(project.id, async () => {
    const model = await buildModel(project, (ledgers, now) => ({ windows: windowsOf({}, ledgers, now) }));
    const proposals = await readRows<ProposalRow>(model.ctx.store, 'seo_keyword_proposals');
    const excluded = new Set([...model.items.map((i) => i.key), ...proposals.filter((p) => p.status !== 'accepted').map((p) => p.key)]);
    const fresh = freshIdeas(ideas, excluded).slice(0, MAX_PROPOSALS);
    const at = seoDeps().now().toISOString();
    if (fresh.length) {
      await guardedWrite(project, (store) => store.replaceRows(fresh.map((i) => {
        const row = toRow(i, runId, at, null);
        return { table: 'seo_keyword_proposals', where: { uid: row.uid }, rows: [rowArray('seo_keyword_proposals', row)] };
      })));
    }
    return { proposed: fresh.length };
  });
}

/** Applies a clustering answer from an agent task against the keywords it was sent. */
export async function applyClusterAnswer(project: ProjectRecord, runId: string, sentKeys: string[], output: unknown): Promise<Record<string, number>> {
  assertWritable(project);
  return applyClustering(project, runId, sentKeys, parseClusterOutput(output, new Set(sentKeys)));
}

// ---- proposals ------------------------------------------------------------------------------------------------------

export async function listProposals(project: ProjectRecord, status: string | undefined) {
  const store = await getStore(project);
  const wanted = status === undefined || status === '' ? 'pending' : status;
  if (!['pending', 'accepted', 'rejected', 'all'].includes(wanted)) throw new SeoInputError('status must be pending, accepted, rejected or all');
  const [rows, settings] = await Promise.all([readRows<ProposalRow>(store, 'seo_keyword_proposals'), contextOf(project)]);
  const ads = settings.settings.connections.ads;
  return {
    volumeAvailable: ads.connected && !!ads.customerId,
    adsError: ads.reason ?? null,
    market: settings.settings.keywordMarket ?? null,
    proposals: rows.filter((r) => wanted === 'all' || r.status === wanted)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.key < b.key ? -1 : 1))
      .map((r) => ({
        id: r.uid, key: r.key, keyword: r.display, origin: r.origin, reason: r.reason, status: r.status, runId: r.runId, createdAt: r.createdAt,
        volume: r.volKind ? { kind: r.volKind as Volume['kind'], low: r.volLow, high: r.volHigh, fetchedAt: r.volFetchedAt } : null,
      })),
  };
}

function requireIds(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_BULK_KEYS || input.some((i) => typeof i !== 'string')) throw new SeoInputError(`ids must be a list of 1 to ${MAX_BULK_KEYS} proposal ids`);
  return [...new Set(input as string[])];
}

async function proposalsByIds(project: ProjectRecord, ids: string[]): Promise<ProposalRow[]> {
  const all = new Map((await readRows<ProposalRow>(await getStore(project), 'seo_keyword_proposals')).map((r) => [r.uid, r]));
  return ids.map((id) => {
    const found = all.get(id);
    if (!found) throw new SeoNotFoundError('That proposal does not exist');
    return found;
  });
}

const proposalStep = (row: ProposalRow, status: string) => ({ table: 'seo_keyword_proposals', where: { uid: row.uid }, rows: [rowArray('seo_keyword_proposals', { ...row, status })] });

/** Adds the proposals to the tracked keywords (source research). With a cluster they are placed there and pinned; without, they stay unclustered. Accepting twice is harmless. */
export async function acceptProposals(project: ProjectRecord, idsInput: unknown, clusterId?: unknown): Promise<{ accepted: number; alreadyAccepted: number }> {
  const ids = requireIds(idsInput);
  assertWritable(project);
  return withKeywordLock(project.id, async () => {
    const proposals = await proposalsByIds(project, ids);
    const stored = await readStored(await getStore(project));
    if (clusterId !== undefined && clusterId !== null && !stored.clusters.has(String(clusterId))) throw new SeoNotFoundError('That cluster does not exist');
    const placeIn = clusterId == null ? null : String(clusterId);
    const now = seoDeps().now().toISOString();
    const pending = proposals.filter((p) => p.status !== 'accepted');
    const steps: Array<{ table: string; where: Record<string, string | number>; rows: Array<Array<string | number>> }> = [];
    const keywords = new Map<string, KeywordRec>();
    for (const p of pending) {
      const base = keywords.get(p.key) ?? stored.keywords.get(p.key);
      const rec: KeywordRec = base
        ? { ...base, sources: base.sources.includes('research') ? base.sources : [...base.sources, 'research'] }
        : { key: p.key, display: p.display, sources: ['research'], status: 'tracking', pinned: false, clusterId: null, targetPage: '', createdAt: now };
      keywords.set(p.key, placeIn ? { ...rec, clusterId: placeIn, pinned: true } : rec);
      if (p.volKind) steps.push({ table: 'seo_keyword_volumes', where: { key: p.key }, rows: [rowArray('seo_keyword_volumes', { key: p.key, kind: p.volKind, low: p.volLow, high: p.volHigh, fetchedAt: p.volFetchedAt })] });
      steps.push(proposalStep(p, 'accepted'));
    }
    if (steps.length) await guardedWrite(project, (store) => store.replaceRows([...stepsOf({ clusters: new Map(), keywords }), ...steps]));
    return { accepted: pending.length, alreadyAccepted: proposals.length - pending.length };
  });
}

/** Rejects proposals so they are not proposed again. An accepted proposal is already a keyword and cannot be rejected. */
export async function rejectProposals(project: ProjectRecord, idsInput: unknown): Promise<{ rejected: number }> {
  const ids = requireIds(idsInput);
  assertWritable(project);
  return withKeywordLock(project.id, async () => {
    const proposals = await proposalsByIds(project, ids);
    if (proposals.some((p) => p.status === 'accepted')) throw new SeoConflictError('An accepted proposal is already a keyword; set the keyword to ignored instead');
    const open = proposals.filter((p) => p.status !== 'rejected');
    if (open.length) await guardedWrite(project, (store) => store.replaceRows(open.map((p) => proposalStep(p, 'rejected'))));
    return { rejected: open.length };
  });
}

/** Asks Google Ads for the current volume of the tracked keywords. A failure leaves the stored volumes as they were. */
export async function refreshVolumes(project: ProjectRecord): Promise<{ updated: number }> {
  assertWritable(project);
  const ctx = await contextOf(project);
  const ads = await adsStatus(ctx).catch(async (error) => ({ ok: false as const, notice: await adsFailure(project, error) }));
  if (!ads.ok) throw new SeoConflictError(ads.notice);
  const model = await buildModel(project, (ledgers, now) => ({ windows: windowsOf({}, ledgers, now) }));
  const keywords = model.items.filter((i) => i.status !== 'ignored').sort((a, b) => b.stat.current.impressions - a.stat.current.impressions || (a.key < b.key ? -1 : 1)).slice(0, VOLUME_REFRESH_LIMIT);
  if (!keywords.length) return { updated: 0 };
  const { services, now } = seoDeps();
  let found;
  try { found = await services.ads.keywordVolumes({ ...ads.access, ...ads.market, keywords: keywords.map((k) => k.keyword) }); } catch (error) {
    throw new SeoUpstreamError(await adsFailure(project, error));
  }
  const fetchedAt = now().toISOString();
  const wanted = new Set(keywords.map((k) => k.key));
  const rows = new Map<string, Volume>();
  for (const f of found) {
    const key = freshIdeas([{ keyword: f.keyword, origin: 'ads', reason: '' }], new Set())[0]?.key;
    const v = volumeFrom(f.volume, fetchedAt);
    if (key && v && wanted.has(key)) rows.set(key, v);
  }
  if (rows.size) {
    await withKeywordLock(project.id, () => guardedWrite(project, (store) => store.replaceRows([...rows].map(([key, v]) => ({ table: 'seo_keyword_volumes', where: { key }, rows: [rowArray('seo_keyword_volumes', { key, kind: v.kind, low: v.low, high: v.high, fetchedAt: v.fetchedAt })] })))));
  }
  await updateSettings(project.id, (s) => { s.connections.ads.reason = null; });
  return { updated: rows.size };
}
