/**
 * The Reports routes of the daemon stand-in (server/src/api/seoReportRoutes.ts, server/src/seo/reports.ts), kept apart from
 * serverStub.mjs. It answers with the daemon's shapes and its 400, 404 and 409 refusals. `st.rp.gate` is awaited at the start
 * of every live-report request so a test can hold an older one; `st.rp.setup` makes the Building look empty.
 */
export function seoReportsState(st) {
  st.rp ??= { requests: [], gate: null, setup: false, summaryFail: null, summaryBusy: false, saved: [], schedulerRunning: true, schedules: [], nextId: 1, summaryGate: null };
  return st.rp;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const tile = (key, label, over = {}) => ({
  key, label, unit: 'count', state: 'ok', current: 100, previous: 80, change: 20, changePct: 25, isNew: false, perDay: false, direction: 'up', verdict: 'better', glyph: '▲', missing: null, detail: null, note: null, ...over,
});

export function sampleReport(over = {}) {
  const window = (from, to) => ({ from, to });
  return {
    schema: 1, state: 'ok', site: 'example.com', generatedAt: '2026-10-15T12:00:00.000Z', digest: 'digest-live',
    period: { preset: 'last-28', includePartial: false, requested: { current: window('2026-09-17', '2026-10-14'), previous: window('2026-08-20', '2026-09-16') }, current: window('2026-09-17', '2026-10-14'), previous: window('2026-08-20', '2026-09-16'), oldestRetained: '2025-10-15', clipped: { current: null, previous: null }, trimmedDays: 0, lengths: { current: 28, previous: 28 }, perDay: false, key: 'last-28|a' },
    notes: [], setup: [], coverage: { gsc: { current: 28, previous: 28, total: { current: 28, previous: 28 } }, ga4: { current: 0, previous: 0, total: { current: 28, previous: 28 } } },
    tiles: [tile('clicks', 'Clicks'), tile('position', 'Average position', { unit: 'position', current: 4, previous: 5, change: -1, changePct: -20, direction: 'down', verdict: 'better', glyph: '▼' }), tile('sessions', 'Sessions', { state: 'not-connected', current: null, previous: null, change: null, changePct: null, direction: null, verdict: null, glyph: null })],
    charts: [{ key: 'clicks', label: 'Clicks', unit: 'count', state: 'ok', points: [{ n: 1, current: 1, previous: 2, currentDay: '2026-09-17', previousDay: '2026-08-20' }, { n: 2, current: null, previous: 3, currentDay: '2026-09-18', previousDay: '2026-08-21' }, { n: 3, current: 5, previous: 4, currentDay: '2026-09-19', previousDay: '2026-08-22' }] }],
    minImpressions: 50,
    movers: { pages: { gains: [{ name: 'https://example.com/a', clicksCurrent: 30, clicksPrevious: 10, change: 20, impressions: 500, positionCurrent: 3, positionPrevious: 5, positionChange: -2 }], losses: [], positionGains: [], positionLosses: [], belowThreshold: 0 }, keywords: { gains: [], losses: [], positionGains: [], positionLosses: [], belowThreshold: 2 }, clusters: { gains: [], losses: [], positionGains: [], positionLosses: [], belowThreshold: 0 } },
    backlinks: { available: true, added: [{ sourceUrl: 'https://a.test/x', sourceHost: 'a.test', targetUrl: 'https://example.com/', dr: 60, ur: null, on: '2026-10-01' }], lost: [], addedTotal: 1, lostTotal: 0, coverage: { dr: '1 of 1 links have DR', ur: null } },
    indexing: { available: true, newlyIndexed: ['https://example.com/a'], newlyExcluded: [], newlyIndexedTotal: 1, newlyExcludedTotal: 0 },
    internalLinks: { available: false, reason: 'Needs two crawls: one before the period and one by its end.', added: 0, removed: 0, addedSample: [], removedSample: [], orphansBefore: null, orphansAfter: null, newlyOverLimit: [] },
    work: { tasks: [{ id: 't1', title: 'Fix titles', kind: 'content', at: '2026-10-01' }], agentRuns: [] }, summary: null, ...over,
  };
}

/** Returns `{ status, body }` for a Reports route, or null when the route is not one of them. */
export async function seoReportsRoute(st, method, rest, body, params) {
  const isSchedule = rest === 'schedules' || rest.startsWith('schedules/');
  if (!rest.startsWith('reports') && !isSchedule) return null;
  const rp = seoReportsState(st);
  rp.requests.push({ method, rest, body, query: params.toString() });
  const ok = (value, status = 200) => ({ status, body: value });
  const fail = (status, error) => ({ status, body: { error } });

  if (isSchedule) {
    if (method === 'POST') {
      const job = { id: `job-${rp.nextId++}`, actionId: body.actionId, cadence: body.actionId === 'report-weekly' ? 'weekly' : 'monthly', enabled: true, cron: body.cron, nextRunAt: '2026-10-19T08:00:00.000Z' };
      rp.schedules.push(job);
      return ok(job, 201);
    }
    const job = rp.schedules.find((j) => rest.endsWith(j.id));
    if (!job) return fail(404, 'There is no such scheduled fetch');
    if (method === 'PATCH') { Object.assign(job, body); return ok(job); }
    return null;
  }

  const live = () => {
    const from = params.get('from');
    const to = params.get('to');
    if (params.get('preset') === 'custom') {
      if (!ISO.test(from ?? '') || !ISO.test(to ?? '')) return fail(400, 'from and to must be dates written YYYY-MM-DD');
      if (from > to) return fail(400, 'from must not be after to');
    }
    return null;
  };

  if (method === 'GET' && rest === 'reports/live') {
    await rp.gate?.(params);
    const bad = live();
    if (bad) return bad;
    if (rp.setup) return ok(sampleReport({ state: 'setup', tiles: [], charts: [], setup: ['Connect Search Console in Connections.'] }));
    return ok(sampleReport({ digest: `digest-${params.get('preset')}`, period: { ...sampleReport().period, preset: params.get('preset') } }));
  }
  if (method === 'POST' && rest === 'reports/summary') {
    if (rp.summaryBusy) return fail(409, 'A summary is already being written');
    await rp.summaryGate?.();
    if (rp.summaryFail) return fail(502, rp.summaryFail);
    return ok({ paragraph: 'Clicks grew.', actions: ['Refresh the top page.'], generatedAt: '2026-10-15T12:00:00.000Z', periodKey: 'last-28|a', digest: `digest-${body.preset ?? 'last-28'}`, label: 'AI-generated' });
  }
  if (method === 'GET' && rest === 'reports/schedule') return ok({ available: rp.schedulerRunning, schedules: rp.schedules });
  if (method === 'GET' && rest === 'reports') return ok({ reports: rp.saved.map(({ report, ...meta }) => meta).reverse() });
  if (method === 'POST' && rest === 'reports') {
    if (rp.setup) return fail(409, 'There is nothing to report yet: connect a source first');
    if ([...(body.name ?? '')].length > 80) return fail(400, 'name must be at most 80 characters');
    const id = `r${rp.nextId++}`;
    const report = sampleReport({ summary: body.summary ?? null });
    rp.saved.push({ id, name: body.name || '2026-09-17 to 2026-10-14', source: 'manual', savedAt: '2026-10-15T12:00:00.000Z', periodKey: 'k', from: '2026-09-17', to: '2026-10-14', hasSummary: Boolean(body.summary), report });
    return ok(rp.saved.at(-1) && { id, name: rp.saved.at(-1).name, source: 'manual', savedAt: '2026-10-15T12:00:00.000Z', periodKey: 'k', from: '2026-09-17', to: '2026-10-14', hasSummary: Boolean(body.summary) }, 201);
  }
  const item = rest.match(/^reports\/([^/]+)$/);
  if (item && method === 'GET') {
    const found = rp.saved.find((r) => r.id === item[1]);
    return found ? ok(found) : fail(404, 'There is no such saved report');
  }
  if (item && method === 'DELETE') {
    if (!rp.saved.some((r) => r.id === item[1])) return fail(404, 'There is no such saved report');
    rp.saved = rp.saved.filter((r) => r.id !== item[1]);
    return { status: 204, body: undefined };
  }
  return fail(404, 'Not found');
}
