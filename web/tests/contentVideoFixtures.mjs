/** Video tab views for the web tests: one builder, with each state reached by a small patch. */

export const NOW = Date.parse('2026-10-26T10:00:00Z');

export const media = (id, name, kind, extra = {}) => ({
  id, name, kind, size: 1_000_000, durationMs: kind === 'image' ? null : 48_000, width: null, height: null, hasThumbnail: kind !== 'audio',
  createdAt: `2026-10-26T09:0${id.slice(-1)}:00.000Z`, path: `concepts/c1/media/${name}`, fileUrl: `/api/projects/b1/content/concepts/c1/media/${id}/file`,
  thumbnailUrl: kind === 'audio' ? null : `/api/projects/b1/content/concepts/c1/media/${id}/thumbnail`, ...extra,
});

export const render = (k, extra = {}) => ({
  id: `r${k}`, round: 1, k, name: `render-${k}.mp4`, status: 'done', percent: null, frame: null, totalFrames: null, queuePosition: null, waitingFor: null,
  durationMs: 42_000, size: 18_400_000, error: null, createdAt: '2026-10-26T09:50:00.000Z', finishedAt: '2026-10-26T09:55:00.000Z',
  fileUrl: `/api/projects/b1/content/concepts/c1/video/renders/r${k}/file`, ...extra,
});

export const item = (id, ticked = false, mediaIds = []) => ({ id, label: `Label ${id}`, detail: `Detail ${id}`, ticked, mediaIds });

export function videoView({ session = 'running', asset = {}, setup = { status: 'ready', error: null, percent: null }, blockedReason = null, checklist = {}, renders = [], mediaList = [media('m1', 'clip.mp4', 'video'), media('m2', 'logo.png', 'image'), media('m3', 'music.mp3', 'audio')], scriptChanged = false, rev = 1 } = {}) {
  return {
    rev, conceptId: 'c1', assetId: 'v1',
    asset: { state: 'drafting', round: 1, finalizedAt: null, content: null, ...asset },
    session: session && { id: 's1', conceptId: 'c1', assetId: 'v1', tab: 'video', round: asset.round ?? 1, state: session, executorId: 'agent', createdAt: '2026-10-26T09:00:00.000Z', updatedAt: '2026-10-26T09:00:00.000Z' },
    rounds: [], skillWarning: null,
    video: { setup, blockedReason, scriptChanged, compositionId: 'concept-c1', checklist: { round: 1, items: [], confirmedAt: null, ...checklist }, renders, media: mediaList },
  };
}

const confirmedList = { items: [item('clip', true, ['m1']), item('logo', true)], confirmedAt: '2026-10-26T09:30:00.000Z' };

/** One view per pane state, as named in the UI planning mockup. */
export const STATES = {
  setup: videoView({ session: null, setup: { status: 'running', error: null, percent: 64 } }),
  setupfail: videoView({ session: null, setup: { status: 'failed', error: 'Remotion setup failed: npm exited with code 1', percent: null } }),
  blocked: videoView({ session: null, blockedReason: 'No default coding agent is set.' }),
  waiting: videoView(),
  checklist: videoView({ checklist: { items: [item('clip', true, ['m1']), item('logo'), item('music')] } }),
  ready: videoView({ checklist: { items: [item('clip', true), item('logo', true)] } }),
  preview: videoView({ checklist: confirmedList }),
  rendering: videoView({ checklist: confirmedList, renders: [render(1, { status: 'running', percent: 46, frame: 581, totalFrames: 1260, fileUrl: null, finishedAt: null })] }),
  queued: videoView({ checklist: confirmedList, renders: [render(1, { status: 'queued', queuePosition: 1, waitingFor: 'Pricing explained', fileUrl: null, finishedAt: null })] }),
  failed: videoView({ checklist: confirmedList, renders: [render(1, { status: 'failed', error: 'Cannot find file "logo-light.png"', fileUrl: null })] }),
  stopped: videoView({ checklist: confirmedList, renders: [render(1, { status: 'stopped', error: 'The render was stopped', fileUrl: null })] }),
  /** Confirmed, with the agent's session gone: the preview and Finalize stay. */
  ended: videoView({ session: 'ended', checklist: confirmedList }),
  /** Ended before Confirm: the checklist step with the session card. */
  endedUnconfirmed: videoView({ session: 'ended', checklist: { items: [item('clip', true), item('logo', true)] } }),
  finalized: videoView({ session: 'ended', asset: { state: 'finalized', finalizedAt: '2026-10-26T09:57:00.000Z', content: 'r2' }, checklist: confirmedList, renders: [render(2), render(1)] }),
};
