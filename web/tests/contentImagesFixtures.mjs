/** Image-set studio views for the Images tab's tests: one builder and a named view per pane state. */

export const NOW = Date.parse('2026-10-26T12:00:00Z');
const ISO = (min) => new Date(NOW + min * 60_000).toISOString();
const BASE = '/api/projects/b1/content/assets/a1/images/rounds';

export const image = (index, over = {}, round = 1) => {
  const name = `image-${String(index).padStart(2, '0')}.png`;
  return { index, name, compositionId: `still-abc-slide-${index}`, width: 1080, height: 1350, size: 412_000, url: `${BASE}/${round}/${name}`, downloadUrl: `${BASE}/${round}/${name}?download=1`, ...over };
};
export const call = (over = {}) => ({
  id: 'ir1', status: 'done', compositionIds: Array.from({ length: over.total ?? 7 }, (_, i) => `still-abc-slide-${i + 1}`), width: 1080, height: 1350, done: 7, total: 7, error: null,
  queuePosition: null, waitingFor: null, createdAt: ISO(-3), finishedAt: ISO(-1), ...over,
});
export const round = (n, c, count = c?.done ?? 0) => {
  const images = Array.from({ length: count }, (_, i) => image(i + 1, {}, n));
  return { round: n, call: c, images, zipUrl: images.length ? `${BASE}/${n}/images.zip` : null };
};

export function imagesView({ rounds = [], asset = {}, session = {}, alt = null, platform = 'instagram', format = 'carousel', images = {}, previousAlt = {} } = {}) {
  const roundNo = asset.round ?? 1;
  const sizes = { 'instagram/carousel': [1080, 1350], 'instagram/image': [1080, 1350], 'x/image': [1600, 900], 'facebook/carousel': [1080, 1080] };
  const [width, height] = sizes[`${platform}/${format}`] ?? [1080, 1350];
  const range = format === 'image' ? { min: 1, max: platform === 'x' ? 4 : 1 } : { min: 2, max: platform === 'facebook' ? 10 : 20 };
  const studioRounds = Array.from({ length: roundNo }, (_, i) => {
    const r = i + 1;
    const text = r === roundNo ? alt : previousAlt[r] ?? null;
    return { round: r, startedAt: ISO(-60 + r), draft: text === null ? null : { text, savedAt: ISO(-2) } };
  });
  return {
    rev: 1, conceptId: 'c1', assetId: 'a1',
    asset: { state: 'drafting', round: roundNo, finalizedAt: null, content: null, ...asset },
    session: session === null ? null : { id: 's1', conceptId: 'c1', assetId: 'a1', tab: 'images', round: roundNo, state: 'running', executorId: 'x', createdAt: ISO(-10), updatedAt: ISO(-10), ...session },
    rounds: studioRounds, skillWarning: null,
    images: { setup: { status: 'ready', error: null, percent: null }, blockedReason: null, platform, format, defaultSize: { width, height }, range, stills: [], rounds, finalizeBlocked: null, ...images },
  };
}

// `finalizeBlocked` is what the daemon sends for each state (server imageRules.ts `finalizeImagesBlocker`).
export const STATES = {
  empty: imagesView({ images: { finalizeBlocked: 'Finalize needs a rendered set: 2 to 20 images for an Instagram carousel.' } }),
  rendering: imagesView({ rounds: [round(1, call({ status: 'running', done: 3, finishedAt: null }), 3)], images: { finalizeBlocked: 'Finalize is available once the render finishes.' } }),
  queued: imagesView({ rounds: [round(1, call({ status: 'queued', done: 0, queuePosition: 1, waitingFor: { conceptTitle: 'Spring reel', kind: 'video' }, finishedAt: null }), 0)], images: { finalizeBlocked: 'Finalize is available once the render finishes.' } }),
  rendered: imagesView({ rounds: [round(1, call(), 7)], alt: 'A red logo\n\nThird slide' }),
  misfit: imagesView({ platform: 'x', format: 'image', rounds: [round(1, call({ total: 5, done: 5, width: 1600, height: 900 }), 5)], images: { finalizeBlocked: 'An X image post takes 1 to 4 images; this round has 5.' } }),
  failed: imagesView({ rounds: [round(1, call({ status: 'failed', done: 4, error: 'image 5 (still-abc-slide-5) timed out after 60 seconds' }), 4)], images: { finalizeBlocked: 'The last render did not finish, so there is no complete set. Render again to finalize.' } }),
  stopped: imagesView({ rounds: [round(1, call({ status: 'stopped', done: 2, error: 'The render was stopped' }), 2)], images: { finalizeBlocked: 'The last render did not finish, so there is no complete set. Render again to finalize.' } }),
  finalized: imagesView({ asset: { state: 'finalized', finalizedAt: ISO(-1), content: '[]' }, session: { state: 'ended' }, rounds: [round(1, call(), 7)] }),
  setup: imagesView({ session: null, images: { setup: { status: 'running', error: null, percent: null } } }),
  setupfail: imagesView({ session: null, images: { setup: { status: 'failed', error: 'Remotion setup failed: npm exited with code 1', percent: null } } }),
  ended: imagesView({ session: { state: 'ended' }, rounds: [round(1, call(), 7)] }),
  previous: imagesView({ asset: { round: 2 }, rounds: [round(2, call({ total: 2, done: 2 }), 2), round(1, call({ id: 'ir0' }), 7)] }),
  single: imagesView({ platform: 'instagram', format: 'image', rounds: [round(1, call({ total: 1, done: 1 }), 1)] }),
};
