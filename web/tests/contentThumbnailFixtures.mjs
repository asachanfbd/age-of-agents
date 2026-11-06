/** Thumbnail studio views for the Thumbnail tab's tests: one builder and a named view per pane state. */
import { NOW } from './contentImagesFixtures.mjs';

export { NOW };
const ISO = (min) => new Date(NOW + min * 60_000).toISOString();
const BASE = '/api/projects/b1/content/assets/t1/thumbnail/rounds';

export const thumb = (index, over = {}, round = 1) => {
  const name = `thumb-${String(index).padStart(2, '0')}.png`;
  return { index, name, compositionId: `thumb-abc-${index}`, width: 1280, height: 720, size: 300_000, url: `${BASE}/${round}/${name}`, downloadUrl: `${BASE}/${round}/${name}?download=1`, ...over };
};
export const tcall = (over = {}) => ({
  id: 'tr1', status: 'done', compositionIds: Array.from({ length: over.total ?? 3 }, (_, i) => `thumb-abc-${i + 1}`), width: 1280, height: 720, done: 3, total: 3, error: null,
  queuePosition: null, waitingFor: null, createdAt: ISO(-3), finishedAt: ISO(-1), ...over,
});
export const tround = (n, c, count = c?.done ?? 0, over = {}) => ({ round: n, call: c, thumbnails: Array.from({ length: count }, (_, i) => thumb(i + 1, over, n)) });

export function thumbnailView({ rounds = [], asset = {}, session = {}, alt = null, previousAlt = {}, thumbnail = {} } = {}) {
  const roundNo = asset.round ?? 1;
  const studioRounds = Array.from({ length: roundNo }, (_, i) => {
    const r = i + 1;
    const text = r === roundNo ? alt : previousAlt[r] ?? null;
    return { round: r, startedAt: ISO(-60 + r), draft: text === null ? null : { text, savedAt: ISO(-2) } };
  });
  return {
    rev: 1, conceptId: 'c1', assetId: 't1',
    asset: { state: 'drafting', round: roundNo, finalizedAt: null, content: null, ...asset },
    session: session === null ? null : { id: 's1', conceptId: 'c1', assetId: 't1', tab: 'thumbnail', round: roundNo, state: 'running', executorId: 'x', createdAt: ISO(-10), updatedAt: ISO(-10), ...session },
    rounds: studioRounds, skillWarning: null, blockedReason: null, retro: null,
    thumbnail: { setup: { status: 'ready', error: null, percent: null }, blockedReason: null, defaultSize: { width: 1280, height: 720 }, stills: [], rounds, finalizeBlocked: null, final: null, ...thumbnail },
  };
}

const ALT = 'Bold title on blue\nPortrait of the host\nProduct on white';
export const TSTATES = {
  empty: thumbnailView({ thumbnail: { finalizeBlocked: 'Render at least one thumbnail before finalizing.' } }),
  rendering: thumbnailView({ rounds: [tround(1, tcall({ status: 'running', done: 1, finishedAt: null }), 1)], thumbnail: { finalizeBlocked: 'Finalize is available once the render finishes.' } }),
  queued: thumbnailView({ rounds: [tround(1, tcall({ status: 'queued', done: 0, queuePosition: 1, waitingFor: { conceptTitle: 'Spring reel', kind: 'video' }, finishedAt: null }), 0)], thumbnail: { finalizeBlocked: 'Finalize is available once the render finishes.' } }),
  rendered: thumbnailView({ rounds: [tround(1, tcall(), 3)], alt: ALT }),
  failed: thumbnailView({ rounds: [tround(1, tcall({ status: 'failed', done: 1, error: 'thumb-abc-2 timed out after 60 seconds' }), 1)], thumbnail: { finalizeBlocked: 'The last render did not finish. Render again to finalize.' } }),
  stopped: thumbnailView({ rounds: [tround(1, tcall({ status: 'stopped', done: 2, error: 'The render was stopped' }), 2)], thumbnail: { finalizeBlocked: 'The last render did not finish. Render again to finalize.' } }),
  single: thumbnailView({ rounds: [tround(1, tcall({ total: 1, done: 1 }), 1)] }),
  vertical: thumbnailView({ rounds: [tround(1, tcall({ total: 1, done: 1, width: 1080, height: 1920 }), 1, { width: 1080, height: 1920 })] }),
  five: thumbnailView({ rounds: [tround(1, tcall({ total: 5, done: 5 }), 5)] }),
  finalized: thumbnailView({
    asset: { state: 'finalized', finalizedAt: ISO(-1), content: '["thumbnail/round-1/thumb-02.png"]' }, session: { state: 'ended' }, rounds: [tround(1, tcall(), 3)],
    thumbnail: { final: { round: 1, name: 'thumb-02.png', url: `${BASE}/1/thumb-02.png`, downloadUrl: `${BASE}/1/thumb-02.png?download=1` } },
  }),
  setup: thumbnailView({ session: null, thumbnail: { setup: { status: 'running', error: null, percent: null } } }),
  setupfail: thumbnailView({ session: null, thumbnail: { setup: { status: 'failed', error: 'Remotion setup failed: npm exited with code 1', percent: null } } }),
  previous: thumbnailView({ asset: { round: 2 }, rounds: [tround(2, tcall({ total: 2, done: 2, id: 'tr2' }), 2), tround(1, tcall({ id: 'tr0' }), 3)] }),
};
