import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { item, media, render, STATES, videoView } from './contentVideoFixtures.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const v = await import('../src/lib/contentVideo.ts');
const { buildRunningGroups } = await import('../src/lib/runningCommands.ts');
const { conceptTabStates } = await import('../src/lib/contentRules.ts');

/** The Video tab's pure rules (web/src/lib/contentVideo.ts). Case ids follow the Test Case Planning list (WU01…). */

test('WU01/WU02/WU03 setup running, setup failed, and a blocked start', () => {
  assert.equal(v.videoPaneState(STATES.setup), 'setup');
  assert.equal(v.videoPaneState(STATES.setupfail), 'setupfail');
  assert.equal(v.videoPaneState(STATES.blocked), 'blocked');
  assert.equal(v.videoPaneState(videoView({ session: null })), 'starting');
  assert.equal(v.videoPaneState(null), 'loading');
  assert.equal(v.videoPaneState({ ...STATES.waiting, video: undefined }), 'loading');
});

test('WU04/WU05/WU06 waiting, then the checklist, ready after the last tick, the live preview after confirm', () => {
  assert.equal(v.videoPaneState(STATES.waiting), 'waiting');
  const before = videoView({ checklist: { items: [item('a', true), item('b')] } });
  const after = videoView({ checklist: { items: [item('a', true), item('b', true)] } });
  assert.deepEqual([v.videoPaneState(before), v.videoPaneState(after)], ['checklist', 'ready']);
  assert.equal(v.videoPaneState(videoView({ checklist: { ...after.video.checklist, confirmedAt: '2026-10-26T09:00:00Z' } })), 'preview');
});

test('WU01 after Confirm every render state, an ended session and no render at all stay on the live preview; an unconfirmed ended session keeps its card; finalized wins', () => {
  for (const name of ['preview', 'rendering', 'queued', 'failed', 'stopped', 'ended']) assert.equal(v.videoPaneState(STATES[name]), 'preview', name);
  assert.equal(v.videoPaneState(STATES.endedUnconfirmed), 'ended');
  assert.equal(v.videoPaneState(STATES.finalized), 'finalized');
  assert.equal(v.playableRender(STATES.finalized).id, 'r2');
  assert.equal(v.playableRender(STATES.preview), null);
  assert.equal(v.playableRender(videoView({ checklist: STATES.preview.video.checklist, renders: [render(1)] })), null, 'an old done render is not played while drafting');
});

test('WU12 read-only leaves the state alone and turns off Finalize', () => {
  assert.equal(v.videoPaneState(STATES.preview), 'preview');
  assert.equal(v.canFinalize(STATES.preview, true), false);
});

test('WU13 precedence: finalized beats ended, setup failed beats blocked', () => {
  assert.equal(v.videoPaneState(STATES.finalized), 'finalized');
  assert.equal(v.videoPaneState(videoView({ session: null, blockedReason: 'x', setup: { status: 'failed', error: 'e', percent: null } })), 'setupfail');
});

test('WU14 tick and confirm texts', () => {
  const list = { round: 1, items: [item('a', true), item('b', true), item('c'), item('d'), item('e')], confirmedAt: null };
  assert.equal(v.confirmHint({ ...list, items: [item('a', true), item('b'), item('c'), item('d')] }), 'Tick every item to confirm · 3 left');
  assert.equal(v.tickCount(list), '2 of 5 ticked');
  assert.equal(v.confirmHint({ ...list, items: [item('a', true)] }), 'Every item is ticked. Confirming locks the list.');
  assert.equal(v.confirmHint({ ...list, items: [] }), 'The agent has not published a checklist yet.');
  assert.equal(v.tickCount({ ...list, items: [] }), '0 of 0 ticked');
});

test('WU04/WU05 canFinalize: confirmed assets, a ready project and no running or queued render; an ended session may finalize; read-only and finalized may not', () => {
  assert.equal(v.canFinalize(STATES.preview, false), true);
  assert.equal(v.canFinalize(STATES.ended, false), true);
  assert.equal(v.canFinalize(STATES.failed, false), true);
  assert.equal(v.canFinalize(STATES.stopped, false), true);
  assert.equal(v.canFinalize(STATES.rendering, false), false);
  assert.equal(v.canFinalize(STATES.queued, false), false);
  assert.equal(v.canFinalize(STATES.preview, true), false);
  assert.equal(v.canFinalize(STATES.finalized, false), false);
  assert.equal(v.canFinalize(STATES.checklist, false), false);
  assert.equal(v.canFinalize(videoView({ checklist: STATES.preview.video.checklist, setup: { status: 'running', error: null, percent: 5 } }), false), false);
});

test('WU06 finalizeHint names each blocker and is null when Finalize is free', () => {
  assert.equal(v.finalizeHint(STATES.rendering), 'Finalize waits until the render finishes or is stopped.');
  assert.equal(v.finalizeHint(STATES.queued), 'Finalize waits until the render finishes or is stopped.');
  assert.equal(v.finalizeHint(STATES.checklist), 'Confirm the assets before finalizing.');
  assert.equal(v.finalizeHint(videoView({ checklist: STATES.preview.video.checklist, setup: { status: 'running', error: null, percent: 5 } })), 'Remotion is still being set up.');
  assert.equal(v.finalizeHint(STATES.preview), null);
  assert.equal(v.finalizeHint(STATES.ended), null);
});

test('WU07/WU08/WU09 the alert after a failed or stopped final render; a new render, a finalize or an older attempt clears it', () => {
  assert.equal(v.finalRenderAlert(STATES.failed), 'Final render failed: Cannot find file "logo-light.png". Nothing was finalized.');
  assert.equal(v.finalRenderAlert(STATES.stopped), 'The final render was stopped. Nothing was finalized.');
  assert.equal(v.finalRenderAlert(STATES.preview), null);
  assert.equal(v.finalRenderAlert(STATES.rendering), null);
  assert.equal(v.finalRenderAlert(STATES.finalized), null);
  const retried = videoView({ checklist: STATES.preview.video.checklist, renders: [render(2, { status: 'queued', fileUrl: null }), render(1, { status: 'failed', error: 'x', fileUrl: null })] });
  assert.equal(v.finalRenderAlert(retried), null, 'the retry is newer than the failure');
  const otherRound = videoView({ asset: { round: 2 }, checklist: STATES.preview.video.checklist, renders: [render(1, { status: 'failed', error: 'x', fileUrl: null })] });
  assert.equal(v.finalRenderAlert(otherRound), null, 'a failure of an earlier round does not show');
});

test('WU10 activeRender returns the running or queued render of the round, running first', () => {
  assert.equal(v.activeRender(STATES.rendering).status, 'running');
  assert.equal(v.activeRender(STATES.queued).status, 'queued');
  assert.equal(v.activeRender(STATES.failed), null);
  const both = videoView({ checklist: STATES.preview.video.checklist, renders: [render(2, { status: 'running', fileUrl: null }), render(1, { status: 'queued', fileUrl: null })] });
  assert.equal(v.activeRender(both).k, 2);
});

test('WU19 the column layout: the preview gives the right pane 44%, the checklist step 34%, a finalized video two columns', () => {
  assert.match(v.tabColumnsClass('preview'), /minmax\(360px,44%\)/);
  assert.match(v.tabColumnsClass('checklist'), /minmax\(320px,34%\)/);
  assert.match(v.tabColumnsClass('setup'), /minmax\(320px,34%\)/);
  assert.doesNotMatch(v.tabColumnsClass('finalized'), /34%|44%/);
  for (const state of ['preview', 'checklist', 'finalized']) assert.match(v.tabColumnsClass(state), /^min-\[960px\]:grid-cols-/, 'stacked below 960px');
});

test('WU16 media order: newest first, ties by name', () => {
  const list = [media('m1', 'b.png', 'image'), media('m2', 'z.png', 'image'), media('m3', 'a.png', 'image', { createdAt: '2026-10-26T09:02:00.000Z' })];
  assert.deepEqual(v.orderMedia(list).map((m) => m.name), ['a.png', 'z.png', 'b.png']);
});

test('WU17/WU18 media footer, sizes and durations', () => {
  assert.equal(v.mediaFooter(Array.from({ length: 7 }, (_, i) => media(`m${i}`, `f${i}.png`, 'image', { size: 200 * 1024 ** 2 }))), '7 files · 1.4 GB');
  assert.equal(v.mediaFooter([]), '0 of 200 files');
  assert.equal(v.mediaFooter([media('m1', 'a.png', 'image', { size: 2048 })]), '1 file · 2 KB');
  assert.deepEqual([0, 48_000, 134_000, 3_605_000].map(v.formatDuration), ['0:00', '0:48', '2:14', '1:00:05']);
  assert.equal(v.formatDuration(null), '');
  assert.equal(v.formatBytes(412 * 1024 ** 2), '412 MB');
});

test('WU19/WU21 the upload queue: cap, waiting text, progress, finished and cancelled rows leave', () => {
  const rows = v.planUploads([{ name: 'a.mp4', size: 1_181_116_006 }, { name: 'b.svg', size: 10 }, { name: 'c.png', size: 10 }], 0, 0, (i) => `k${i}`);
  assert.deepEqual(v.nextToStart(rows), ['k0', 'k1']);
  const started = v.patchUpload(v.patchUpload(rows, 'k0', { status: 'uploading', loaded: 432_013_312 }), 'k1', { status: 'uploading' });
  assert.deepEqual(v.nextToStart(started), []);
  assert.equal(v.uploadProgressText(started[0]), '36% · 412 MB of 1.1 GB');
  assert.equal(v.uploadProgressText(started[2]), 'Waiting…');
  assert.deepEqual(v.dropUpload(started, 'k0').map((r) => r.key), ['k1', 'k2']);
  assert.deepEqual(v.nextToStart(v.dropUpload(started, 'k0')), ['k2']);
});

test('WU20 upload pre-checks: unsupported type, over 2 GiB, no room left', () => {
  const rows = v.planUploads([{ name: 'notes.pdf', size: 1 }, { name: 'big.mp4', size: 2_147_483_649 }, { name: 'ok.png', size: 1 }, { name: 'late.png', size: 1 }], 198, 1, (i) => `k${i}`);
  assert.deepEqual(rows.map((r) => [r.status, r.error]), [['error', v.UNSUPPORTED_TEXT], ['error', v.TOO_BIG_TEXT], ['waiting', null], ['error', v.NO_ROOM_TEXT]]);
  assert.equal(v.UNSUPPORTED_TEXT, 'Unsupported file type. Use video, image or audio.');
  assert.equal(v.uploadProgressText(rows[0]), v.UNSUPPORTED_TEXT);
  assert.equal(v.kindOfName('A.JPEG'), 'image');
});

test('WU22 rename validator messages, and the shared case table the server also checks (drift)', () => {
  assert.equal(v.renameError('', '.png', []), v.RENAME_EMPTY);
  assert.equal(v.renameError('x'.repeat(117), '.png', []), v.RENAME_TOO_LONG);
  assert.equal(v.renameError('a/b', '.png', []), v.RENAME_BAD_CHARS);
  assert.equal(v.renameError('Logo', '.png', ['logo.PNG']), v.RENAME_TAKEN);
  assert.deepEqual(v.splitMediaName('talking head.take-3.mov'), { base: 'talking head.take-3', ext: '.mov' });
  const table = JSON.parse(readFileSync(new URL('../../server/tests/fixtures/mediaRenameCases.json', import.meta.url), 'utf8'));
  for (const c of table.cases) assert.equal(v.renameError(c.base, '.png', table.others) === null, c.valid, JSON.stringify(c.base));
});

test('WU23 zoom: clamped 10% to 800%, buttons x1.25, wheel x1.1, Fit and 100% modes', () => {
  let z = v.zoomFit(1);
  assert.equal(z.mode, 'fit');
  z = v.zoomBy(z, v.ZOOM_BUTTON_STEP);
  assert.deepEqual(z, { mode: 'custom', scale: 1.25 });
  assert.equal(v.zoomBy(z, v.ZOOM_WHEEL_STEP).scale.toFixed(4), (1.25 * 1.1).toFixed(4));
  assert.equal(v.zoomBy({ mode: 'custom', scale: 7 }, 2).scale, 8);
  assert.equal(v.zoomBy({ mode: 'custom', scale: 0.11 }, 0.5).scale, 0.1);
  assert.deepEqual(v.ZOOM_ACTUAL, { mode: 'actual', scale: 1 });
});

test('WU11/WU12 a drafting round lists no renders; a finalized one lists all with the Final badge; previous rounds hold only done renders, newest first', () => {
  assert.deepEqual(v.roundRenderRows(STATES.failed), []);
  assert.deepEqual(v.roundRenderRows(STATES.preview), []);
  assert.deepEqual(v.roundRenderRows(STATES.finalized).map((r) => [r.render.k, r.badge]), [[2, 'Final'], [1, null]]);
  const view = videoView({ asset: { round: 3 }, renders: [render(1, { round: 3 }), render(2, { round: 2, id: 'x2' }), render(1, { round: 2, id: 'x1' }), render(1, { round: 1, id: 'y1' }), render(2, { round: 1, id: 'y2', status: 'failed', fileUrl: null })] });
  assert.deepEqual(v.previousRoundRenders(view).map((r) => [r.round, r.renders.map((x) => x.id)]), [[2, ['x2', 'x1']], [1, ['y1']]]);
});

test('WU25 render progress text and the estimate (none before two samples)', () => {
  assert.equal(v.renderProgressText(STATES.rendering.video.renders[0]), '46% · frame 581 of 1,260');
  assert.equal(v.renderProgressText(render(1, { status: 'running', percent: 5 })), '5%');
  assert.equal(v.renderProgressText(render(1, { status: 'queued', queuePosition: 3 })), 'Waiting · 2 ahead');
  assert.equal(v.renderProgressText(render(1, { status: 'queued', queuePosition: 1 })), 'Waiting');
  assert.equal(v.etaText([{ at: 0, percent: 10 }]), null);
  assert.equal(v.etaText([{ at: 0, percent: 10 }, { at: 60_000, percent: 40 }]), 'about 2 min left');
  assert.equal(v.etaText([{ at: 0, percent: 10 }, { at: 1_000, percent: 90 }]), 'less than a minute left');
  assert.equal(v.etaText([{ at: 0, percent: 10 }, { at: 1_000, percent: 10 }]), null);
  assert.equal(v.queuedText(STATES.queued.video.renders[0]), 'Final render is queued. Waiting for "Pricing explained" to finish rendering. One render at a time.');
  assert.equal(v.queuedText(render(1, { status: 'queued', waitingFor: null })), 'Final render is queued. Waiting for another render to finish. One render at a time.');
  assert.match(v.queuedText(render(1, { status: 'queued', waitingFor: 'x'.repeat(300) })), /x{300}/);
});

test('WU14/WU26 progress text at the edges: 0%, 100%, no frame counts, huge frame counts', () => {
  assert.equal(v.renderProgressText(render(1, { status: 'running', percent: 0 })), '0%');
  assert.equal(v.renderProgressText(render(1, { status: 'running', percent: 100, frame: 1260, totalFrames: 1260 })), '100% · frame 1,260 of 1,260');
  assert.equal(v.renderProgressText(render(1, { status: 'running', percent: null })), '0%');
  assert.equal(v.renderProgressText(render(1, { status: 'running', percent: 50, frame: 2 ** 31, totalFrames: 2 ** 32 })), '50% · frame 2,147,483,648 of 4,294,967,296');
});

test('media facts line', () => {
  assert.equal(v.mediaFacts(media('m1', 'a.mp4', 'video', { width: 1080, height: 1920 })), 'video · 0:48 · 1080×1920 · 977 KB');
  assert.equal(v.mediaFacts(media('m2', 'a.png', 'image')), 'image · 977 KB');
});

test('WU26 drag-over text', () => {
  assert.equal(v.dropText(3), 'Drop to add 3 files');
  assert.equal(v.dropText(1), 'Drop to add 1 file');
});

test('WU27 running-list rows: Remotion setup is not stoppable, a render is, with its Building and progress', () => {
  const groups = buildRunningGroups({
    projects: [{ id: 'b1', name: 'Acme' }], commandRunsById: {}, testRunsById: {},
    contentJobsById: {
      j1: { id: 'j1', buildingId: 'b1', kind: 'remotion-setup', status: 'running', startedAt: '2026-10-26T09:00:00.000Z', percent: null },
      r1: { id: 'r1', buildingId: 'b1', kind: 'render', status: 'running', startedAt: '2026-10-26T09:01:00.000Z', conceptId: 'c1', renderId: 'r1', percent: 46 },
      gone: { id: 'gone', buildingId: 'b1', kind: 'render', status: 'complete', startedAt: '2026-10-26T09:01:00.000Z' },
    },
  });
  assert.equal(groups[0].projectName, 'Acme');
  assert.deepEqual(groups[0].rows.map((r) => [r.name, r.stoppable, r.progress, r.conceptId, r.where]), [['Remotion setup', false, undefined, undefined, 'Content Studio'], ['Video render', true, '46%', 'c1', 'Content Studio']]);
});

test('WU28/WU29 delete confirm names the linked item; the script-changed text', () => {
  assert.equal(v.deleteMediaText('logo.svg', ['Logo']), `Delete logo.svg? The agent's code may still use this file, so the next render could fail. It is unlinked from the checklist item "Logo".`);
  assert.doesNotMatch(v.deleteMediaText('a.png', []), /unlinked/);
  assert.match(v.SCRIPT_CHANGED_TEXT, /The script changed after this session started/);
  assert.equal(v.discardText(2), "Round 2 ends and round 3 starts with a fresh conversation and an empty checklist. Round 2's composition code moves to an archive, so the video is rebuilt from scratch.");
});

test('WU30/WU31 performance proxies: unchanged media keeps its objects; one upload row changes alone', () => {
  const before = STATES.preview.video.media;
  const same = v.shareMedia(before, JSON.parse(JSON.stringify(before)));
  assert.equal(same, before, 'a render-progress view leaves the list reference alone');
  const renamed = JSON.parse(JSON.stringify(before));
  renamed[1].name = 'new.png';
  const next = v.shareMedia(before, renamed);
  assert.notEqual(next, before);
  assert.equal(next[0], before[0]);
  assert.notEqual(next[1], before[1]);
  assert.equal(v.shareMedia(undefined, before), before);
  const rows = v.planUploads([{ name: 'a.png', size: 10 }, { name: 'b.png', size: 10 }], 0, 0, (i) => `k${i}`);
  const moved = v.patchUpload(rows, 'k0', { loaded: 5 });
  assert.equal(moved[1], rows[1]);
});

test('C27 (rule) the Remotion tab waits for the composition; Video follows its own rule', () => {
  const posts = [{ platform: 'instagram', format: 'reel' }];
  const tabs = conceptTabStates(posts, { scriptFinalized: true });
  assert.deepEqual(tabs.find((t) => t.key === 'remotion'), { key: 'remotion', label: 'Remotion', enabled: false, reason: 'Start the video in the Video tab first' });
  assert.equal(tabs.find((t) => t.key === 'video').enabled, true);
  assert.equal(conceptTabStates(posts, { scriptFinalized: false }).find((t) => t.key === 'video').enabled, false);
});

const col = { contains: (n) => n === col || n?.inside === true };
const files = (n) => Array.from({ length: n }, (_, i) => ({ name: `f${i}` }));
function drag({ types = ['Files'], items = 3, list = files(2), related = null } = {}) {
  const calls = { prevented: 0, counts: [], dropped: [] };
  const e = { preventDefault: () => { calls.prevented++; }, currentTarget: col, relatedTarget: related, dataTransfer: { types, items: items === null ? undefined : { length: items }, files: list } };
  return { e, calls };
}
function handlers(readOnly = false) {
  const calls = { counts: [], dropped: [] };
  return { calls, h: v.mediaDropHandlers({ readOnly, onDragCount: (c) => calls.counts.push(c), onFiles: (f) => calls.dropped.push(f) }) };
}

test('U1-U6 hasFiles only for the Files type', () => {
  assert.equal(v.hasFiles(['Files']), true);
  assert.equal(v.hasFiles(['text/plain', 'Files']), true);
  for (const t of [['text/plain'], ['text/uri-list'], [], undefined, null, ['files']]) assert.equal(v.hasFiles(t), false);
});

test('U9 a huge drag count reads naturally', () => assert.equal(v.dropText(10000), 'Drop to add 10000 files'));

test('U10-U13 leavesColumn ignores moves onto children', () => {
  assert.equal(v.leavesColumn(col, null), true);
  assert.equal(v.leavesColumn(col, { inside: true }), false);
  assert.equal(v.leavesColumn(col, {}), true);
  assert.equal(v.leavesColumn(col, col), false);
});

test('U14-U17 droppedFiles', () => {
  assert.deepEqual(v.droppedFiles(null, false), []);
  assert.deepEqual(v.droppedFiles([], false), []);
  assert.deepEqual(v.droppedFiles(files(2), true), []);
  assert.equal(v.droppedFiles(files(2), false).length, 2);
});

test('H1/H2 dragover with files is accepted anywhere in the column', () => {
  const { h, calls } = handlers();
  const { e, calls: ev } = drag();
  h.onDragOver({ ...e, target: { inside: true } });
  assert.equal(ev.prevented, 1);
  assert.deepEqual(calls.counts, [3]);
  const noItems = drag({ items: null });
  h.onDragOver(noItems.e);
  assert.deepEqual(calls.counts, [3, 1]);
});

test('H3-H5 dragover is ignored when read-only or for text and link drags', () => {
  for (const [ro, types] of [[true, ['Files']], [false, ['text/plain']], [false, ['text/uri-list']]]) {
    const { h, calls } = handlers(ro);
    const { e, calls: ev } = drag({ types });
    h.onDragOver(e);
    assert.equal(ev.prevented, 0);
    assert.deepEqual(calls.counts, []);
  }
});

test('H6-H8 dragleave clears only when the pointer leaves the column', () => {
  const { h, calls } = handlers();
  h.onDragLeave(drag({ related: { inside: true } }).e);
  assert.deepEqual(calls.counts, []);
  h.onDragLeave(drag({ related: {} }).e);
  h.onDragLeave(drag({ related: null }).e);
  assert.deepEqual(calls.counts, [null, null]);
});

test('H9/H10/H14 a file drop goes to onFiles and clears the highlight', () => {
  for (const n of [2, 201]) {
    const { h, calls } = handlers();
    const { e, calls: ev } = drag({ list: files(n) });
    h.onDrop(e);
    assert.equal(ev.prevented, 1);
    assert.deepEqual(calls.counts, [null]);
    assert.equal(calls.dropped[0].length, n);
  }
});

test('H11/H12 read-only and non-file drops are left alone', () => {
  for (const [ro, types] of [[true, ['Files']], [false, ['text/plain']]]) {
    const { h, calls } = handlers(ro);
    const { e, calls: ev } = drag({ types });
    h.onDrop(e);
    assert.equal(ev.prevented, 0);
    assert.deepEqual(calls, { counts: [], dropped: [] });
  }
});

test('H13 an empty file list is swallowed without queuing', () => {
  const { h, calls } = handlers();
  const { e, calls: ev } = drag({ list: [] });
  h.onDrop(e);
  assert.equal(ev.prevented, 1);
  assert.deepEqual(calls, { counts: [null], dropped: [] });
});
