/**
 * The SEO Keywords routes of the daemon stand-in (server/src/api/seoRoutes.ts, server/src/seo/keywords.ts), kept apart from
 * serverStub.mjs. It keeps one in-memory keyword set per Building and answers with the daemon's shapes and its 400, 404
 * and 409 refusals, so the store's behaviour (stale answers, reverted moves) is tested against the same rules.
 *
 * A test seeds `st.kw` through `seoKeywordsState(st)`. `st.kw.gate` is awaited at the start of every list request, which
 * lets a test hold an older request while a newer one finishes.
 */
export function seoKeywordsState(st) {
  st.kw ??= {
    clusters: [], keywords: [], suggestions: [], proposals: [], runs: { cluster: null, research: null }, ads: false, nextId: 1, requests: [], gate: null,
    refuseMove: null, market: null, adsError: null,
  };
  return st.kw;
}

const sumOf = (rows) => rows.reduce((t, r) => ({ clicks: t.clicks + r.clicks, impressions: t.impressions + r.impressions }), { clicks: 0, impressions: 0 });
const shown = ({ clicks, impressions }) => ({ clicks, impressions, ctr: impressions ? clicks / impressions : null, position: impressions ? 4.2 : null });
const keywordRow = (kw, k) => ({
  key: k.key, keyword: k.keyword, sources: ['gsc'], status: k.status ?? 'tracking', pinned: Boolean(k.pinned), clusterId: k.clusterId ?? null,
  clusterName: kw.clusters.find((c) => c.id === k.clusterId)?.name ?? null, targetPage: k.targetPage ?? null, current: shown(k), previous: null, change: null,
  pages: k.pages ?? 1, cannibalised: Boolean(k.cannibalised), volume: k.volume ?? null,
});
const coverage = { current: { covered: 28, total: 28, state: 'full' }, previous: { covered: 28, total: 28, state: 'full' } };
const head = (kw, st) => ({
  range: { from: '2026-02-15', to: '2026-03-14' }, previousRange: { from: '2026-01-18', to: '2026-02-14' }, gsc: { connected: Boolean(st.property), coverage },
  ads: { connected: kw.ads, error: kw.adsError }, capped: false, cannibalisationRule: 'Two or more pages each received at least 5 impressions for this keyword in the range.',
});

/** Returns `{ status, body }` for a Keywords route, or null when the route is not one of them. */
export async function seoKeywordsRoute(st, method, rest, body, params) {
  if (!rest.startsWith('keywords')) return null;
  const kw = seoKeywordsState(st);
  kw.requests.push({ method, rest, body, query: params.toString() });
  const ok = (value, status = 200) => ({ status, body: value });
  const fail = (status, error) => ({ status, body: { error } });
  const clusterOf = (id) => kw.clusters.find((c) => c.id === id);

  if (method === 'GET' && rest === 'keywords/clusters') {
    await kw.gate?.(params);
    const search = (params.get('search') ?? '').toLowerCase();
    const groups = [...kw.clusters.map((c) => ({ cluster: c, members: kw.keywords.filter((k) => k.clusterId === c.id) })), { cluster: null, members: kw.keywords.filter((k) => !k.clusterId) }]
      .filter((g) => g.cluster || g.members.length);
    const rows = groups.filter((g) => !search || (g.cluster?.name ?? 'unclustered').toLowerCase().includes(search) || g.members.some((m) => m.key.includes(search))).map(({ cluster, members }) => ({
      id: cluster?.id ?? null, name: cluster?.name ?? 'Unclustered', pinned: Boolean(cluster?.pinned), keywords: members.length, current: shown(sumOf(members)), previous: null, change: null,
      best: members.length ? { key: members[0].key, keyword: members[0].keyword, clicks: members[0].clicks } : null, pages: members.length, volume: null, cannibalised: members.filter((m) => m.cannibalised).length,
    }));
    const limit = Number(params.get('limit') ?? 50);
    const offset = Number(params.get('offset') ?? 0);
    return ok({ ...head(kw, st), skippedQueries: 0, totals: { keywords: kw.keywords.length, clusters: kw.clusters.length, unclustered: kw.keywords.filter((k) => !k.clusterId).length, pendingSuggestions: kw.suggestions.length }, total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit) });
  }
  if (method === 'GET' && rest === 'keywords') {
    await kw.gate?.(params);
    const cluster = params.get('cluster');
    if (cluster && cluster !== 'unclustered' && !clusterOf(cluster)) return fail(404, 'That cluster does not exist');
    const members = kw.keywords.filter((k) => !cluster || (cluster === 'unclustered' ? !k.clusterId : k.clusterId === cluster));
    const limit = Number(params.get('limit') ?? 50);
    const offset = Number(params.get('offset') ?? 0);
    return ok({ ...head(kw, st), total: members.length, offset, limit, rows: members.slice(offset, offset + limit).map((k) => keywordRow(kw, k)) });
  }
  if (method === 'GET' && rest === 'keywords/detail') {
    const found = kw.keywords.find((k) => k.key === params.get('key'));
    if (!found) return fail(404, 'That keyword is not tracked in this Building');
    const trend = Array.from({ length: 4 }, (_, i) => ({ day: `2026-03-0${i + 1}`, period: 'current', clicks: i === 2 ? null : i, impressions: i === 2 ? null : i * 10, ctr: null, position: null }));
    return ok({ ...keywordRow(kw, found), ...head(kw, st), pageList: [{ url: 'https://example.com/a', path: '/a', isTarget: true, clicks: 5, impressions: 50, ctr: 0.1, position: 3 }], pagesTotal: 1, trend, cannibalisation: { flagged: Boolean(found.cannibalised), rule: head(kw, st).cannibalisationRule, minImpressions: 5, minPages: 2, competingPages: [] } });
  }
  if (method === 'POST' && rest === 'keywords/move') {
    if (kw.refuseMove) return fail(kw.refuseMove.status, kw.refuseMove.error);
    if (!Array.isArray(body?.keys) || !body.keys.length) return fail(400, 'keys must be a list with at least one keyword');
    if (body.clusterId !== null && !clusterOf(body.clusterId)) return fail(404, 'That cluster does not exist');
    for (const key of body.keys) { const k = kw.keywords.find((x) => x.key === key); if (k) Object.assign(k, { clusterId: body.clusterId, pinned: true }); }
    return ok({ moved: true });
  }
  if (method === 'POST' && rest === 'keywords') {
    if (!Array.isArray(body?.keywords) || !body.keywords.length) return fail(400, 'keywords must be a list with at least one keyword');
    let added = 0;
    for (const text of body.keywords) { const key = String(text).trim().toLowerCase(); if (key && !kw.keywords.some((k) => k.key === key)) { kw.keywords.push({ key, keyword: String(text).trim(), clicks: 0, impressions: 0 }); added++; } }
    return ok({ added, existing: body.keywords.length - added, duplicates: 0, rejected: [] });
  }
  if (method === 'POST' && rest === 'keywords/import') {
    if (typeof body?.csv !== 'string' || !body.csv.trim()) return fail(400, 'the file is empty');
    const lines = body.csv.trim().split('\n').slice(1).filter(Boolean);
    for (const line of lines) kw.keywords.push({ key: line.toLowerCase(), keyword: line, clicks: 0, impressions: 0 });
    return ok({ added: lines.length, existing: 0, duplicates: 0, rejected: [] });
  }
  if (method === 'PATCH' && rest === 'keywords/item') {
    const found = kw.keywords.find((k) => k.key === body?.key);
    if (!found) return fail(404, 'That keyword is not tracked in this Building');
    if (body.status !== undefined && !['tracking', 'target', 'ignored'].includes(body.status)) return fail(400, 'status must be one of tracking, target, ignored');
    Object.assign(found, { ...(body.status ? { status: body.status } : {}), ...('targetPage' in body ? { targetPage: body.targetPage } : {}) });
    return ok(found);
  }
  if (method === 'POST' && rest === 'keywords/clusters') {
    if (!body?.name?.trim()) return fail(400, 'name must be text of 1 to 500 characters');
    if (kw.clusters.some((c) => c.name.toLowerCase() === body.name.trim().toLowerCase())) return fail(409, 'A cluster with that name already exists');
    const cluster = { id: `c${kw.nextId++}`, name: body.name.trim(), pinned: true };
    kw.clusters.push(cluster);
    return ok(cluster, 201);
  }
  if (method === 'POST' && rest === 'keywords/clusters/merge') {
    const target = clusterOf(body?.targetId);
    if (!target) return fail(404, 'That cluster does not exist');
    if ((body.sourceIds ?? []).includes(target.id)) return fail(400, 'a cluster cannot be merged into itself');
    for (const k of kw.keywords) if (body.sourceIds.includes(k.clusterId)) k.clusterId = target.id;
    kw.clusters = kw.clusters.filter((c) => !body.sourceIds.includes(c.id));
    return ok({ merged: true });
  }
  const clusterRoute = rest.match(/^keywords\/clusters\/([^/]+)(\/split)?$/);
  if (clusterRoute) {
    const cluster = clusterOf(decodeURIComponent(clusterRoute[1]));
    if (!cluster) return fail(404, 'That cluster does not exist');
    if (method === 'PATCH') { cluster.name = body.name; cluster.pinned = true; return ok({ renamed: true }); }
    if (method === 'DELETE') { for (const k of kw.keywords) if (k.clusterId === cluster.id) Object.assign(k, { clusterId: null, pinned: false }); kw.clusters = kw.clusters.filter((c) => c !== cluster); return ok({ deleted: true }); }
    if (method === 'POST' && clusterRoute[2]) {
      const created = { id: `c${kw.nextId++}`, name: body.name, pinned: true };
      kw.clusters.push(created);
      for (const k of kw.keywords) if (body.keys.includes(k.key)) Object.assign(k, { clusterId: created.id, pinned: true });
      return ok(created, 201);
    }
  }
  const runRoute = rest.match(/^keywords\/(cluster|research)-run(\/stop)?$/);
  if (runRoute) {
    const kind = runRoute[1];
    if (method === 'GET') return ok(kw.runs[kind]);
    if (runRoute[2]) {
      if (!kw.runs[kind] || !['queued', 'running'].includes(kw.runs[kind].status)) return fail(409, 'No run is in progress');
      kw.runs[kind] = { ...kw.runs[kind], status: 'stopped' };
      return ok(kw.runs[kind]);
    }
    if (kw.runs[kind] && ['queued', 'running'].includes(kw.runs[kind].status)) return fail(409, `A ${kind === 'cluster' ? 'clustering' : 'research'} run is already in progress`);
    if (kind === 'cluster' && !kw.keywords.length) return fail(400, 'There are no keywords to cluster yet');
    kw.runs[kind] = { id: `run${kw.nextId++}`, kind, status: 'running', startedAt: '2026-03-15T12:00:00Z', finishedAt: null, progress: { done: 0, total: kw.keywords.length }, notices: kw.notices ?? [], error: null, adsError: kw.adsError, result: {} };
    return ok(kw.runs[kind], 202);
  }
  if (method === 'GET' && rest === 'keywords/suggestions') return ok({ suggestions: kw.suggestions });
  const suggestionRoute = rest.match(/^keywords\/suggestions\/([^/]+)\/(apply|dismiss)$/);
  if (suggestionRoute) {
    if (!kw.suggestions.some((s) => s.id === suggestionRoute[1])) return fail(404, 'That suggestion does not exist or was already handled');
    kw.suggestions = kw.suggestions.filter((s) => s.id !== suggestionRoute[1]);
    return ok({ ok: true });
  }
  if (method === 'GET' && rest === 'keywords/proposals') return ok({ volumeAvailable: kw.ads, adsError: kw.adsError, market: kw.market, proposals: kw.proposals });
  if (method === 'POST' && (rest === 'keywords/proposals/accept' || rest === 'keywords/proposals/reject')) {
    const accept = rest.endsWith('accept');
    for (const id of body.ids) if (!kw.proposals.some((p) => p.id === id)) return fail(404, 'That proposal does not exist');
    for (const p of kw.proposals) if (body.ids.includes(p.id) && p.status === 'pending') p.status = accept ? 'accepted' : 'rejected';
    return ok(accept ? { accepted: body.ids.length, alreadyAccepted: 0 } : { rejected: body.ids.length });
  }
  if (method === 'PUT' && rest === 'keywords/market') {
    if (!/^\d+$/.test(body?.languageId ?? '')) return fail(400, 'languageId must be the numeric Google Ads id');
    kw.market = { languageId: body.languageId, locationId: body.locationId };
    return ok({ saved: true });
  }
  if (method === 'POST' && rest === 'keywords/volumes/refresh') return kw.ads ? ok({ updated: 1 }) : fail(409, 'Connect Google Ads for volume');
  return null;
}
