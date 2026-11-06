/**
 * The SEO Backlinks routes of the daemon stand-in (server/src/api/seoRoutes.ts, server/src/seo/backlinks.ts), kept apart from
 * serverStub.mjs. It keeps one in-memory link list per Building and answers with the daemon's shapes and its 400, 404, 409
 * and 413 refusals. `st.bl.gate` is awaited at the start of every list request so a test can hold an older one.
 */
export function seoBacklinksState(st) {
  st.bl ??= { links: [], batches: [], mappings: [], requests: [], gate: null, refuseCommit: null, hasImports: false };
  return st.bl;
}

const summary = (links) => {
  const live = links.filter((l) => l.status !== 'lost');
  const withDr = live.filter((l) => l.sourceDr !== null);
  return { total: live.length, referringDomains: new Set(live.map((l) => l.sourceHost)).size, newInPeriod: live.length, lostInPeriod: links.length - live.length, averageDr: withDr.length ? withDr.reduce((t, l) => t + l.sourceDr, 0) / withDr.length : null, withDr: withDr.length };
};

export async function seoBacklinksRoute(st, method, rest, body, params) {
  if (!rest.startsWith('backlinks')) return null;
  const bl = seoBacklinksState(st);
  bl.requests.push({ method, rest, body, query: params.toString() });
  const ok = (value, status = 200) => ({ status, body: value });
  const fail = (status, error) => ({ status, body: { error } });

  if (method === 'GET' && rest === 'backlinks') {
    await bl.gate?.(params);
    const search = params.get('search')?.toLowerCase();
    const links = bl.links.filter((l) => !search || l.sourceUrl.toLowerCase().includes(search));
    const offset = Number(params.get('offset') ?? 0);
    const limit = Number(params.get('limit') ?? 50);
    return ok({ links: links.slice(offset, offset + limit), total: links.length, limit, offset });
  }
  if (method === 'GET' && rest === 'backlinks/overview') return ok({ summary: summary(bl.links), period: Number(params.get('period') ?? 28), hasImports: bl.batches.length > 0 });
  if (method === 'GET' && rest === 'backlinks/domains') return ok({ domains: [] });
  if (method === 'GET' && rest === 'backlinks/targets') return ok({ targets: [] });
  if (method === 'GET' && rest === 'backlinks/batches') return ok({ batches: bl.batches });
  if (method === 'GET' && rest === 'backlinks/mappings') return ok({ mappings: bl.mappings });
  if (method === 'POST' && (rest === 'backlinks/import/preview' || rest === 'backlinks/import')) {
    if (!/\.(csv|tsv|txt)$/i.test(body.fileName ?? '')) return fail(400, 'That is not a CSV or TSV file. Export the links as .csv or .tsv.');
    if (body.content.length > 1000) return fail(413, 'The file is larger than the 15 MB limit.');
    if (rest.endsWith('preview')) {
      return ok({ encoding: 'utf-8', delimiter: ',', headers: ['a', 'b'], rows: 2, presets: [], suggested: body.format === 'manual' ? null : 'ahrefs', needsMapping: body.format === 'manual' && !body.mapping, mapping: { sourceUrl: 'a', targetUrl: 'b' }, valid: 2, invalid: 0, duplicates: 0, problems: [], problemsTotal: 0, willBeLost: body.mode === 'full' ? 1 : 0, sample: [] });
    }
    if (bl.refuseCommit) return fail(409, bl.refuseCommit);
    if (body.mode !== 'full' && body.mode !== 'partial') return fail(400, 'Say whether the file is a full export or a partial update.');
    const batch = { seq: bl.batches.length + 1, uid: `b${bl.batches.length + 1}`, fileName: body.fileName, mode: body.mode, importedAt: '2026-10-14T12:00:00Z', fileRows: 1, added: 1, updated: 0, unchanged: 0, lost: 0, returned: 0, skipped: 0 };
    bl.batches.unshift(batch);
    bl.links.push({ uid: `l${bl.links.length + 1}`, sourceUrl: 'https://a.com/p', sourceHost: 'a.com', targetUrl: 'https://example.com/', anchor: 'hi', linkType: null, firstSeen: '2026-10-01', lastSeen: '2026-10-10', status: 'new', lostAt: null, sourceDr: null, sourceUr: null, sourceTraffic: null, pageDr: null, pageUr: null, pageTraffic: null, otherHost: false, extras: {}, note: '' });
    return ok({ batch, counts: { added: 1, updated: 0, unchanged: 0, lost: 0, returned: 0 }, skipped: 0 }, 201);
  }
  const item = rest.match(/^backlinks\/([^/]+)(\/note)?$/);
  if (item && method === 'PUT' && item[2]) {
    const link = bl.links.find((l) => l.uid === item[1]);
    if (!link) return fail(404, 'There is no such backlink.');
    if ((body.note ?? '').length > 2000) return fail(400, 'A note can be at most 2,000 characters.');
    link.note = (body.note ?? '').trim();
    return ok({ note: link.note });
  }
  if (item && method === 'DELETE' && !item[2]) {
    if (!bl.links.some((l) => l.uid === item[1])) return fail(404, 'There is no such backlink.');
    bl.links = bl.links.filter((l) => l.uid !== item[1]);
    return { status: 204, body: undefined };
  }
  return null;
}
