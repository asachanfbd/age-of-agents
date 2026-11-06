import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import { test } from 'node:test';
import { SeoUpstreamError } from '../src/seo/errors.ts';
import { ADS_API_VERSION, googleServices } from '../src/seo/googleServices.ts';
import { createKeywordAgent } from '../src/seo/keywordAgent.ts';
import type { AgentTurnDeps } from '../src/seo/keywordAgent.ts';

const clusterInput = { buildingId: 'b1', clusters: ['Shoes'], keywords: [{ keyword: 'red shoes', cluster: null, pinned: false, impressions: 10 }] };
const scratchDirs = async () => (await readdir(os.tmpdir())).filter((n) => n.startsWith('agent-visual-os-keywords-'));

function fakeDeps(overrides: Partial<AgentTurnDeps> = {}) {
  const calls: Array<{ options: Parameters<AgentTurnDeps['runTurn']>[1]; context: { purpose: string; projectId: string } }> = [];
  const deps: AgentTurnDeps = {
    selectExecutor: async () => ({ id: 'claude' }),
    runTurn: async (_executor, options, context) => { calls.push({ options, context }); return { status: 'done', message: 'ok', extra: { clusters: [] } }; },
    ...overrides,
  };
  return { deps, calls };
}

test('I36 the agent answers with the turn\'s JSON, asks for no tools, and removes its scratch folder', async () => {
  const before = (await scratchDirs()).length;
  const { deps, calls } = fakeDeps();
  const answer = await createKeywordAgent(deps).cluster(clusterInput, new AbortController().signal);
  assert.deepEqual(answer, { clusters: [] });
  assert.deepEqual(JSON.parse(calls[0]!.options.prompt), clusterInput);
  assert.ok(calls[0]!.options.disallowedTools.includes('Bash') && calls[0]!.options.disallowedTools.includes('WebFetch'));
  assert.deepEqual(calls[0]!.context, { purpose: 'SEO keyword clustering', projectId: 'b1' });
  assert.equal((await scratchDirs()).length, before);
});

test('I36 research uses its own instructions and purpose', async () => {
  const { deps, calls } = fakeDeps({ runTurn: async (_e, options, context) => { calls.push({ options, context }); return { status: 'done', message: '', extra: { keywords: [] } }; } });
  await createKeywordAgent(deps).research({ buildingId: 'b2', siteUrl: 'https://x.test', topQueries: [], pages: [], competitors: [], known: [] }, new AbortController().signal);
  assert.equal(calls[0]!.context.purpose, 'SEO keyword research');
  assert.match(calls[0]!.options.appendSystemPrompt, /suggest new search keywords/i);
});

test('I36 no executor available is a clear failure and no turn is started', async () => {
  const { deps, calls } = fakeDeps({ selectExecutor: async () => null });
  await assert.rejects(createKeywordAgent(deps).cluster(clusterInput, new AbortController().signal), (e: Error) => e instanceof SeoUpstreamError && /No agent is available/.test(e.message));
  assert.equal(calls.length, 0);
});

test('I36 a turn that is blocked, or ends without JSON, is a failure that says why', async () => {
  for (const result of [{ status: 'blocked', message: 'needs a decision' }, { status: 'done', message: 'no json here' }, { status: 'error', message: 'x'.repeat(500) }]) {
    const { deps } = fakeDeps({ runTurn: async () => result });
    await assert.rejects(createKeywordAgent(deps).cluster(clusterInput, new AbortController().signal), (e: Error) => e instanceof SeoUpstreamError && /did not answer/.test(e.message) && e.message.length < 260);
  }
});

test('I29 stopping kills the running process, and an answer that arrives after the stop is not used', async () => {
  const stop = new AbortController();
  let killed = 0;
  const { deps } = fakeDeps({
    runTurn: async (_e, options) => {
      options.onProcess({ kill: () => { killed++; } });
      stop.abort();
      return { status: 'done', message: '', extra: { clusters: [] } };
    },
  });
  await assert.rejects(createKeywordAgent(deps).cluster(clusterInput, stop.signal), /was stopped/);
  assert.equal(killed, 1);
  const already = new AbortController();
  already.abort();
  const second = fakeDeps({ runTurn: async (_e, options) => { options.onProcess({ kill: () => { killed++; } }); return { status: 'done', message: '', extra: {} }; } });
  await assert.rejects(createKeywordAgent(second.deps).cluster(clusterInput, already.signal), /was stopped/);
  assert.equal(killed, 2, 'a process started after the stop is killed at once');
});

test('I29 the scratch folder is removed even when the turn throws', async () => {
  const before = (await scratchDirs()).length;
  const { deps } = fakeDeps({ runTurn: async () => { throw new Error('spawn failed'); } });
  await assert.rejects(createKeywordAgent(deps).cluster(clusterInput, new AbortController().signal), /spawn failed/);
  assert.equal((await scratchDirs()).length, before);
});

/* ----- Google Ads Keyword Planner calls (the real request and answer shapes, with fetch stubbed) ----- */

async function withFetch<T>(answer: (url: string, init: RequestInit) => Response, run: (seen: Array<{ url: string; init: RequestInit }>) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const seen: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return answer(url, init); }) as typeof fetch;
  try { return await run(seen); } finally { globalThis.fetch = real; }
}
const access = { accessToken: 'tok', developerToken: 'dev', customerId: '123-456-7890' };
const market = { languageId: '1000', locationId: '2840' };

test('I48 keyword ideas ask for the seeds, language and location and read the average monthly searches', async () => {
  const ideas = await withFetch(() => new Response(JSON.stringify({ results: [{ text: 'epsilon', keywordIdeaMetrics: { avgMonthlySearches: '1000' } }, { text: 'no metrics' }] })), async (seen) => {
    const result = await googleServices.ads.keywordIdeas({ ...access, ...market, seeds: Array.from({ length: 25 }, (_, i) => `seed ${i}`) });
    assert.equal(seen[0]!.url, `https://googleads.googleapis.com/${ADS_API_VERSION}/customers/1234567890:generateKeywordIdeas`);
    const body = JSON.parse(String(seen[0]!.init.body));
    assert.equal(body.keywordSeed.keywords.length, 20, 'Keyword Planner takes at most 20 seeds');
    assert.deepEqual([body.language, body.geoTargetConstants], ['languageConstants/1000', ['geoTargetConstants/2840']]);
    assert.equal((seen[0]!.init.headers as Record<string, string>)['developer-token'], 'dev');
    return result;
  });
  assert.deepEqual(ideas, [{ keyword: 'epsilon', volume: 1000 }, { keyword: 'no metrics', volume: null }]);
});

test('I57 historical metrics give a volume per keyword, and an empty answer is an empty list', async () => {
  const found = await withFetch(() => new Response(JSON.stringify({ results: [{ text: 'alpha', keywordMetrics: { avgMonthlySearches: 320 } }] })), () => googleServices.ads.keywordVolumes({ ...access, ...market, keywords: ['alpha', 'beta'] }));
  assert.deepEqual(found, [{ keyword: 'alpha', volume: 320 }]);
  assert.deepEqual(await withFetch(() => new Response('{}'), () => googleServices.ads.keywordVolumes({ ...access, ...market, keywords: ['x'] })), []);
});

test('I55/I56 Ads answers are sorted into quota, access and sign-in failures without echoing the body', async () => {
  for (const [status, kind] of [[429, 'quota'], [403, 'access'], [401, 'auth'], [500, 'network']] as const) {
    await withFetch(() => new Response('{"error":"secret detail dev-token"}', { status }), async () => {
      await assert.rejects(googleServices.ads.keywordIdeas({ ...access, ...market, seeds: ['a'] }), (e: any) => e.kind === kind && !/secret detail/.test(e.message));
    });
  }
});
