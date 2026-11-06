/**
 * The Content Studio routes of the daemon stand-in (server/src/api/contentRoutes.ts), kept apart from serverStub.mjs.
 * One in-memory Building state per id. `CONTENT_ROUTES` lists every route the daemon serves so a test can check the
 * stand-in answers each one; `state.requests` records what arrived (method, path, body).
 */
import { assetsNeeded, isConceptAssetKind, postNeeds } from '../src/lib/contentRules.ts';
import { emptyTargets, evaluatePost, engagementRateOf, TARGET_FIELDS } from '../src/lib/contentTargets.ts';

export const CONTENT_ROUTES = [
  ['GET', 'concepts'], ['POST', 'concepts'], ['GET', 'concepts/:cid'], ['PATCH', 'concepts/:cid'], ['DELETE', 'concepts/:cid'],
  ['POST', 'concepts/:cid/posts'], ['PATCH', 'concepts/:cid/posts/:pid'], ['DELETE', 'concepts/:cid/posts/:pid'],
  ['POST', 'concepts/:cid/posts/:pid/finalize'], ['POST', 'concepts/:cid/posts/:pid/unfinalize'], ['GET', 'calendar'],
  ['POST', 'concepts/:cid/posts/:pid/publish'], ['PATCH', 'concepts/:cid/posts/:pid/publish'], ['POST', 'concepts/:cid/posts/:pid/unpublish'],
  ['GET', 'concepts/:cid/posts/:pid/media'], ['GET', 'concepts/:cid/posts/:pid/media/images/:index'], ['GET', 'concepts/:cid/posts/:pid/media/images.zip'], ['GET', 'concepts/:cid/posts/:pid/media/video'], ['GET', 'concepts/:cid/posts/:pid/media/thumbnail'],
  ['GET', 'concepts/:cid/posts/:pid/stats'], ['POST', 'concepts/:cid/posts/:pid/stats'], ['PATCH', 'concepts/:cid/posts/:pid/stats/:statId'], ['DELETE', 'concepts/:cid/posts/:pid/stats/:statId'],
  ['GET', 'concepts/:cid/posts/:pid/stats/:statId/sources/:sourceId'], ['POST', 'concepts/:cid/posts/:pid/stats/extractions'], ['DELETE', 'concepts/:cid/posts/:pid/stats/extractions/:eid'],
  ['GET', 'concepts/:cid/assets/:aid/session'], ['POST', 'concepts/:cid/assets/:aid/session'], ['POST', 'concepts/:cid/assets/:aid/session/new-round'],
  ['POST', 'concepts/:cid/assets/:aid/session/resume'], ['POST', 'concepts/:cid/assets/:aid/session/comment'], ['POST', 'concepts/:cid/assets/:aid/finalize'], ['POST', 'concepts/:cid/assets/:aid/reopen'], ['GET', 'concepts/:cid/assets/:aid/drafts'],
  ['GET', 'concepts/:cid/media'], ['POST', 'concepts/:cid/media'], ['PATCH', 'concepts/:cid/media/:mid'], ['DELETE', 'concepts/:cid/media/:mid'],
  ['GET', 'concepts/:cid/media/:mid/file'], ['GET', 'concepts/:cid/media/:mid/thumbnail'],
  ['GET', 'concepts/:cid/video/checklist'], ['PATCH', 'concepts/:cid/video/checklist/:itemId'], ['POST', 'concepts/:cid/video/confirm'],
  ['GET', 'concepts/:cid/video/renders'], ['GET', 'concepts/:cid/video/renders/:rid/file'], ['POST', 'concepts/:cid/video/renders/:rid/stop'],
  ['GET', 'assets/:aid/images/rounds/:round/:file'], ['GET', 'assets/:aid/images/rounds/:round/images.zip'], ['POST', 'assets/:aid/images/renders/:rid/stop'],
  ['GET', 'assets/:aid/thumbnail/rounds/:round/:file'], ['POST', 'assets/:aid/thumbnail/renders/:rid/stop'],
  ['GET', 'remotion/studio'], ['POST', 'remotion/studio/start'], ['POST', 'remotion/studio/stop'], ['POST', 'remotion/studio/heartbeat'],
  ['GET', 'settings'], ['PATCH', 'settings'], ['DELETE', 'settings/speaking-speed'], ['GET', 'speaking-rate-samples'], ['DELETE', 'speaking-rate-samples/:sid'],
  ['GET', 'targets'], ['PUT', 'targets/:platform'], ['GET', 'targets/history'],
  ['GET', 'insights'], ['POST', 'insights/refresh'], ['POST', 'insights/stop'], ['GET', 'insights/history'], ['PUT', 'insights/notes'],
  ['GET', 'knowledge/sections'], ['POST', 'knowledge/sections'], ['GET', 'knowledge/sections/:sid'], ['PUT', 'knowledge/sections/:sid'], ['DELETE', 'knowledge/sections/:sid'],
  ['GET', 'knowledge/colours'], ['PUT', 'knowledge/colours'], ['GET', 'knowledge/files'], ['POST', 'knowledge/files'], ['GET', 'knowledge/files/:name'], ['DELETE', 'knowledge/files/:name'],
  ['GET', 'writing-style'], ['PUT', 'writing-style'], ['GET', 'writing-style/history'],
  ['GET', 'import-session'], ['POST', 'import-session'], ['POST', 'import-session/resume'], ['POST', 'import-session/new'], ['POST', 'import-session/end'], ['GET', 'concepts/:cid/learn'], ['POST', 'concepts/:cid/learn'],
  ['GET', 'retros'], ['POST', 'assets/:aid/retro'], ['GET', 'style-proposals'], ['POST', 'style-proposals/:prid/accept'], ['POST', 'style-proposals/:prid/discard'],
];

// Small stand-ins for the web helpers: this file loads in tests that register no extensionless-import hook.
const placedAt = (p) => (p.status === 'published' && p.publishedAt ? p.publishedAt : p.scheduledAt);
const FIELDS = ['impressions', 'reach', 'views', 'likes', 'comments', 'shares', 'saves', 'linkClicks', 'profileVisits', 'followersGained'];
const sortedStats = (list) => [...list].sort((a, z) => Date.parse(z.capturedAt) - Date.parse(a.capturedAt) || Date.parse(z.enteredAt) - Date.parse(a.enteredAt));
function latestAndPrevious(list) {
  const [latest = null, previous = null] = sortedStats(list);
  const delta = latest && previous ? Object.fromEntries(FIELDS.map((k) => [k, latest.counts[k] === null || previous.counts[k] === null ? null : latest.counts[k] - previous.counts[k]])) : null;
  return { latest, delta };
}
const conceptViews = (c) => c.posts.reduce((best, p) => {
  const counts = p.status === 'published' ? p.stats?.latest?.counts : null;
  const v = counts ? (counts.views ?? counts.impressions) : null;
  return v !== null && v !== undefined && (best === null || v > best) ? v : best;
}, null);

export function createContentStudioState() {
  return { byBuilding: new Map(), requests: [], nextId: 1, readOnly: false, delays: {}, answers: {}, studio: { agent: true, rev: 0, panes: new Map() }, media: new Map(),
    // Remotion Studio, one per Building: `notContent` Buildings answer 404, `needsInstall` refuses a read-only start, `startAs` is the state a start reaches.
    remotion: { byBuilding: new Map(), spawns: 0, notContent: new Set(), needsInstall: false, startAs: 'running' } };
}

const buildingOf = (st, id) => {
  if (!st.byBuilding.has(id)) {
    st.byBuilding.set(id, {
      timezone: 'UTC', name: 'Brand', concepts: [], files: [], colours: [], style: { content: '# Writing style\n', version: 'v1' }, history: [],
      // Retro: `proposals` are pending ones, newest first; a test sets `staleIds` to make accept refuse those changes.
      proposals: [], retroLog: [], staleIds: [], retrosRunning: new Set(), autoApplyRetro: false,
      // Import session: `agent` false refuses a start the way a missing default agent does. `learn` holds each Concept's last run.
      imports: { agent: true, rev: 0, session: null, savedIds: [], blockedReason: null }, learn: new Map(),
      targets: Object.fromEntries(['linkedin', 'instagram', 'x', 'facebook', 'blog'].map((p) => [p, emptyTargets()])), targetHistory: [], evaluationDays: 7,
      // Insights: `state` is what the server reports; a test sets `lastError` or `nextRefreshAt`.
      insights: { state: 'never-run', markdown: '', notes: '', notesVersion: 'n0', lastError: null, updatedAt: null, postCount: null, nextRefreshAt: null, history: [] },
      sections: [{ id: 'about', name: 'About the business', builtin: true, file: 'about.md', content: '', version: 'v1', changedAt: '2026-10-26T10:00:00.000Z' }],
    });
  }
  return st.byBuilding.get(id);
};

const asset = (st, kind, postId = null) => ({ id: `a${st.nextId++}`, kind, postId, state: 'empty', content: null, finalizedAt: null, round: 0 });
const view = (c) => ({
  ...c,
  posts: c.posts.map((p) => {
    const assetOf = (kind) => (isConceptAssetKind(kind) ? c.assets.find((a) => a.kind === kind) : p.own.find((a) => a.kind === kind));
    return { ...p, needs: postNeeds(p.platform, p.format, !!c.imported, (kind) => assetOf(kind)?.state).map(assetOf) };
  }),
});
let active = null;
const resultOf = (p) => {
  if (p.status !== 'published' || !active) return null;
  const snapshots = sortedStats(p.statList).map((x) => ({ capturedAt: Date.parse(x.capturedAt), counts: { impressions: null, views: null, likes: null, comments: null, shares: null, saves: null, followersGained: null, ...x.counts } }));
  const result = evaluatePost({ platform: p.platform, publishedAt: Date.parse(p.publishedAt), snapshots, targets: active.targets[p.platform], windowDays: active.evaluationDays, now: Date.parse(active.now ?? '2026-10-27T12:00:00.000Z') });
  return { ...result, engagementRate: snapshots[0] ? engagementRateOf(p.platform, snapshots[0].counts) : null };
};
const publicConcept = (c) => {
  const v = view(c);
  const needed = v.posts.reduce((n, p) => n + p.needs.length, 0);
  const finalized = v.posts.reduce((n, p) => n + p.needs.filter((a) => a.state === 'finalized').length, 0);
  const posts = v.posts.map(({ own: _own, statList, ...p }) => {
    const { latest, delta } = latestAndPrevious(statList);
    return { ...p, stats: p.status === 'published' ? { count: statList.length, latest, delta } : null, result: resultOf({ ...p, statList }) };
  });
  return { ...v, posts, progress: { finalized, needed }, compositionId: c.compositionId ?? null };
};

export async function contentStudioRoute(st, buildingId, method, rest, body, params) {
  const b = buildingOf(st, buildingId);
  active = b;
  const path = rest.split('?')[0];
  st.requests.push({ method, path, body, query: params.toString() });
  const ok = (value, status = 200) => ({ status, body: value });
  const refuse = (status, error, extra = {}) => ({ status, body: { error, ...extra } });
  if (path.startsWith('remotion/studio')) return remotionStudioRoute(st, b, buildingId, method, path, ok, refuse);
  if (method !== 'GET' && st.readOnly) return refuse(409, 'This Building is read-only.');
  const gate = st.delays[`${method} ${path}`];
  if (gate) await gate(params);
  const forced = st.answers[`${method} ${path}`];
  if (forced) return forced(body, params);

  const mk = (input, now) => {
    const id = `c${st.nextId++}`;
    const c = { id, title: input.title, brief: input.brief ?? '', archived: false, createdAt: now, updatedAt: now, posts: [], assets: [asset(st, 'script'), asset(st, 'video')] };
    for (const p of input.posts ?? []) addPost(c, p, now);
    return c;
  };
  const addPost = (c, input, now) => {
    const post = { id: `p${st.nextId++}`, conceptId: c.id, platform: input.platform, format: input.format, scheduledAt: input.scheduledAt, status: 'draft', note: null, createdAt: now, own: [], publishedAt: null, liveUrl: null, statList: [] };
    for (const kind of assetsNeeded(input.platform, input.format)) {
      if (!isConceptAssetKind(kind)) post.own.push(asset(st, kind, post.id));
      else if (!c.assets.some((a) => a.kind === kind)) c.assets.push(asset(st, kind));
    }
    c.posts.push(post);
    return post;
  };
  const stamp = () => new Date(1_790_000_000_000 + st.nextId * 1000).toISOString();

  if (path === 'concepts') {
    if (method === 'POST') {
      if (!body?.title) return refuse(400, 'title is required', { field: 'title' });
      const c = mk(body, stamp());
      b.concepts.unshift(c);
      return ok(publicConcept(c), 201);
    }
    let rows = b.concepts.filter((c) => c.archived === (params.get('archived') === 'true'));
    if (params.get('status')) rows = rows.filter((c) => c.posts.some((p) => p.status === params.get('status')));
    if (params.get('platform')) rows = rows.filter((c) => c.posts.some((p) => p.platform === params.get('platform')));
    if (params.get('imported')) rows = rows.filter((c) => !!c.imported === (params.get('imported') === 'true'));
    const q = params.get('q')?.toLowerCase();
    if (q) rows = rows.filter((c) => `${c.title} ${c.brief}`.toLowerCase().includes(q));
    if (params.get('sort') === 'views') rows = rows.map((c, i) => ({ c, i, v: conceptViews(publicConcept(c)) ?? -1 })).sort((a, z) => z.v - a.v || a.i - z.i).map((x) => x.c);
    const overall = (p) => resultOf(p)?.overall;
    const summary = ['linkedin', 'instagram', 'x', 'facebook', 'blog'].map((platform) => {
      const mine = rows.flatMap((c) => c.posts).filter((p) => p.status === 'published' && p.platform === platform).map(overall);
      return { platform, judged: mine.filter((o) => ['on-target', 'partly', 'below-target'].includes(o)).length, onTarget: mine.filter((o) => o === 'on-target').length, tooEarly: mine.filter((o) => o === 'too-early').length, noTarget: mine.filter((o) => o === 'no-target').length };
    });
    const wanted = params.get('result');
    if (wanted) {
      if (!['on-target', 'partly', 'below-target', 'too-early', 'no-target'].includes(wanted)) return refuse(400, 'result must be on-target, partly, below-target, too-early or no-target', { field: 'result' });
      rows = rows.filter((c) => c.posts.some((p) => overall(p) === wanted));
    }
    const limit = Math.min(Number(params.get('limit') ?? 50), 200), offset = Number(params.get('offset') ?? 0);
    return ok({ rows: rows.slice(offset, offset + limit).map(publicConcept), total: rows.length, limit, offset, hasMore: offset + limit < rows.length, summary });
  }
  const studioMatch = path.match(/^concepts\/([^/]+)\/assets\/([^/]+)\/(session\/new-round|session\/resume|session\/comment|session|finalize|reopen|drafts)$/);
  if (studioMatch) {
    const [, cid, aid, verb] = studioMatch;
    const c = b.concepts.find((x) => x.id === cid);
    const owner = c?.posts.find((p) => p.own.some((x) => x.id === aid));
    const a = c && [...c.assets, ...c.posts.flatMap((p) => p.own)].find((x) => x.id === aid);
    if (!a) return refuse(404, 'That asset does not exist');
    // The daemon's studio tabs: the script, a post's text, a blog post's article, the video and a post's image set.
    const tab = a.kind === 'script' ? 'script' : a.kind === 'video' ? 'video' : a.kind === 'article' ? 'blog' : a.kind === 'image-set' ? 'images' : a.kind === 'thumbnail' ? 'thumbnail' : a.kind === 'post-text' ? (owner.platform === 'instagram' ? 'captions' : 'post-content') : null;
    if (!tab) return refuse(404, 'This asset has no agent pane');
    const pane = videoPane(st, aid);
    st.studio.panes.set(aid, pane);
    const current = () => pane.rounds[pane.rounds.length - 1] ?? null;
    const startRound = (round) => { pane.rounds.push({ round, id: `s${st.nextId++}`, state: 'running', startedAt: stamp() }); };
    const present = () => ({
      rev: ++st.studio.rev, conceptId: cid, assetId: aid,
      asset: { state: a.state, round: a.round, finalizedAt: a.finalizedAt, content: a.state === 'finalized' ? a.content : null },
      session: current() && { id: current().id, conceptId: cid, assetId: aid, tab, round: current().round, state: current().state, executorId: 'agent', createdAt: current().startedAt, updatedAt: current().startedAt },
      rounds: pane.rounds.map((r) => { const d = pane.drafts.filter((x) => x.round === r.round).at(-1); return { round: r.round, startedAt: r.startedAt, draft: d ? { text: d.text, savedAt: d.savedAt } : null }; }),
      skillWarning: pane.skillWarning ?? null,
      blockedReason: pane.rounds.length ? null : pane.blockedReason ?? null,
      retro: pane.retro ?? null,
      ...(a.kind === 'video' && { video: videoPart(st, buildingId, cid, a, pane) }),
      ...(a.kind === 'image-set' && { images: imagesPart(buildingId, a, owner, pane) }),
      ...(a.kind === 'thumbnail' && { thumbnail: thumbnailPart(a, pane) }),
    });
    if (verb === 'session' && method === 'GET') return ok(present());
    if (verb === 'drafts') return ok({ rounds: pane.rounds.map((r) => ({ round: r.round, drafts: pane.drafts.filter((x) => x.round === r.round) })) });
    if (verb === 'finalize' && a.kind === 'video') {
      const done = pane.renders.filter((r) => r.round === a.round && r.status === 'done')[0];
      if (a.state === 'finalized' || !done) return refuse(409, 'Render the video at least once before finalizing.');
      Object.assign(a, { state: 'finalized', content: done.id, finalizedAt: stamp() });
      if (current()) current().state = 'ended';
      return ok(present());
    }
    if (verb === 'finalize' && a.kind === 'thumbnail') {
      const r = pane.imageRounds.get(a.round);
      const reason = a.state === 'finalized' ? 'This is finalized. Reopen it to work on it again.' : thumbnailBlocker(r);
      if (reason) return refuse(409, reason);
      // Mirrors server parseChosenThumbnail: the file must be one of the last render's thumbnails.
      if (typeof body?.file !== 'string' || !r.images.some((i) => i.name === body.file)) return refuse(400, "file must be one of the last render's thumbnails", { field: 'file' });
      const chosen = r.images.find((i) => i.name === body.file);
      Object.assign(a, { state: 'finalized', content: JSON.stringify([`thumbnail/round-${a.round}/${chosen.name}`]), finalizedAt: stamp() });
      if (current()) current().state = 'ended';
      return ok(present());
    }
    if (verb === 'finalize' && a.kind === 'image-set') {
      const reason = a.state === 'finalized' ? 'This is finalized. Reopen it to work on it again.' : imagesBlocker(owner, pane.imageRounds.get(a.round));
      if (reason) return refuse(409, reason);
      const r = pane.imageRounds.get(a.round);
      Object.assign(a, { state: 'finalized', content: JSON.stringify(r.images.map((i) => `posts/${owner.id}/images/round-${a.round}/${i.name}`)), finalizedAt: stamp() });
      if (current()) current().state = 'ended';
      return ok(present());
    }
    if (verb === 'finalize') {
      const d = pane.drafts.filter((x) => x.round === a.round).at(-1);
      if (a.state === 'finalized' || !d) return refuse(409, 'Save a draft before finalizing.');
      Object.assign(a, { state: 'finalized', content: d.text, finalizedAt: stamp() });
      if (current()) current().state = 'ended';
      return ok(present());
    }
    if (verb === 'reopen') {
      if (a.state !== 'finalized') return refuse(409, 'Only a finalized asset can be reopened.');
      Object.assign(a, { state: 'drafting', round: a.round + 1, finalizedAt: null });
      startRound(a.round);
      return ok(present());
    }
    if (a.state === 'finalized') return refuse(409, 'This is finalized. Reopen it to work on it again.');
    if (verb === 'session/comment') {
      if (typeof body?.comment !== 'string' || !body.comment.trim()) return refuse(400, 'Write a comment before sending it', { field: 'comment' });
      if (current()?.state !== 'running') return refuse(409, 'The agent session has ended. Press Resume, then send the comment again.');
      return ok({ line: body.line, sentAt: stamp() });
    }
    if (!st.studio.agent) {
      pane.blockedReason = 'No default coding agent is set. Set one as the default coding agent to start a writing session.';
      return refuse(409, pane.blockedReason);
    }
    pane.blockedReason = null;
    if (verb === 'session') {
      if (current()) return refuse(409, 'A session is already running for this asset.');
      Object.assign(a, { state: 'drafting', round: 1 });
      // A video session scaffolds the Concept's composition in the shared Remotion project.
      if (a.kind === 'video') c.compositionId = `concept-${cid}`;
      startRound(1);
      return ok(present(), 201);
    }
    if (verb === 'session/new-round') { if (current()) current().state = 'ended'; a.round += 1; startRound(a.round); pane.checklist = { items: [], confirmedAt: null }; return ok(present()); }
    if (verb === 'session/resume') { if (!current()) return refuse(404, 'There is no session to resume'); current().state = 'running'; return ok(present()); }
  }
  const thumbMatch = path.match(/^assets\/([^/]+)\/thumbnail\/(rounds\/([^/]+)\/([^/]+)|renders\/([^/]+)\/stop)$/);
  if (thumbMatch) {
    const [, aid, , round, file, rid] = thumbMatch;
    const a = b.concepts.flatMap((c) => c.assets).find((x) => x.id === aid && x.kind === 'thumbnail');
    if (!a) return refuse(404, 'That thumbnail does not exist');
    const pane = videoPane(st, aid);
    if (rid) {
      const r = [...pane.imageRounds.values()].find((x) => x.call?.id === rid);
      if (!r) return refuse(404, 'That render does not exist');
      if (r.call.status !== 'running' && r.call.status !== 'queued') return refuse(409, 'That render is not running or waiting');
      Object.assign(r.call, { status: 'stopped', error: 'The render was stopped' });
      return ok(r.call);
    }
    const r = /^[1-9]\d*$/.test(round) ? pane.imageRounds.get(Number(round)) : undefined;
    const thumb = /^thumb-\d{2}\.png$/.test(file) ? r?.images.find((i) => i.name === file) : undefined;
    return thumb ? ok({ png: thumb.name }) : refuse(404, 'That thumbnail does not exist');
  }
  const imagesMatch = path.match(/^assets\/([^/]+)\/images\/(rounds\/([^/]+)\/([^/]+)|renders\/([^/]+)\/stop)$/);
  if (imagesMatch) {
    const [, aid, , round, file, rid] = imagesMatch;
    const a = b.concepts.flatMap((c) => c.posts.flatMap((p) => p.own)).find((x) => x.id === aid && x.kind === 'image-set');
    if (!a) return refuse(404, 'That image set does not exist');
    const pane = videoPane(st, aid);
    if (rid) {
      const r = [...pane.imageRounds.values()].find((x) => x.call?.id === rid);
      if (!r) return refuse(404, 'That render does not exist');
      if (r.call.status !== 'running' && r.call.status !== 'queued') return refuse(409, 'That render is not running or waiting');
      Object.assign(r.call, { status: 'stopped', error: 'The render was stopped' });
      return ok(r.call);
    }
    const r = /^\d+$/.test(round) ? pane.imageRounds.get(Number(round)) : undefined;
    if (file === 'images.zip') return r?.images.length ? ok({ zip: r.images.map((i) => i.name) }) : refuse(404, 'There are no images to download');
    const image = /^image-\d{2}\.png$/.test(file) ? r?.images.find((i) => i.name === file) : undefined;
    return image ? ok({ png: image.name }) : refuse(404, 'That image does not exist');
  }
  const videoMatch = path.match(/^concepts\/([^/]+)\/(media|video)(?:\/(.+))?$/);
  if (videoMatch) return videoRoute(st, b, buildingId, method, videoMatch[1], videoMatch[2], videoMatch[3] ?? '', body, params, ok, refuse, stamp);
  const postMatch = path.match(/^concepts\/([^/]+)\/posts\/([^/]+)\/(publish|unpublish|media(?:\/.+)?|stats(?:\/.+)?)$/);
  if (postMatch) {
    const [, cid, pid, verb] = postMatch;
    const c = b.concepts.find((x) => x.id === cid);
    const post = c?.posts.find((x) => x.id === pid);
    if (!post) return refuse(404, 'That post does not exist');
    const mine = () => publicConcept(c).posts.find((x) => x.id === pid);
    const future = (value) => Date.parse(value) > Date.now() + 5 * 60_000;
    if (verb === 'publish' && method === 'POST') {
      if (post.status !== 'finalized') return refuse(409, `A ${post.status} post cannot be published`);
      if (body?.liveUrl && !/^https?:\/\/.+/.test(body.liveUrl)) return refuse(400, 'liveUrl must be an http or https URL', { field: 'liveUrl' });
      if (body?.publishedAt && future(body.publishedAt)) return refuse(400, 'publishedAt cannot be in the future', { field: 'publishedAt' });
      Object.assign(post, { status: 'published', liveUrl: body?.liveUrl ?? null, publishedAt: body?.publishedAt ?? new Date().toISOString() });
      return ok(mine());
    }
    if (verb === 'publish' && method === 'PATCH') {
      if (post.status !== 'published') return refuse(409, `A ${post.status} post cannot be edited`);
      if (body?.liveUrl && !/^https?:\/\/.+/.test(body.liveUrl)) return refuse(400, 'liveUrl must be an http or https URL', { field: 'liveUrl' });
      if (body?.publishedAt && future(body.publishedAt)) return refuse(400, 'publishedAt cannot be in the future', { field: 'publishedAt' });
      if (body?.liveUrl !== undefined) post.liveUrl = body.liveUrl;
      if (body?.publishedAt) post.publishedAt = body.publishedAt;
      return ok(mine());
    }
    if (verb === 'unpublish') {
      if (post.status !== 'published') return refuse(409, `A ${post.status} post cannot be unpublished`);
      Object.assign(post, { status: 'finalized', liveUrl: null, publishedAt: null });
      return ok(mine());
    }
    if (verb === 'media') {
      const needs = view(c).posts.find((x) => x.id === pid).needs;
      const text = needs.find((a) => a.kind === 'post-text' || a.kind === 'article');
      return ok({ text: text?.content ?? null, images: needs.some((a) => a.kind === 'image-set') ? (post.media ?? []) : null, video: post.video ?? null, thumbnail: post.thumbnail ?? null });
    }
    if (verb.startsWith('media/')) return ok({ name: verb });
    if (post.status !== 'published' && verb.startsWith('stats') && method !== 'GET') return refuse(409, `Stats can only be added to a published post, and this one is ${post.status}`);
    const sort = () => post.statList.sort((a, z) => Date.parse(z.capturedAt) - Date.parse(a.capturedAt) || Date.parse(z.enteredAt) - Date.parse(a.enteredAt));
    if (verb === 'stats') {
      if (method === 'GET') return ok({ snapshots: sort() });
      const hasCount = Object.values(body?.counts ?? {}).some((v) => v !== null && v !== undefined);
      if (!hasCount) return refuse(400, 'Enter at least one count', { field: 'counts' });
      if (!body.capturedAt || future(body.capturedAt) || Date.parse(body.capturedAt) < Date.parse(post.publishedAt)) return refuse(400, 'capturedAt is not valid', { field: 'capturedAt' });
      const kept = body.extractionId ? b.extractions?.get(body.extractionId) : null;
      if (body.extractionId && !kept) return refuse(404, 'That extraction does not exist');
      if (kept) b.extractions.delete(body.extractionId);
      const stat = { id: `s${st.nextId++}`, capturedAt: body.capturedAt, enteredAt: stamp(), counts: Object.fromEntries(['impressions', 'reach', 'views', 'likes', 'comments', 'shares', 'saves', 'linkClicks', 'profileVisits', 'followersGained'].map((k) => [k, body.counts[k] ?? null])), watchTime: body.watchTime ?? null, note: body.note ?? '', sources: kept ?? [] };
      post.statList.push(stat);
      return ok(stat, 201);
    }
    if (verb === 'stats/extractions' && method === 'POST') {
      st.extractions = st.extractions ?? [];
      st.extractions.push({ text: body?.get?.('text') ?? '', images: body?.getAll?.('images')?.length ?? 0 });
      const answer = st.answers.extraction;
      if (answer && answer.ok === false) return ok(answer);
      const id = `e${st.nextId++}`;
      b.extractions = b.extractions ?? new Map();
      b.extractions.set(id, []);
      return ok({ ok: true, extractionId: id, counts: answer?.counts ?? { views: 1200 }, capturedAt: answer?.capturedAt ?? null, unused: answer?.unused ?? [] });
    }
    const extractionMatch = verb.match(/^stats\/extractions\/([^/]+)$/);
    if (extractionMatch && method === 'DELETE') {
      st.discarded = [...(st.discarded ?? []), extractionMatch[1]];
      if (!b.extractions?.delete(extractionMatch[1])) return refuse(404, 'That extraction does not exist');
      return ok(undefined, 204);
    }
    const sourceMatch = verb.match(/^stats\/([^/]+)\/sources\/([^/]+)$/);
    if (sourceMatch) return post.statList.some((x) => x.id === sourceMatch[1]) ? ok({ name: sourceMatch[2] }) : refuse(404, 'That snapshot does not exist');
    const statMatch = verb.match(/^stats\/([^/]+)$/);
    const stat = statMatch && post.statList.find((x) => x.id === statMatch[1]);
    if (!stat) return refuse(404, 'That stats snapshot does not exist');
    if (method === 'DELETE') { post.statList = post.statList.filter((x) => x !== stat); return ok(undefined, 204); }
    const counts = { ...stat.counts, ...(body.counts ?? {}) };
    if (Object.values(counts).every((v) => v === null)) return refuse(400, 'Enter at least one count', { field: 'counts' });
    Object.assign(stat, { counts, capturedAt: body.capturedAt ?? stat.capturedAt, watchTime: body.watchTime === undefined ? stat.watchTime : body.watchTime, note: body.note ?? stat.note });
    return ok(stat);
  }
  const conceptMatch = path.match(/^concepts\/([^/]+)(?:\/posts(?:\/([^/]+)(?:\/(finalize|unfinalize))?)?)?$/);
  if (conceptMatch) {
    const [, cid, pid, verb] = conceptMatch;
    const c = b.concepts.find((x) => x.id === cid);
    if (!c) return refuse(404, 'That concept does not exist');
    const isPosts = path.includes('/posts');
    if (!isPosts) {
      if (method === 'GET') return ok(publicConcept(c));
      if (method === 'PATCH') { Object.assign(c, Object.fromEntries(['title', 'brief', 'archived'].filter((k) => body[k] !== undefined).map((k) => [k, body[k]]))); return ok(publicConcept(c)); }
      if (method === 'DELETE') { b.concepts = b.concepts.filter((x) => x !== c); return ok(undefined, 204); }
    }
    if (isPosts && !pid && method === 'POST') { const p = addPost(c, body, stamp()); return ok(publicConcept(c).posts.find((x) => x.id === p.id), 201); }
    const post = c.posts.find((x) => x.id === pid);
    if (isPosts && pid && !post) return refuse(404, 'That post does not exist');
    if (verb === 'finalize') {
      const needs = view(c).posts.find((x) => x.id === pid).needs;
      const missing = needs.filter((a) => a.state !== 'finalized').map((a) => a.kind);
      if (missing.length) return refuse(409, `Not every asset is finalized yet: ${missing.join(', ')}`, { code: 'content-conflict', details: { missing } });
      post.status = 'finalized';
      return ok(publicConcept(c).posts.find((x) => x.id === pid));
    }
    if (verb === 'unfinalize') { post.status = 'draft'; return ok(publicConcept(c).posts.find((x) => x.id === pid)); }
    if (method === 'PATCH') { post.scheduledAt = body.scheduledAt; return ok(publicConcept(c).posts.find((x) => x.id === pid)); }
    if (method === 'DELETE') {
      if (post.status === 'published') return refuse(409, 'A published post cannot be deleted');
      for (const a of post.own) st.studio.panes.delete(a.id);
      c.posts = c.posts.filter((x) => x !== post);
      return ok(undefined, 204);
    }
  }
  if (path === 'calendar' && method === 'GET') {
    const month = params.get('month');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) return refuse(400, 'month must be YYYY-MM', { field: 'month' });
    const posts = b.concepts.flatMap((c) => publicConcept(c).posts.map((p) => ({ ...p, conceptTitle: c.title }))).filter((p) => placedAt(p).slice(0, 7) === month);
    return ok({ month, timezone: b.timezone, posts });
  }
  const speedOf = () => {
    const samples = b.speakingSamples ?? [];
    if (b.speakingWpm !== undefined) return { speakingWpm: b.speakingWpm, source: 'manual', sampleCount: samples.length };
    if (samples.length) return { speakingWpm: Math.round(samples.reduce((n, x) => n + x.words, 0) / (samples.reduce((n, x) => n + x.durationSeconds, 0) / 60)), source: 'detected', sampleCount: samples.length };
    return { speakingWpm: 150, source: 'default', sampleCount: 0 };
  };
  if (path === 'settings/speaking-speed' && method === 'DELETE') { delete b.speakingWpm; return ok(speedOf()); }
  if (path === 'speaking-rate-samples' && method === 'GET') return ok(b.speakingSamples ?? []);
  const sampleMatch = path.match(/^speaking-rate-samples\/([^/]+)$/);
  if (sampleMatch && method === 'DELETE') {
    if (!(b.speakingSamples ?? []).some((x) => x.id === sampleMatch[1])) return refuse(404, 'That recording does not exist');
    b.speakingSamples = b.speakingSamples.filter((x) => x.id !== sampleMatch[1]);
    return ok(speedOf());
  }
  if (path === 'settings') {
    if (method === 'PATCH') {
      if (body.autoApplyRetro !== undefined && typeof body.autoApplyRetro !== 'boolean') return refuse(400, 'autoApplyRetro must be true or false', { field: 'autoApplyRetro' });
      if (body.evaluationDays !== undefined && !(Number.isInteger(body.evaluationDays) && body.evaluationDays >= 1 && body.evaluationDays <= 90)) return refuse(400, 'evaluationDays must be a whole number of days from 1 to 90', { field: 'evaluationDays' });
      if (body.speakingWpm !== undefined && !(Number.isInteger(body.speakingWpm) && body.speakingWpm >= 20 && body.speakingWpm <= 400)) return refuse(400, 'speakingWpm must be a whole number from 20 to 400', { field: 'speakingWpm' });
      Object.assign(b, Object.fromEntries(['name', 'timezone', 'writingSkillFile', 'autoApplyRetro', 'evaluationDays', 'speakingWpm'].filter((k) => body[k] !== undefined).map((k) => [k, body[k]])));
    }
    return ok({ name: b.name, timezone: b.timezone, folder: `/data/buildings/${buildingId}`, writingSkillFile: b.writingSkillFile ?? null, defaultWritingSkillFile: '/home/me/.claude/skills/human-content-writing-skill/SKILL.md', autoApplyRetro: b.autoApplyRetro, evaluationDays: b.evaluationDays, speakingSpeed: speedOf() });
  }
  const importView = () => ({ rev: ++b.imports.rev, session: b.imports.session, saved: b.concepts.filter((c) => b.imports.savedIds.includes(c.id)).map(publicConcept), blockedReason: b.imports.session ? null : b.imports.blockedReason });
  if (path === 'import-session' && method === 'GET') return ok(importView());
  if (path.startsWith('import-session')) {
    const { imports } = b;
    const running = imports.session?.state === 'running';
    const begin = () => {
      if (!imports.agent) { imports.blockedReason = 'No default coding agent is set'; return refuse(409, imports.blockedReason); }
      imports.session = { id: `is${st.nextId++}`, state: 'running', executorId: 'e1', createdAt: '2026-10-27T10:00:00.000Z', updatedAt: '2026-10-27T10:00:00.000Z' };
      imports.savedIds = [];
      return ok(importView(), 201);
    };
    if (path === 'import-session/end') { if (running) imports.session.state = 'ended'; return ok(importView()); }
    if (path === 'import-session/resume') {
      if (!imports.session) return refuse(404, 'There is no session to resume');
      imports.session.state = 'running';
      return ok(importView());
    }
    if (running) return refuse(409, 'An import session is already running.');
    if (path === 'import-session' && imports.session) return refuse(409, 'This session has ended. Resume it or start a new session.');
    return begin();
  }
  const learnMatch = path.match(/^concepts\/([^/]+)\/learn$/);
  if (learnMatch) {
    const concept = b.concepts.find((c) => c.id === learnMatch[1]);
    if (!concept) return refuse(404, 'That concept does not exist');
    if (method === 'GET') return ok(b.learn.get(concept.id) ?? null);
    if (!concept.imported) return refuse(409, 'Learn from this works only on an imported Concept.');
    if (b.learn.get(concept.id)?.status === 'running') return refuse(409, 'A learning run for this Concept is already going.');
    b.learn.set(concept.id, { status: 'running', at: '2026-10-27T10:00:00.000Z' });
    return ok({ status: 'running' }, 202);
  }
  if (path === 'retros' && method === 'GET') return ok({ entries: b.retroLog });
  if (path === 'style-proposals' && method === 'GET') return ok({ proposals: b.proposals });
  const retroMatch = path.match(/^assets\/([^/]+)\/retro$/);
  if (retroMatch && method === 'POST') {
    const a = b.concepts.flatMap((c) => [...c.assets, ...c.posts.flatMap((p) => p.own)]).find((x) => x.id === retroMatch[1]);
    if (!a) return refuse(404, 'That asset does not exist');
    if (!['script', 'post-text', 'article'].includes(a.kind) || a.state !== 'finalized') return refuse(409, 'Finalize the text before running a retro.');
    if (b.retrosRunning.has(a.id)) return refuse(409, 'A retro is already running for this asset.');
    b.retrosRunning.add(a.id);
    return ok({ status: 'running' }, 202);
  }
  const proposalMatch = path.match(/^style-proposals\/([^/]+)\/(accept|discard)$/);
  if (proposalMatch && method === 'POST') {
    const [, prid, verb] = proposalMatch;
    const p = b.proposals.find((x) => x.id === prid);
    if (!p) return refuse(404, 'That proposal does not exist');
    if (verb === 'discard') { b.proposals = b.proposals.filter((x) => x !== p); return ok({ proposals: b.proposals }); }
    const excluded = new Set(body.exclude ?? []);
    const kept = p.changes.filter((c) => !excluded.has(c.id));
    if (!kept.length) return refuse(400, 'Tick at least one change, or discard the proposal', { field: 'exclude' });
    const failed = kept.filter((c) => b.staleIds.includes(c.id) && !(body.changes ?? []).some((e) => e.id === c.id && e.find !== undefined))
      .map((c) => ({ id: c.id, section: c.section, action: c.action, reason: `"${c.find}" must occur exactly once in ${c.section} but occurs 0 times` }));
    if (failed.length) return refuse(409, 'Some changes no longer fit the writing style, so nothing was applied.', { code: 'content-conflict', details: { failed } });
    b.proposals = b.proposals.filter((x) => x !== p);
    b.history.unshift({ id: st.nextId++, at: stamp(), who: 'retro', summary: `${p.summary} (+${kept.length} lines)`, autoApplied: false });
    b.style = { content: `${b.style.content}${kept.map((c) => c.text ?? '').join('\n')}\n`, version: `ver-${st.nextId++}` };
    return ok({ ...b.style, changedAt: null, sections: ['General'], proposals: b.proposals });
  }
  if (path === 'knowledge/sections') {
    if (method === 'POST') {
      if (b.sections.some((s) => s.name.toLowerCase() === String(body.name).toLowerCase())) return refuse(409, 'A section with that name already exists');
      const s = { id: `custom-${st.nextId++}`, name: body.name, builtin: false, file: 'x.md', content: '', version: 'v1', changedAt: stamp() };
      b.sections.push(s);
      return ok({ ...s, content: undefined }, 201);
    }
    return ok({ sections: b.sections.map(({ content: _c, ...m }) => m) });
  }
  const sectionMatch = path.match(/^knowledge\/sections\/([^/]+)$/);
  if (sectionMatch) {
    const s = b.sections.find((x) => x.id === sectionMatch[1]);
    if (!s) return refuse(404, 'That section does not exist');
    if (method === 'PUT') {
      if (body.version !== s.version) return refuse(409, 'Changed by an agent since you opened it', { code: 'content-conflict', details: { current: s.version } });
      s.content = body.content; s.version = `ver-${st.nextId++}`;
    }
    if (method === 'DELETE') { b.sections = b.sections.filter((x) => x !== s); return ok(undefined, 204); }
    return ok(s);
  }
  if (path === 'knowledge/colours') {
    if (method === 'PUT') { if (body.colours.length > 20) return refuse(400, 'At most 20 colours', { field: 'colours' }); b.colours = body.colours; }
    return ok({ colours: b.colours });
  }
  if (path === 'knowledge/files') {
    if (method === 'POST') {
      const f = { name: params.get('name'), size: body?.byteLength ?? 0, changedAt: stamp(), image: /\.(png|jpe?g|svg)$/i.test(params.get('name')) };
      b.files.push(f);
      return ok(f, 201);
    }
    return ok({ files: b.files });
  }
  const fileMatch = path.match(/^knowledge\/files\/([^/]+)$/);
  if (fileMatch) {
    const name = decodeURIComponent(fileMatch[1]);
    if (!b.files.some((f) => f.name === name)) return refuse(404, 'That file does not exist');
    if (method === 'DELETE') { b.files = b.files.filter((f) => f.name !== name); return ok(undefined, 204); }
    return ok({ name });
  }
  if (path === 'writing-style') {
    if (method === 'PUT') {
      if (body.version !== b.style.version) return refuse(409, 'Changed by an agent since you opened it', { code: 'content-conflict', details: { current: b.style.version } });
      b.history.unshift({ id: st.nextId++, at: stamp(), who: 'person', summary: '+1 line', autoApplied: false });
      b.style = { content: body.content, version: `ver-${st.nextId++}` };
    }
    return ok({ ...b.style, changedAt: null, sections: ['General'], proposals: b.proposals });
  }
  if (path === 'writing-style/history') return ok({ entries: b.history });
  if (path === 'targets' && method === 'GET') return ok({ targets: b.targets, evaluationDays: b.evaluationDays });
  if (path === 'targets/history') return ok({ entries: b.targetHistory.slice(0, 50) });
  const targetMatch = path.match(/^targets\/([^/]+)$/);
  if (targetMatch && method === 'PUT') {
    const platform = targetMatch[1];
    if (!b.targets[platform]) return refuse(400, 'platform must be linkedin, instagram, x, facebook or blog', { field: 'platform' });
    const next = { ...b.targets[platform] };
    for (const [key, value] of Object.entries(body ?? {})) {
      if (!TARGET_FIELDS.includes(key)) return refuse(400, `${key} is not a target field`, { field: key });
      const bad = value !== null && (typeof value !== 'number' || value < 0 || (key === 'engagementRate' ? value > 100 || Math.round(value * 100) / 100 !== value : !Number.isSafeInteger(value) || value > 1e12));
      if (bad) return refuse(400, `${key} is out of range`, { field: key });
      next[key] = value;
    }
    if (TARGET_FIELDS.some((f) => next[f] !== b.targets[platform][f])) b.targetHistory.unshift({ id: st.nextId++, at: new Date(1_790_000_000_000 + st.nextId * 1000).toISOString(), who: 'person', platform, before: b.targets[platform], after: next });
    b.targets[platform] = next;
    return ok({ platform, targets: next });
  }
  if (path === 'insights' && method === 'GET') { const { history: _history, ...rest } = b.insights; return ok(rest); }
  if (path === 'insights/history') return ok({ entries: b.insights.history });
  if (path === 'insights/refresh' && method === 'POST') {
    if (b.insights.state === 'running') return refuse(409, 'An insights refresh is already running.');
    b.insights.state = 'running';
    return ok({ status: 'running' }, 202);
  }
  if (path === 'insights/stop' && method === 'POST') {
    if (b.insights.state !== 'running') return refuse(409, 'No insights refresh is running.');
    b.insights.state = b.insights.markdown ? 'ready' : 'never-run';
    return ok({ status: 'stopped' });
  }
  if (path === 'insights/notes' && method === 'PUT') {
    if (typeof body?.content !== 'string') return refuse(400, 'content must be text', { field: 'content' });
    if (body.version !== b.insights.notesVersion) return refuse(409, 'Changed since you opened it', { code: 'content-conflict', details: { current: b.insights.notesVersion } });
    b.insights.notes = body.content;
    b.insights.notesVersion = `n${st.nextId++}`;
    return ok({ content: b.insights.notes, version: b.insights.notesVersion });
  }
  return refuse(404, 'not found');
}

// ---- the Video tab (server/src/api/videoRoutes.ts) ---------------------------------------------------

const VIDEO_KINDS = { mp4: 'video', mov: 'video', webm: 'video', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', svg: 'image', mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio' };

export function videoPane(st, aid) {
  if (!st.studio.panes.has(aid)) st.studio.panes.set(aid, { rounds: [], drafts: [], checklist: { items: [], confirmedAt: null }, renders: [], blockedReason: null, imageRounds: new Map() });
  return st.studio.panes.get(aid);
}

// ---- the Images tab (server/src/api/imageRoutes.ts, content/imageStudio.ts) -----------------------------

const IMAGE_SIZES = { instagram: { image: [1080, 1350], carousel: [1080, 1350] }, linkedin: { image: [1200, 1200], carousel: [1080, 1350] }, x: { image: [1600, 900] }, facebook: { image: [1200, 1200], carousel: [1080, 1080] } };
const rangeOf = (post) => (post.format === 'image' ? { min: 1, max: post.platform === 'x' ? 4 : 1 } : { min: 2, max: post.platform === 'facebook' ? 10 : 20 });
/** A short form of the daemon's Finalize rule; the exact wording is pinned in the server and web unit tests. */
function imagesBlocker(post, r) {
  const range = rangeOf(post);
  if (!r?.call) return `Finalize needs a rendered set: ${range.min} to ${range.max} images.`;
  if (r.call.status === 'running' || r.call.status === 'queued') return 'Finalize is available once the render finishes.';
  if (r.call.status !== 'done') return 'The last render did not finish, so there is no complete set. Render again to finalize.';
  return r.images.length < range.min || r.images.length > range.max ? `This post takes ${range.min} to ${range.max} images; this round has ${r.images.length}.` : null;
}
function imagesPart(buildingId, a, post, pane) {
  const [width, height] = IMAGE_SIZES[post.platform][post.format];
  const rounds = [...pane.imageRounds.entries()].sort((x, y) => y[0] - x[0]).map(([round, r]) => ({ round, ...r, zipUrl: r.images.length ? `/api/projects/${buildingId}/content/assets/${a.id}/images/rounds/${round}/images.zip` : null }));
  return {
    setup: pane.setup ?? { status: 'ready', error: null, percent: null }, blockedReason: pane.rounds.length ? null : pane.blockedReason ?? null,
    platform: post.platform, format: post.format, defaultSize: { width, height }, range: rangeOf(post), stills: [], rounds,
    finalizeBlocked: a.state === 'finalized' ? null : imagesBlocker(post, pane.imageRounds.get(a.round)),
  };
}

// ---- the Thumbnail tab (server/src/content/thumbnailStudio.ts) ------------------------------------------

/** A short form of the daemon's Finalize rule for a thumbnail. */
function thumbnailBlocker(r) {
  if (!r?.call) return 'Render at least one thumbnail before finalizing.';
  if (r.call.status === 'running' || r.call.status === 'queued') return 'Finalize is available once the render finishes.';
  return r.call.status === 'done' ? null : 'The last render did not finish. Render again to finalize.';
}
function thumbnailPart(a, pane) {
  const rounds = [...pane.imageRounds.entries()].sort((x, y) => y[0] - x[0]).map(([round, r]) => ({ round, call: r.call, thumbnails: r.images }));
  const final = a.state === 'finalized' ? JSON.parse(a.content)[0].match(/^thumbnail\/round-(\d+)\/(.+)$/) : null;
  const done = final && rounds.find((r) => r.round === Number(final[1]))?.thumbnails.find((t) => t.name === final[2]);
  return {
    setup: pane.setup ?? { status: 'ready', error: null, percent: null }, blockedReason: pane.rounds.length ? null : pane.blockedReason ?? null,
    defaultSize: { width: 1280, height: 720 }, stills: [], rounds, finalizeBlocked: a.state === 'finalized' ? null : thumbnailBlocker(pane.imageRounds.get(a.round)),
    final: done ? { round: Number(final[1]), name: done.name, url: done.url, downloadUrl: done.downloadUrl } : null,
  };
}

/** Records a `render_thumbnails` call in the asset's current round: `done` thumbnails made of `total`. */
export function addThumbnailRender(st, buildingId, aid, { total = 3, done = total, status = 'done', width = 1280, height = 720, error = null } = {}) {
  const pane = videoPane(st, aid);
  const a = st.byBuilding.get(buildingId).concepts.flatMap((c) => c.assets).find((x) => x.id === aid);
  const round = Math.max(a.round, 1);
  const base = `/api/projects/${buildingId}/content/assets/${aid}/thumbnail/rounds/${round}`;
  const ids = Array.from({ length: total }, (_, i) => `thumb-abc-${i + 1}`);
  const images = Array.from({ length: done }, (_, i) => {
    const name = `thumb-${String(i + 1).padStart(2, '0')}.png`;
    return { index: i + 1, name, compositionId: ids[i], width, height, size: 300_000, url: `${base}/${name}`, downloadUrl: `${base}/${name}?download=1` };
  });
  const call = { id: `tr${st.nextId++}`, status, compositionIds: ids, width, height, done, total, error, queuePosition: status === 'queued' ? 1 : null, waitingFor: null, createdAt: '2026-10-26T10:00:00.000Z', finishedAt: null };
  pane.imageRounds.set(round, { call, images });
  return call;
}

/** Records a `render_images` call in the asset's current round (tests call it as the agent would): `done` images made of `total`. */
export function addImageRender(st, buildingId, aid, { total = 3, done = total, status = 'done', width = 1080, height = 1350, error = null } = {}) {
  const pane = videoPane(st, aid);
  const a = st.byBuilding.get(buildingId).concepts.flatMap((c) => c.posts.flatMap((p) => p.own)).find((x) => x.id === aid);
  const round = Math.max(a.round, 1);
  const base = `/api/projects/${buildingId}/content/assets/${aid}/images/rounds/${round}`;
  const ids = Array.from({ length: total }, (_, i) => `still-abc-slide-${i + 1}`);
  const images = Array.from({ length: done }, (_, i) => {
    const name = `image-${String(i + 1).padStart(2, '0')}.png`;
    return { index: i + 1, name, compositionId: ids[i], width, height, size: 400_000, url: `${base}/${name}`, downloadUrl: `${base}/${name}?download=1` };
  });
  const call = { id: `ir${st.nextId++}`, status, compositionIds: ids, width, height, done, total, error, queuePosition: status === 'queued' ? 1 : null, waitingFor: null, createdAt: '2026-10-26T10:00:00.000Z', finishedAt: null };
  pane.imageRounds.set(round, { call, images });
  return call;
}
const mediaOf = (st, cid) => { if (!st.media.has(cid)) st.media.set(cid, []); return st.media.get(cid); };

function videoPart(st, buildingId, cid, a, pane) {
  return {
    setup: pane.setup ?? { status: 'ready', error: null, percent: null },
    blockedReason: pane.rounds.length ? null : pane.blockedReason ?? null,
    scriptChanged: !!pane.scriptChanged,
    compositionId: `concept-${cid}`,
    checklist: { round: Math.max(a.round, 1), ...pane.checklist },
    renders: [...pane.renders].sort((x, y) => y.round - x.round || y.k - x.k),
    media: [...mediaOf(st, cid)].reverse(),
  };
}

/** Adds a finished render to the asset's current round (a render the Finalize button queued). */
export function addRender(st, buildingId, cid, aid, patch = {}) {
  const pane = videoPane(st, aid);
  const c = st.byBuilding.get(buildingId).concepts.find((x) => x.id === cid);
  const round = Math.max(c.assets.find((x) => x.id === aid).round, 1);
  const k = pane.renders.filter((r) => r.round === round).length + 1;
  const id = `r${st.nextId++}`;
  const render = {
    id, round, k, name: `render-${k}.mp4`, status: 'done', percent: null, frame: null, totalFrames: null, queuePosition: null, waitingFor: null,
    durationMs: 42_000, size: 1_000_000, error: null, createdAt: '2026-10-26T10:00:00.000Z', finishedAt: '2026-10-26T10:01:00.000Z',
    fileUrl: `/api/projects/${buildingId}/content/concepts/${cid}/video/renders/${id}/file`, ...patch,
  };
  pane.renders.push(render);
  return render;
}

async function videoRoute(st, b, buildingId, method, cid, area, rest, body, params, ok, refuse, stamp) {
  const c = b.concepts.find((x) => x.id === cid);
  if (!c) return refuse(404, 'That concept does not exist');
  const a = c.assets.find((x) => x.kind === 'video');
  const pane = videoPane(st, a.id);
  const media = mediaOf(st, cid);
  if (area === 'media') {
    if (!rest && method === 'GET') return ok({ media: [...media].reverse() });
    if (!rest && method === 'POST') {
      const name = params.get('name');
      const ext = (name ?? '').split('.').pop().toLowerCase();
      if (!name) return refuse(400, 'name is required', { field: 'name' });
      if (!VIDEO_KINDS[ext]) return refuse(400, 'Unsupported file type', { field: 'file' });
      const id = `m${st.nextId++}`;
      const item = {
        id, name, kind: VIDEO_KINDS[ext], size: body?.size ?? body?.byteLength ?? 0, durationMs: VIDEO_KINDS[ext] === 'image' ? null : 48_000, width: null, height: null,
        hasThumbnail: VIDEO_KINDS[ext] !== 'audio', createdAt: stamp(), path: `concepts/${cid}/media/${name}`,
        fileUrl: `/api/projects/${buildingId}/content/concepts/${cid}/media/${id}/file`, thumbnailUrl: VIDEO_KINDS[ext] === 'audio' ? null : `/api/projects/${buildingId}/content/concepts/${cid}/media/${id}/thumbnail`,
      };
      media.push(item);
      return ok(item, 201);
    }
    const [mid, sub] = rest.split('/');
    const item = media.find((m) => m.id === mid);
    if (!item) return refuse(404, 'That media file does not exist');
    if (sub) return ok({});
    if (method === 'PATCH') {
      if (media.some((m) => m !== item && m.name.toLowerCase() === String(body.name).toLowerCase())) return refuse(409, 'Another file already has that name');
      item.name = body.name;
      return ok(item);
    }
    if (method === 'DELETE') {
      st.media.set(cid, media.filter((m) => m !== item));
      for (const i of pane.checklist.items) i.mediaIds = i.mediaIds.filter((x) => x !== mid);
      return ok(undefined, 204);
    }
  }
  const round = Math.max(a.round, 1);
  const list = () => ({ round, ...pane.checklist });
  if (rest === 'checklist' && method === 'GET') return ok(list());
  const item = rest.match(/^checklist\/(.+)$/);
  if (item && method === 'PATCH') {
    const found = pane.checklist.items.find((i) => i.id === decodeURIComponent(item[1]));
    if (!found) return refuse(404, 'That checklist item does not exist');
    if (pane.checklist.confirmedAt || a.state === 'finalized') return refuse(409, 'Checklist is confirmed');
    if (body.ticked !== undefined) found.ticked = body.ticked;
    if (body.mediaIds !== undefined) found.mediaIds = [...new Set(body.mediaIds)];
    return ok(list());
  }
  if (rest === 'confirm' && method === 'POST') {
    if (pane.checklist.confirmedAt || !pane.checklist.items.length || pane.checklist.items.some((i) => !i.ticked)) return refuse(409, 'Tick every item to confirm');
    pane.checklist.confirmedAt = stamp();
    return ok(list());
  }
  if (rest === 'renders' && method === 'GET') return ok({ renders: [...pane.renders].reverse() });
  const r = rest.match(/^renders\/([^/]+)\/(file|stop)$/);
  if (r) {
    const render = pane.renders.find((x) => x.id === r[1]);
    if (!render) return refuse(404, 'That render does not exist');
    if (r[2] === 'file') return ok({});
    if (render.status !== 'running' && render.status !== 'queued') return refuse(409, 'That render is not running or waiting');
    Object.assign(render, { status: 'stopped', error: 'The render was stopped' });
    return ok(render);
  }
  return refuse(404, 'not found');
}

// ---- Remotion Studio (server/src/api/remotionStudioRoutes.ts) ---------------------------------------------

const STUB_STUDIO_URL = 'http://127.0.0.1:3047';
export const stoppedStudio = () => ({ state: 'stopped', url: null, error: null, log: [], waitingForSetup: false });

/** Viewing changes no data, so a read-only Building may use every route; only a start that needs the install is refused there. */
function remotionStudioRoute(st, b, buildingId, method, path, ok, refuse) {
  const r = st.remotion;
  if (r.notContent.has(buildingId)) return refuse(404, 'This is not a Content Studio Building');
  const view = () => r.byBuilding.get(buildingId) ?? stoppedStudio();
  const verb = path.slice('remotion/studio'.length);
  if (verb === '' && method === 'GET') return ok(view());
  if (method !== 'POST') return refuse(404, 'Not found');
  if (verb === '/start') {
    const now = view();
    if (now.state === 'starting' || now.state === 'running') return ok(now);
    if (!b.concepts.some((c) => c.compositionId)) return refuse(409, 'Start the video in the Video tab first');
    if (st.readOnly && r.needsInstall) return refuse(409, "Studio can't start: this Building is read-only and the Remotion project still needs its packages installed.");
    r.spawns++;
    r.byBuilding.set(buildingId, { ...stoppedStudio(), state: r.startAs, url: r.startAs === 'running' ? STUB_STUDIO_URL : null, log: ['Server ready - Local: http://localhost:3047'] });
    return ok(view());
  }
  if (verb === '/stop') {
    const now = view();
    if (now.state === 'starting' || now.state === 'running') r.byBuilding.set(buildingId, { ...now, state: 'stopped', url: null, waitingForSetup: false });
    return ok(view());
  }
  if (verb === '/heartbeat') return ok(view());
  return refuse(404, 'Not found');
}
