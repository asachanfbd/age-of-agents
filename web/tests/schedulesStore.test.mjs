import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { serverApi } = await import('../src/lib/serverApi.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE, reportedError } = await import('./errorHelpers.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const SLOTS = [{ id: 'review', label: 'Review', usedWhen: 'x', defaultWorkflowId: 'notes-review' }];

/** A fresh stub with one Building of a type that has a workflow slot and two declared jobs, and a clean store. */
function setup() {
  const stub = installServerStub();
  stub.buildings.types.push({ id: 'scheduled', name: 'Scheduled', slots: SLOTS, agents: [], scheduledJobs: [] });
  stub.schedules.declared.set('scheduled', [
    { id: 'weekly', description: 'Review every week', cron: '0 9 * * 1', enabled: true },
    { id: 'daily', description: 'Check daily', cron: '@daily' },
  ]);
  const building = (id, typeId = 'scheduled') => {
    stub.projects.set(id, { id, typeId, name: id, readOnly: false, readOnlyReason: null, status: 'idle' });
    return id;
  };
  building('alpha', 'plain');
  stub.buildings.types.push({ id: 'plain', name: 'Plain', slots: SLOTS, agents: [], scheduledJobs: [] });
  useWorldStore.setState({ schedulesByProject: {}, scheduleLoadErrorByProject: {}, scheduleHistoryByJob: {}, scheduleRunErrorByJob: {}, workspaceTab: 'tasks', ...CLEAN_ERROR_STATE });
  return { stub, building };
}

const store = () => useWorldStore.getState();
const jobs = (projectId = 'alpha') => store().schedulesByProject[projectId].jobs;
const newJob = (over = {}) => ({ name: 'Weekly review', trigger: { kind: 'cron', cron: '0 9 * * 1' }, target: { kind: 'slot', slotId: 'review', description: 'Review.' }, ...over });

test('S01 loading schedules fills the store for that Building', async () => {
  const { building } = setup();
  building('beta');
  await store().loadSchedules('beta');
  const view = store().schedulesByProject.beta;
  assert.deepEqual([view.projectId, view.timezone, view.hostTimezone, view.missingDefaults], ['beta', null, 'UTC', 0]);
  assert.deepEqual(view.jobs.map((job) => [job.declaredJobId, job.enabled]), [['weekly', true], ['daily', false]]);
  assert.equal(store().schedulesByProject.alpha, undefined);
});

test('S01 a load that fails keeps its message for the panel, and a later good load clears it', async () => {
  setup();
  await store().loadSchedules('no-such-building');
  assert.equal(store().scheduleLoadErrorByProject['no-such-building'], 'This project no longer exists');
  assert.equal(store().schedulesByProject['no-such-building'], undefined);
  await store().loadSchedules('alpha');
  assert.deepEqual(store().scheduleLoadErrorByProject.alpha, undefined);
});

test('S02 create adds the job; a 400 leaves the list unchanged and hands the error and field back, with no notification', async () => {
  setup();
  await store().loadSchedules('alpha');
  assert.deepEqual(await store().createScheduleJob('alpha', newJob()), { ok: true });
  assert.deepEqual(jobs().map((job) => [job.name, job.nextRunAt, job.declaredJobId]), [['Weekly review', '2026-10-12T09:00:00.000Z', null]]);
  const before = jobs();
  const refused = await store().createScheduleJob('alpha', newJob({ trigger: { kind: 'cron', cron: 'every monday' } }));
  assert.deepEqual(refused, { ok: false, status: 400, error: 'Invalid cron expression: it needs 5 fields (minute hour day month weekday)', field: 'trigger.cron' });
  assert.deepEqual(jobs(), before);
  assert.deepEqual((await store().createScheduleJob('alpha', newJob({ target: { kind: 'slot', slotId: 'ghost', description: 'x' } }))).field, 'target.slotId');
  assert.equal(reportedError(), null);
  assert.deepEqual(store().errorNotificationsById, {});
});

test('S03 edit and on/off update the store once the server accepts; a failure leaves the earlier state', async () => {
  setup();
  await store().loadSchedules('alpha');
  await store().createScheduleJob('alpha', newJob());
  const [job] = jobs();
  assert.deepEqual(await store().updateScheduleJob('alpha', job.id, { name: 'Renamed', maxRunsPerDay: 2 }), { ok: true });
  assert.deepEqual([jobs()[0].name, jobs()[0].maxRunsPerDay, jobs()[0].id], ['Renamed', 2, job.id]);
  await store().updateScheduleJob('alpha', job.id, { enabled: false });
  assert.deepEqual([jobs()[0].enabled, jobs()[0].nextRunAt], [false, null]);
  await store().updateScheduleJob('alpha', job.id, { enabled: true });
  assert.deepEqual([jobs()[0].enabled, jobs()[0].nextRunAt], [true, '2026-10-12T09:00:00.000Z']);
  const before = jobs();
  const refused = await store().updateScheduleJob('alpha', job.id, { name: '' });
  assert.deepEqual([refused.ok, refused.status, refused.field], [false, 400, 'name']);
  assert.deepEqual(jobs(), before);
  assert.deepEqual([(await store().updateScheduleJob('alpha', 'gone', { name: 'x' })).status, reportedError()], [404, null]);
});

test('S04 delete removes the job and its loaded history', async () => {
  setup();
  await store().loadSchedules('alpha');
  await store().createScheduleJob('alpha', newJob());
  await store().createScheduleJob('alpha', newJob({ name: 'Other' }));
  const [first, second] = jobs();
  await store().runScheduleJobNow('alpha', first.id);
  await store().loadScheduleHistory('alpha', first.id);
  assert.equal(store().scheduleHistoryByJob[first.id].entries.length, 1);
  assert.deepEqual(await store().deleteScheduleJob('alpha', first.id), { ok: true });
  assert.deepEqual(jobs().map((job) => job.id), [second.id]);
  assert.equal(store().scheduleHistoryByJob[first.id], undefined);
  assert.equal((await store().deleteScheduleJob('alpha', first.id)).status, 404);
});

test('S05 Run now adds the entry; a 409 sets the inline error on that job only, cleared by the next action', async () => {
  setup();
  await store().loadSchedules('alpha');
  await store().createScheduleJob('alpha', newJob());
  await store().createScheduleJob('alpha', newJob({ name: 'Other' }));
  const [job, other] = jobs();
  await store().loadScheduleHistory('alpha', job.id);
  assert.deepEqual(await store().runScheduleJobNow('alpha', job.id), { ok: true, queued: false });
  assert.deepEqual(store().scheduleHistoryByJob[job.id].entries.map((entry) => [entry.startedBy, entry.outcome]), [['run-now', 'running']]);
  assert.deepEqual([jobs()[0].activeRun.outcome, jobs()[0].nextRunAt], ['running', job.nextRunAt], 'the schedule is unchanged');

  const refused = await store().runScheduleJobNow('alpha', job.id);
  assert.deepEqual([refused.ok, refused.status], [false, 409]);
  assert.deepEqual(store().scheduleRunErrorByJob, { [job.id]: 'The previous run is still going (overlap rule: skip)' });
  assert.equal(store().scheduleRunErrorByJob[other.id], undefined);
  assert.equal(store().scheduleHistoryByJob[job.id].entries.length, 1);
  assert.equal(reportedError(), null, 'shown on the job, not as a notification');
  await store().updateScheduleJob('alpha', other.id, { name: 'Other, renamed' });
  assert.deepEqual(store().scheduleRunErrorByJob, {});
});

test('S05 a Run now whose start fails at set-up shows the reason on the job, with its failed entry and failure count', async () => {
  const { stub } = setup();
  await store().loadSchedules('alpha');
  await store().createScheduleJob('alpha', newJob());
  const [job] = jobs();
  await store().loadScheduleHistory('alpha', job.id);
  stub.schedules.failStart = 'Agent "retired" is no longer in the Catalog';
  const result = await store().runScheduleJobNow('alpha', job.id);
  assert.deepEqual(result, { ok: false, status: 409, error: 'Agent "retired" is no longer in the Catalog', field: null });
  assert.deepEqual(store().scheduleRunErrorByJob, { [job.id]: 'Agent "retired" is no longer in the Catalog' });
  assert.deepEqual([jobs()[0].consecutiveFailures, jobs()[0].lastEntry.outcome, jobs()[0].activeRun], [1, 'failed', null]);
  assert.deepEqual(store().scheduleHistoryByJob[job.id].entries.map((entry) => [entry.outcome, entry.note]), [['failed', 'Agent "retired" is no longer in the Catalog']]);
  assert.equal(reportedError(), null);
});

test('S05 a Run now that fails for another reason hands the message back for the panel and sets nothing on the job', async () => {
  setup();
  await store().loadSchedules('alpha');
  const gone = await store().runScheduleJobNow('alpha', 'deleted-elsewhere');
  assert.deepEqual([gone.ok, gone.status, gone.error], [false, 404, 'This job no longer exists']);
  assert.deepEqual(store().scheduleRunErrorByJob, {});
  const view = await import('../src/lib/schedules.ts');
  assert.equal(view.runNowPanelError(gone), 'This job no longer exists');
  assert.equal(view.runNowPanelError({ ok: false, status: 0, error: 'fetch failed' }), 'fetch failed', 'the daemon cannot be reached');
  assert.equal(view.runNowPanelError({ ok: false, status: 500, error: 'boom' }), 'boom');
  assert.equal(view.runNowPanelError({ ok: false, status: 409, error: 'The previous run is still going (overlap rule: skip)' }), null, 'a 409 is shown on the job, not twice');
  assert.equal(view.runNowPanelError({ ok: true, queued: false }), null);
});

test('S06 Run now that the server queues shows the job as queued', async () => {
  setup();
  await store().loadSchedules('alpha');
  await store().createScheduleJob('alpha', newJob({ overlap: 'queue' }));
  const [job] = jobs();
  await store().loadScheduleHistory('alpha', job.id);
  await store().runScheduleJobNow('alpha', job.id);
  assert.deepEqual(await store().runScheduleJobNow('alpha', job.id), { ok: true, queued: true });
  assert.equal(jobs()[0].queued, true);
  assert.deepEqual(store().scheduleHistoryByJob[job.id].entries.map((entry) => entry.outcome), ['queued', 'running']);
  assert.equal((await store().runScheduleJobNow('alpha', job.id)).status, 409);
});

test('S07 setting the timezone updates it and the next-run times', async () => {
  setup();
  await store().loadSchedules('alpha');
  await store().createScheduleJob('alpha', newJob());
  assert.deepEqual(await store().setScheduleTimezone('alpha', 'Asia/Kolkata'), { ok: true });
  assert.deepEqual([store().schedulesByProject.alpha.timezone, jobs()[0].nextRunAt], ['Asia/Kolkata', '2026-10-12T03:30:00.000Z']);
  const refused = await store().setScheduleTimezone('alpha', 'Nowhere');
  assert.deepEqual([refused.status, refused.field, store().schedulesByProject.alpha.timezone], [400, 'timezone', 'Asia/Kolkata']);
  await store().setScheduleTimezone('alpha', null);
  assert.deepEqual([store().schedulesByProject.alpha.timezone, jobs()[0].nextRunAt], [null, '2026-10-12T09:00:00.000Z']);
});

test('S08 restore defaults adds the missing jobs', async () => {
  const { building } = setup();
  building('beta');
  await store().loadSchedules('beta');
  const [weekly] = jobs('beta');
  await store().deleteScheduleJob('beta', weekly.id);
  assert.equal(store().schedulesByProject.beta.missingDefaults, 1);
  assert.deepEqual(await store().restoreScheduleDefaults('beta'), { ok: true });
  assert.deepEqual([store().schedulesByProject.beta.missingDefaults, jobs('beta').map((job) => job.declaredJobId).sort()], [0, ['daily', 'weekly']]);
});

test('S09 loading more history appends without repeats', async () => {
  const { stub } = setup();
  await store().loadSchedules('alpha');
  await store().createScheduleJob('alpha', newJob({ overlap: 'parallel' }));
  const [job] = jobs();
  for (let i = 0; i < 120; i += 1) await serverApi.runScheduleJobNow('alpha', job.id);
  await store().loadScheduleHistory('alpha', job.id);
  assert.deepEqual([store().scheduleHistoryByJob[job.id].entries.length, store().scheduleHistoryByJob[job.id].nextCursor], [50, '71']);
  // Entries that arrive between two pages do not shift the second page.
  for (let i = 0; i < 3; i += 1) await serverApi.runScheduleJobNow('alpha', job.id);
  await store().loadScheduleHistory('alpha', job.id, { more: true });
  await store().loadScheduleHistory('alpha', job.id, { more: true });
  const loaded = store().scheduleHistoryByJob[job.id];
  assert.deepEqual([loaded.entries.length, loaded.nextCursor, loaded.entries[0].seq, loaded.entries.at(-1).seq], [120, null, 120, 1]);
  assert.equal(new Set(loaded.entries.map((entry) => entry.id)).size, 120);
  const requests = stub.schedules.requests.length;
  await store().loadScheduleHistory('alpha', job.id, { more: true });
  assert.equal(stub.schedules.requests.length, requests, 'with nothing older, no request is sent');
});

test('S10 a /ws schedule event updates the job and history of the right Building; one for a Building not loaded is ignored', async () => {
  const { building } = setup();
  building('beta');
  await store().loadSchedules('alpha');
  await store().createScheduleJob('alpha', newJob());
  const [job] = jobs();
  await store().loadScheduleHistory('alpha', job.id);
  const state = store();
  const changed = { ...state.schedulesByProject.alpha, jobs: [{ ...job, name: 'Changed elsewhere' }] };
  const afterJobs = mergeWorkerEvent(state, { type: 'schedules', projectId: 'alpha', schedules: changed });
  assert.equal(afterJobs.schedulesByProject.alpha.jobs[0].name, 'Changed elsewhere');
  assert.deepEqual(mergeWorkerEvent(state, { type: 'schedules', projectId: 'beta', schedules: { ...changed, projectId: 'beta' } }), {}, 'beta was never opened');

  const entry = { id: 'e-live', jobId: job.id, projectId: 'alpha', seq: 1, startedBy: 'schedule', outcome: 'running', runId: 'r1', runStartedAt: 'x' };
  const withEntry = mergeWorkerEvent(state, { type: 'scheduleEntry', projectId: 'alpha', jobId: job.id, entry });
  assert.deepEqual(withEntry.scheduleHistoryByJob[job.id].entries, [entry]);
  const settled = mergeWorkerEvent({ ...state, ...withEntry }, { type: 'scheduleEntry', projectId: 'alpha', jobId: job.id, entry: { ...entry, outcome: 'succeeded' } });
  assert.deepEqual(settled.scheduleHistoryByJob[job.id].entries.map((e) => e.outcome), ['succeeded'], 'the same entry is updated, not added twice');
  assert.deepEqual(mergeWorkerEvent(state, { type: 'scheduleEntry', projectId: 'alpha', jobId: 'not-open', entry }), {}, 'a job whose history is not open is ignored');

  const deleted = mergeWorkerEvent({ ...state, ...withEntry }, { type: 'schedules', projectId: 'alpha', schedules: { ...changed, jobs: [] } });
  assert.deepEqual([deleted.schedulesByProject.alpha.jobs, deleted.scheduleHistoryByJob[job.id]], [[], undefined], 'a deleted job takes its loaded history with it');
});

test('S11 a 409 from a read-only Building surfaces the server\'s reason', async () => {
  const { stub } = setup();
  await store().loadSchedules('alpha');
  await store().createScheduleJob('alpha', newJob());
  const [job] = jobs();
  Object.assign(stub.projects.get('alpha'), { readOnly: true, readOnlyReason: 'The "plain" Building type is no longer available.' });
  const reason = { ok: false, status: 409, error: 'The "plain" Building type is no longer available.', field: null };
  assert.deepEqual(await store().createScheduleJob('alpha', newJob()), reason);
  assert.deepEqual(await store().updateScheduleJob('alpha', job.id, { enabled: false }), reason);
  assert.deepEqual(await store().deleteScheduleJob('alpha', job.id), reason);
  assert.deepEqual(await store().setScheduleTimezone('alpha', 'UTC'), reason);
  assert.deepEqual(await store().restoreScheduleDefaults('alpha'), reason);
  assert.deepEqual(await store().runScheduleJobNow('alpha', job.id), reason);
  assert.deepEqual(store().scheduleRunErrorByJob, { [job.id]: reason.error });
  await store().loadSchedules('alpha');
  await store().loadScheduleHistory('alpha', job.id);
  assert.deepEqual([jobs().length, store().scheduleHistoryByJob[job.id].entries.length], [1, 0], 'reading still works');
});

test('S12 switching Building while a load is in flight does not put the first Building\'s jobs under the second', async () => {
  const { building } = setup();
  building('beta');
  const realFetch = globalThis.fetch;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  // The first Building's reply is held until after the second Building's has arrived.
  globalThis.fetch = async (url, init) => {
    const response = await realFetch(url, init);
    if (String(url).includes('/projects/beta/')) await held;
    return response;
  };
  try {
    const slow = store().loadSchedules('beta');
    await store().loadSchedules('alpha');
    assert.deepEqual(Object.keys(store().schedulesByProject), ['alpha']);
    release();
    await slow;
    assert.deepEqual([store().schedulesByProject.alpha.projectId, store().schedulesByProject.alpha.jobs.length], ['alpha', 0]);
    assert.deepEqual([store().schedulesByProject.beta.projectId, store().schedulesByProject.beta.jobs.length], ['beta', 2]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a scheduled-job notification opens that Building\'s Settings → Schedules', async () => {
  setup();
  useWorldStore.setState({ projects: [{ id: 'alpha', name: 'alpha' }] });
  const subject = { type: 'scheduledJob', projectId: 'alpha', jobId: 'j1' };
  await store().openNotificationTarget({ id: 'n1', kind: 'schedule.run_failed', subject, projectId: 'alpha', readAt: null });
  assert.deepEqual([store().workspaceProjectId, store().workspaceTab, store().workspaceSettingsSection], ['alpha', 'settings', 'schedules']);
  const center = await import('../src/lib/notificationCenter.ts');
  assert.equal(center.sameSubjectIdentity(subject, { ...subject }), true);
  assert.equal(center.sameSubjectIdentity(subject, { ...subject, jobId: 'j2' }), false);
  assert.match(src('ui/NotificationCenter.tsx'), /case 'scheduledJob':/);
});

test('C10 every scheduler route the store calls has a matching route in the server stub', async () => {
  const api = src('lib/serverApi.ts');
  const called = [...api.matchAll(/request\(`(\/api\/projects\/\$\{id\}\/schedules[^`]*)`(?:, \{ method: '(\w+)')?/g)].map(([, path, method]) => `${method ?? 'GET'} ${path.replace(/\/history.*$/, '/history').replace(/\$\{[^}]*\}/g, 'X').split('?')[0]}`);
  assert.deepEqual(called.sort(), [
    'DELETE /api/projects/X/schedules/jobs/X', 'GET /api/projects/X/schedules', 'GET /api/projects/X/schedules/cron-preview', 'GET /api/projects/X/schedules/jobs/X/history',
    'PATCH /api/projects/X/schedules', 'PATCH /api/projects/X/schedules/jobs/X', 'POST /api/projects/X/schedules/jobs', 'POST /api/projects/X/schedules/jobs/X/run', 'POST /api/projects/X/schedules/restore-defaults',
  ].sort());
  // Each one answers from the stub's schedules routes, never the "unhandled" fallback.
  const { stub } = setup();
  await serverApi.createScheduleJob('alpha', newJob());
  const [job] = (await serverApi.getSchedules('alpha')).jobs;
  await serverApi.setScheduleTimezone('alpha', null);
  await serverApi.restoreScheduleDefaults('alpha');
  await serverApi.previewScheduleCron('alpha', '0 9 * * 1');
  await serverApi.updateScheduleJob('alpha', job.id, { name: 'x' });
  await serverApi.runScheduleJobNow('alpha', job.id);
  await serverApi.getScheduleHistory('alpha', job.id);
  await serverApi.getScheduleHistory('alpha', job.id, '5');
  await serverApi.deleteScheduleJob('alpha', job.id);
  assert.equal(stub.schedules.requests.length, 10);
  await assert.rejects(serverApi.previewScheduleCron('alpha', 'nope'), { status: 400 });
  // The stub's routes are the daemon's: every path it matches is one the daemon mounts.
  const routes = readFileSync(new URL('../../server/src/api/scheduleRoutes.ts', import.meta.url), 'utf8');
  for (const path of ["'/projects/:id/schedules'", "'/projects/:id/schedules/cron-preview'", "'/projects/:id/schedules/restore-defaults'", "'/projects/:id/schedules/jobs'", "'/projects/:id/schedules/jobs/:jobId'", "'/projects/:id/schedules/jobs/:jobId/run'", "'/projects/:id/schedules/jobs/:jobId/history'"]) {
    assert.ok(routes.includes(path), path);
  }
});
