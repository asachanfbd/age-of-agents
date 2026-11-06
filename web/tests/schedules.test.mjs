import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
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

const view = await import('../src/lib/schedules.ts');

// Sun 11 Oct 2026 11:20 Asia/Kolkata, the mockup's "now".
const NOW = Date.parse('2026-10-11T05:50:00Z');
const cron = (expression) => ({ kind: 'cron', cron: expression });
const folder = (intervalSeconds = 300) => ({ kind: 'file', path: './briefs', detect: 'hash', intervalSeconds });
const endpoint = (intervalSeconds = 900, jsonField = 'plans[0].price') => ({ kind: 'api', url: 'https://api.example.com/pricing', jsonField, intervalSeconds });
const job = (over = {}) => ({
  id: 'j1', projectId: 'p1', declaredJobId: null, name: 'Analyse competitors', enabled: true, trigger: cron('0 9 * * 1'),
  target: { kind: 'slot', slotId: 'research', description: 'Analyse them.' }, overlap: 'skip', missedPolicy: 'skip', maxRunsPerDay: null,
  maxFiveHourPercent: null, maxWeeklyPercent: null, needsApproval: false, failureThreshold: 3, consecutiveFailures: 0, autoDisabled: false,
  nextRunAt: '2026-10-12T03:30:00.000Z', pollError: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  runsToday: 0, activeRun: null, queued: false, lastEntry: null, ...over,
});
const entry = (over = {}) => ({
  id: 'e1', jobId: 'j1', projectId: 'p1', seq: 1, startedBy: 'schedule', outcome: 'succeeded', dueAt: '2026-10-05T03:30:00.000Z',
  startedAt: '2026-10-05T03:30:00.000Z', finishedAt: '2026-10-05T03:44:00.000Z', durationMs: 14 * 60_000, note: null, change: null,
  runId: 'run-1', runStartedAt: '2026-10-05T03:30:00.000Z', deferredUntil: null, ...over,
});
const SLOTS = [{ id: 'research', label: 'Research' }, { id: 'write', label: 'Write content' }];
const AGENTS = [{ id: 'researcher', name: 'Researcher' }];

test('W01 a cron trigger reads in plain words for the four presets and as the expression otherwise', () => {
  assert.deepEqual(['0 * * * *', '0 9 * * *', '0 9 * * 1', '0 10 */3 * *'].map((expression) => view.triggerLabel(cron(expression))),
    ['Every hour, on the hour', 'Every day at 09:00', 'Every Monday at 09:00', 'Every 3 days at 10:00']);
  assert.equal(view.triggerLabel(cron('15 4 1 * *')), '15 4 1 * *');
  assert.equal(view.cronLabel(' 0 9 * * 1 '), 'Every Monday at 09:00');
  assert.deepEqual(view.CRON_PRESETS.map((preset) => preset.chip), ['Every hour', 'Every day 09:00', 'Every Monday 09:00', 'Every 3 days 10:00']);
});

test('W02 poll triggers say what is watched and how often, with singular and plural units', () => {
  assert.equal(view.triggerLabel(folder(300)), 'Folder changes, checked every 5 min');
  assert.equal(view.triggerLabel(endpoint(900)), 'API changes, checked every 15 min');
  assert.deepEqual([60, 3600, 7200, 86_400, 172_800, 90, 1].map(view.intervalLabel), ['1 min', '1 hour', '2 hours', '1 day', '2 days', '90 seconds', '1 second']);
  assert.equal(view.triggerDetail(folder()), './briefs (by content hash)');
  assert.equal(view.triggerDetail({ ...folder(), detect: 'mtime' }), './briefs (by modified time)');
  assert.equal(view.triggerDetail(endpoint()), 'GET https://api.example.com/pricing field: plans[0].price');
  assert.equal(view.triggerDetail(endpoint(900, null)), 'GET https://api.example.com/pricing');
  assert.equal(view.triggerDetail(cron('0 9 * * 1')), '0 9 * * 1');
});

test('W03 the target names its slot or its agent; a slot the type no longer has shows as unknown', () => {
  assert.equal(view.targetLabel({ kind: 'slot', slotId: 'research', description: 'x' }, SLOTS, AGENTS), 'Workflow slot: Research');
  assert.equal(view.targetLabel({ kind: 'slot', slotId: 'gone', description: 'x' }, SLOTS, AGENTS), 'Workflow slot: unknown (gone)');
  assert.equal(view.targetLabel({ kind: 'prompt', agentId: 'researcher', prompt: 'x' }, SLOTS, AGENTS), 'Single agent prompt (Researcher)');
  assert.equal(view.targetLabel({ kind: 'prompt', agentId: null, prompt: 'x' }, SLOTS, AGENTS), 'Single agent prompt (default agent)');
  assert.equal(view.targetLabel({ kind: 'prompt', agentId: 'retired', prompt: 'x' }, SLOTS, AGENTS), 'Single agent prompt (unknown agent retired)');
});

test('W04 "Next run" for a schedule and "Next check" for a watch job; "Off" when disabled; its own text with no next time', () => {
  assert.equal(view.nextLabel(cron('0 9 * * 1')), 'Next run');
  assert.equal(view.nextLabel(folder()), 'Next check');
  assert.equal(view.nextLabel(endpoint()), 'Next check');
  assert.equal(view.nextText(job({ enabled: false }), NOW, 'UTC'), 'Off');
  assert.equal(view.nextText(job({ nextRunAt: null }), NOW, 'UTC'), 'No upcoming run');
  assert.equal(view.nextText(job(), NOW, 'Asia/Kolkata'), 'Mon 12 Oct, 09:00 (in 22 h)');
});

test('W05 relative times, and dates in the Building\'s timezone rather than the browser\'s', () => {
  const at = (minutes) => view.relativeTime(NOW + minutes * 60_000, NOW);
  assert.deepEqual([at(22 * 60), at(10), at(2 * 24 * 60), at(59), at(60), at(47 * 60), at(48 * 60)], ['in 22 h', 'in 10 min', 'in 2 days', 'in 59 min', 'in 1 h', 'in 47 h', 'in 2 days']);
  assert.deepEqual([at(0), at(-5), at(0.2)], ['due now', 'due now', 'due now'], 'a time that has passed is overdue');
  const instant = '2026-10-12T03:30:00.000Z';
  assert.equal(view.formatInZone(instant, 'Asia/Kolkata'), 'Mon 12 Oct, 09:00');
  assert.equal(view.formatInZone(instant, 'America/New_York'), 'Sun 11 Oct, 23:30');
  assert.equal(view.formatInZone('2026-10-12T00:05:00.000Z', 'UTC'), 'Mon 12 Oct, 00:05', 'midnight reads 00, not 24');
  assert.equal(view.effectiveTimezone({ timezone: null, hostTimezone: 'Asia/Kolkata' }), 'Asia/Kolkata');
  assert.equal(view.effectiveTimezone({ timezone: 'UTC', hostTimezone: 'Asia/Kolkata' }), 'UTC');
});

test('W06 a badge for every outcome, and "Never ran"', () => {
  const outcomes = ['succeeded', 'failed', 'running', 'queued', 'awaiting-approval', 'skipped', 'deferred', 'check-failed', 'stopped'];
  assert.deepEqual(outcomes.map((outcome) => view.outcomeBadge(outcome)), [
    { label: 'Succeeded', tone: 'ok' }, { label: 'Failed', tone: 'bad' }, { label: 'Running', tone: 'info' }, { label: 'Queued', tone: 'neutral' },
    { label: 'Waiting for approval', tone: 'warn' }, { label: 'Skipped', tone: 'neutral' }, { label: 'Deferred', tone: 'warn' },
    { label: 'Check failed', tone: 'bad' }, { label: 'Stopped', tone: 'neutral' },
  ]);
  for (const none of [null, undefined]) assert.deepEqual(view.outcomeBadge(none), { label: 'Never ran', tone: 'neutral' });
});

test('W07 the history filter splits entries into runs and everything else with no overlap', () => {
  const entries = [
    entry({ id: 'ran' }), entry({ id: 'going', outcome: 'running', finishedAt: null, durationMs: null }),
    entry({ id: 'skipped', outcome: 'skipped', runId: null, runStartedAt: null }), entry({ id: 'check', outcome: 'check-failed', runId: null, runStartedAt: null }),
    entry({ id: 'deferred', outcome: 'deferred', runId: null, runStartedAt: null }), entry({ id: 'deleted-run', outcome: 'stopped', runId: null }),
  ];
  const ids = (filter) => view.filterHistory(entries, filter).map((e) => e.id);
  assert.deepEqual(ids('all'), entries.map((e) => e.id));
  assert.deepEqual(ids('runs'), ['ran', 'going', 'deleted-run']);
  assert.deepEqual(ids('other'), ['skipped', 'check', 'deferred']);
  assert.equal(new Set([...ids('runs'), ...ids('other')]).size, entries.length);
  assert.deepEqual(view.filterHistory([], 'runs'), []);
  assert.equal(view.HISTORY_EMPTY_TEXT, 'Nothing here yet.');
  assert.deepEqual(view.HISTORY_FILTERS.map((f) => f.label), ['All', 'Runs', 'Skipped and errors']);
});

test('W08 a history row: who started it, how long it took, and a run link only when there is a run', () => {
  assert.deepEqual(['schedule', 'poll', 'run-now', 'catch-up'].map(view.startedByLabel), ['Schedule', 'Poll', 'Run now', 'Catch-up']);
  assert.equal(view.durationText(entry(), NOW), '14 min');
  assert.equal(view.durationText(entry({ durationMs: 20_000 }), NOW), 'under 1 min');
  assert.equal(view.durationText(entry({ durationMs: 3 * 3_600_000 }), NOW), '3 h');
  assert.equal(view.durationText(entry({ durationMs: null, finishedAt: null, runStartedAt: new Date(NOW - 5 * 60_000).toISOString() }), NOW), '5 min so far');
  assert.equal(view.durationText(entry({ durationMs: null, finishedAt: null, runStartedAt: new Date(NOW + 60_000).toISOString() }), NOW), 'under 1 min so far', 'never negative');
  assert.equal(view.durationText(entry({ durationMs: null, runStartedAt: null, finishedAt: '2026-10-05T03:30:00.000Z' }), NOW), '-');
  assert.deepEqual(view.historyRow(entry({ startedBy: 'poll', change: 'plans[0].price 49 to 59', note: 'Approved.' }), NOW, 'Asia/Kolkata', null), {
    id: 'e1', when: 'Mon 5 Oct, 09:00', startedBy: 'Poll', badge: { label: 'Succeeded', tone: 'ok' }, duration: '14 min', details: 'Change: plans[0].price 49 to 59. Approved.', runId: 'run-1',
  });
  const skipped = view.historyRow(entry({ outcome: 'skipped', runId: null, runStartedAt: null, durationMs: null, note: 'Daily limit of 6 runs reached' }), NOW, 'UTC', null);
  assert.deepEqual([skipped.runId, skipped.duration, skipped.details], [null, '-', 'Daily limit of 6 runs reached']);
});

test('W09 the notes under a job: turned off after N failures, the latest failed check, and the refused Run now', () => {
  assert.deepEqual(view.jobNotes(job(), null), []);
  assert.deepEqual(view.jobNotes(job({ autoDisabled: true, consecutiveFailures: 3 }), null), [
    { kind: 'auto-disabled', role: 'status', text: 'Turned off after 3 failed runs in a row. Switch it back on to try again; the count starts from zero.' },
  ]);
  assert.match(view.jobNotes(job({ autoDisabled: true, consecutiveFailures: 1 }), null)[0].text, /^Turned off after 1 failed run in a row\./);
  assert.deepEqual(view.jobNotes(job({ pollError: 'The address answered 503' }), undefined), [
    { kind: 'poll-error', role: 'status', text: 'Last check failed: The address answered 503. No run was started. It is checked again at the next interval.' },
  ]);
  const refused = 'The previous run is still going (overlap rule: skip)';
  assert.deepEqual(view.jobNotes(job(), refused), [{ kind: 'run-error', role: 'alert', text: `Cannot start now: ${refused}` }]);
  assert.deepEqual(view.jobNotes(job({ autoDisabled: true, consecutiveFailures: 3, pollError: 'x' }), refused).map((note) => note.kind), ['auto-disabled', 'poll-error', 'run-error']);
});

test('W10 the guardrail cards: overlap, missed runs, budget, approval and the failure count', () => {
  const card = (over, label) => view.guardrailCards(job(over)).find((c) => c.label === label).value;
  assert.deepEqual(['skip', 'queue', 'parallel'].map((overlap) => card({ overlap }, 'If the last run is still going')), ['Skip the new run', 'Queue one run', 'Allow runs side by side']);
  assert.deepEqual(['skip', 'once', null].map((missedPolicy) => card({ missedPolicy }, 'After the app was off')), ['Skip missed runs', 'Run once to catch up', 'Does not apply to a watch job']);
  assert.equal(card({ maxRunsPerDay: 2 }, 'Budget'), 'Up to 2 runs a day (0 used today)');
  assert.equal(card({ maxRunsPerDay: 1, runsToday: 1 }, 'Budget'), '1 run a day (1 used today)');
  assert.equal(card({}, 'Budget'), 'No limit');
  assert.equal(card({ maxRunsPerDay: 6, runsToday: 2, maxFiveHourPercent: 80, maxWeeklyPercent: 90 }, 'Budget'), 'Up to 6 runs a day (2 used today); not above 80% of 5-hour usage; not above 90% of weekly usage');
  assert.equal(card({ maxWeeklyPercent: 50 }, 'Budget'), 'not above 50% of weekly usage');
  assert.deepEqual([card({ needsApproval: true }, 'Approval'), card({}, 'Approval')], ['Pauses for approval before publishing or sending', 'Not needed']);
  assert.equal(card({}, 'Failed runs in a row'), '0 of 3 before the job turns itself off');
  assert.equal(card({ consecutiveFailures: 2, failureThreshold: 5 }, 'Failed runs in a row'), '2 of 5 before the job turns itself off');
});

test('W11 the delete confirmation: plain, with a run going, and for a job from the type', () => {
  assert.deepEqual(view.deleteConfirmation(job()), { title: 'Delete this job?', body: '"Analyse competitors" and its run history are removed.' });
  assert.match(view.deleteConfirmation(job({ activeRun: { entryId: 'e', runId: 'r', outcome: 'running' } })).body, /A run of this job is going\. It carries on, but is no longer listed here\.$/);
  assert.match(view.deleteConfirmation(job({ declaredJobId: 'weekly' })).body, /You can add it back with "Restore default jobs"\.$/);
  const both = view.deleteConfirmation(job({ declaredJobId: 'weekly', activeRun: { entryId: 'e', runId: 'r', outcome: 'running' } })).body;
  assert.match(both, /is going.*Restore default jobs/);
});

const form = (over = {}) => ({ ...view.emptyJobForm(SLOTS), name: 'Job', slot: 'research', task: 'Do it.', ...over });
const SLOT_IDS = SLOTS.map((slot) => slot.id);

test('W12 the editor checks each field under the server\'s rules and counts the problems', () => {
  assert.deepEqual(view.validateJobForm(form(), SLOT_IDS), {});
  const error = (over, field) => view.validateJobForm(form(over), SLOT_IDS)[field];
  assert.equal(error({ name: '  ' }, 'name'), 'Give the job a name.');
  assert.equal(error({ name: 'x'.repeat(121) }, 'name'), 'The name must be at most 120 characters.');
  assert.equal(error({ name: 'x'.repeat(120) }, 'name'), undefined);
  assert.equal(error({ cron: '0 9 * *' }, 'cron'), 'Invalid cron expression: it needs 5 fields (minute hour day month weekday) and has 4.');
  assert.equal(error({ cron: '' }, 'cron'), 'Enter a cron expression.');
  assert.equal(error({ cron: ' @daily ' }, 'cron'), undefined);
  const watch = { triggerKind: 'file', path: 'inbox' };
  assert.equal(error({ ...watch, every: '59', unit: 'seconds' }, 'every'), 'The check interval must be at least 1 minute.');
  assert.equal(error({ ...watch, every: '1', unit: 'minutes' }, 'every'), undefined);
  assert.equal(error({ ...watch, every: '721', unit: 'hours' }, 'every'), 'The check interval must be at most 30 days.');
  assert.equal(error({ ...watch, every: '720', unit: 'hours' }, 'every'), undefined);
  assert.equal(error({ ...watch, every: '1.5', unit: 'minutes' }, 'every'), 'Enter a whole number of minutes.');
  assert.equal(error({ ...watch, every: '', unit: 'hours' }, 'every'), 'Enter a whole number of hours.');
  assert.equal(error({ triggerKind: 'file', path: '' }, 'path'), 'Enter the folder or file to watch.');
  assert.equal(error({ triggerKind: 'file', path: 'x'.repeat(1025) }, 'path'), 'The path must be at most 1,024 characters.');
  for (const url of ['', 'example.com', 'ftp://example.com']) assert.equal(error({ triggerKind: 'api', url }, 'url'), 'Enter a full address starting with http:// or https://.');
  assert.equal(error({ triggerKind: 'api', url: 'HTTP://Example.com' }, 'url'), undefined);
  assert.equal(error({ triggerKind: 'api', url: `https://e.com/${'a'.repeat(2048)}` }, 'url'), 'The address must be at most 2,048 characters.');
  assert.equal(error({ triggerKind: 'api', url: 'https://e.com', jsonField: 'a'.repeat(257) }, 'jsonField'), 'The JSON field must be at most 256 characters.');
  assert.equal(error({ slot: '' }, 'slot'), 'Choose a workflow slot.');
  assert.equal(error({ slot: 'gone' }, 'slot'), 'Choose a workflow slot.');
  assert.equal(error({ task: '' }, 'task'), 'Describe what each run should do.');
  assert.equal(error({ task: 'x'.repeat(10_001) }, 'task'), 'The task description must be at most 10,000 characters.');
  assert.equal(error({ targetKind: 'prompt', prompt: ' ' }, 'prompt'), 'Write the prompt for the agent.');
  assert.equal(error({ targetKind: 'prompt', prompt: 'x'.repeat(10_001) }, 'prompt'), 'The prompt must be at most 10,000 characters.');
  for (const perDay of ['0', '1001', '2.5', '-1', 'x']) assert.equal(error({ perDay }, 'perDay'), 'Enter a whole number from 1 to 1,000, or leave empty for no limit.');
  for (const perDay of ['', '1', '1000']) assert.equal(error({ perDay }, 'perDay'), undefined);
  for (const failures of ['', '0', '101', '1.5']) assert.equal(error({ failures }, 'failures'), 'Enter a whole number from 1 to 100.');
  for (const field of ['fiveHour', 'weekly']) {
    for (const value of ['0', '101', '50.5']) assert.equal(error({ [field]: value }, field), 'Enter a whole percentage from 1 to 100, or leave empty.');
    for (const value of ['', '1', '100']) assert.equal(error({ [field]: value }, field), undefined);
  }
  // Fields of a trigger or target that is not selected are not checked.
  assert.deepEqual(view.validateJobForm(form({ triggerKind: 'file', path: 'inbox', cron: 'nonsense', url: '' }), SLOT_IDS), {});
  assert.deepEqual(view.validateJobForm(form({ targetKind: 'prompt', prompt: 'Go', slot: '', task: '' }), SLOT_IDS), {});
  assert.equal(view.errorSummary({}), null);
  assert.equal(view.errorSummary({ name: 'x' }), 'Fix 1 problem to save.');
  assert.equal(view.errorSummary({ name: 'x', cron: 'y' }), 'Fix 2 problems to save.');
});

test('W13 form to request and back: intervals keep their unit, hidden fields are not sent, a watch job has no missed-run rule', () => {
  assert.deepEqual([300, 90, 7200, 60, 86_400, 3601].map(view.splitInterval), [
    { every: '5', unit: 'minutes' }, { every: '90', unit: 'seconds' }, { every: '2', unit: 'hours' }, { every: '1', unit: 'minutes' }, { every: '24', unit: 'hours' }, { every: '3601', unit: 'seconds' },
  ]);
  const cronRequest = view.formToRequest(form({ name: ' Weekly ', cron: ' 0 9 * * 1 ', missedPolicy: 'once', perDay: '2', fiveHour: '80', path: 'left over', url: 'https://left.over', prompt: 'left over' }));
  assert.deepEqual(cronRequest, {
    name: 'Weekly', trigger: { kind: 'cron', cron: '0 9 * * 1' }, target: { kind: 'slot', slotId: 'research', description: 'Do it.' }, overlap: 'skip',
    maxRunsPerDay: 2, maxFiveHourPercent: 80, maxWeeklyPercent: null, needsApproval: false, failureThreshold: 3, missedPolicy: 'once',
  });
  const watchRequest = view.formToRequest(form({ triggerKind: 'api', url: ' https://e.com/x ', jsonField: ' ', every: '5', unit: 'minutes', missedPolicy: 'once', targetKind: 'prompt', agent: '', prompt: ' Go. ', needsApproval: true }));
  assert.deepEqual(watchRequest, {
    name: 'Job', trigger: { kind: 'api', url: 'https://e.com/x', jsonField: null, intervalSeconds: 300 }, target: { kind: 'prompt', agentId: null, prompt: 'Go.' }, overlap: 'skip',
    maxRunsPerDay: null, maxFiveHourPercent: null, maxWeeklyPercent: null, needsApproval: true, failureThreshold: 3,
  });
  assert.equal('missedPolicy' in watchRequest, false);
  assert.deepEqual(view.formToRequest(form({ triggerKind: 'file', path: ' inbox ', detect: 'hash', every: '90', unit: 'seconds' })).trigger, { kind: 'file', path: 'inbox', detect: 'hash', intervalSeconds: 90 });
  assert.equal(view.formToRequest(form({ targetKind: 'prompt', agent: 'researcher', prompt: 'x' })).target.agentId, 'researcher');

  const stored = job({ trigger: folder(300), missedPolicy: null, target: { kind: 'prompt', agentId: 'researcher', prompt: 'Summarise.' }, maxRunsPerDay: 6, maxWeeklyPercent: 90, needsApproval: true, overlap: 'queue', failureThreshold: 5 });
  const loaded = view.jobToForm(stored);
  assert.deepEqual([loaded.triggerKind, loaded.path, loaded.detect, loaded.every, loaded.unit, loaded.targetKind, loaded.agent, loaded.prompt, loaded.perDay, loaded.weekly, loaded.fiveHour, loaded.failures, loaded.overlap, loaded.needsApproval, loaded.missedPolicy],
    ['file', './briefs', 'hash', '5', 'minutes', 'prompt', 'researcher', 'Summarise.', '6', '90', '', '5', 'queue', true, 'skip']);
  const roundTrip = view.formToRequest(loaded);
  assert.deepEqual([roundTrip.trigger, roundTrip.target, roundTrip.maxRunsPerDay], [stored.trigger, stored.target, 6]);
  const apiForm = view.jobToForm(job({ trigger: endpoint(90, null) }));
  assert.deepEqual([apiForm.url, apiForm.jsonField, apiForm.every, apiForm.unit, apiForm.slot, apiForm.task], ['https://api.example.com/pricing', '', '90', 'seconds', 'research', 'Analyse them.']);
  assert.equal(view.emptyJobForm([{ id: 'only' }]).slot, 'only', 'a type with one slot has it chosen');
  assert.equal(view.emptyJobForm(SLOTS).slot, '');
});

test('W14 a refused save lands on the field the server named plus the summary; an unknown field shows in the summary only', () => {
  assert.deepEqual(view.serverErrorToForm({ message: 'Invalid cron expression: minute "61" is out of range (0-59)', field: 'trigger.cron' }), {
    errors: { cron: 'Invalid cron expression: minute "61" is out of range (0-59)' }, summary: 'Fix 1 problem to save.',
  });
  const mapped = { name: 'name', 'trigger.path': 'path', 'trigger.url': 'url', 'trigger.jsonField': 'jsonField', 'trigger.intervalSeconds': 'every', 'target.slotId': 'slot', 'target.description': 'task', 'target.agentId': 'agent', 'target.prompt': 'prompt', 'target.commandId': 'command', maxRunsPerDay: 'perDay', failureThreshold: 'failures', maxFiveHourPercent: 'fiveHour', maxWeeklyPercent: 'weekly' };
  for (const [serverField, formField] of Object.entries(mapped)) assert.deepEqual(Object.keys(view.serverErrorToForm({ message: 'm', field: serverField }).errors), [formField]);
  for (const field of ['overlap', 'body', null, 'toString']) assert.deepEqual(view.serverErrorToForm({ message: 'The overlap rule must be one of: skip, queue, parallel', field }), { errors: {}, summary: 'The overlap rule must be one of: skip, queue, parallel' });
});

test('W15 on a read-only Building the changing controls are disabled; opening, Back, the history filter and Open run are not', () => {
  const readOnly = view.scheduleControls(true);
  const changing = ['newJob', 'toggle', 'runNow', 'edit', 'delete', 'timezone', 'restoreDefaults'];
  const looking = ['openJob', 'back', 'historyFilter', 'openRun', 'loadMore'];
  assert.deepEqual(changing.map((control) => readOnly[control].disabled), changing.map(() => true));
  assert.deepEqual(looking.map((control) => readOnly[control].disabled), looking.map(() => false));
  assert.ok(Object.values(view.scheduleControls(false)).every((control) => control.disabled === false));
  assert.deepEqual(Object.keys(readOnly).sort(), [...changing, ...looking].sort());
});

test('W16 timezone options: the host\'s first, labelled as this computer\'s; a current value the list lacks is kept', () => {
  const options = view.timezoneOptions('Asia/Kolkata', null, ['UTC', 'Europe/London', 'Asia/Kolkata', 'America/New_York']);
  assert.deepEqual(options, [
    { value: '', label: "Asia/Kolkata (this computer's)" }, { value: 'America/New_York', label: 'America/New_York' },
    { value: 'Europe/London', label: 'Europe/London' }, { value: 'UTC', label: 'UTC' },
  ]);
  assert.deepEqual(view.timezoneOptions('UTC', 'Antarctica/Troll', ['UTC', 'Europe/London']).map((o) => o.value), ['', 'Antarctica/Troll', 'Europe/London']);
  assert.deepEqual(view.timezoneOptions('UTC', 'Europe/London', ['Europe/London']).map((o) => o.value), ['', 'Europe/London'], 'listed once');
  assert.deepEqual(view.timezoneOptions('UTC', null, []), [{ value: '', label: "UTC (this computer's)" }]);
});

test('W17 Open run targets that run; an entry whose run no longer exists has no link', () => {
  assert.equal(view.openRunTarget(entry(), new Set(['run-1', 'run-2'])), 'run-1');
  assert.equal(view.openRunTarget(entry(), new Set(['run-2'])), null);
  assert.equal(view.openRunTarget(entry(), null), 'run-1', 'while the Building\'s runs are not loaded the entry\'s own run id is used');
  assert.equal(view.openRunTarget(entry({ runId: null }), new Set(['run-1'])), null);
  assert.equal(view.historyRow(entry(), NOW, 'UTC', new Set()).runId, null);
});

test('W18 the cron preview shows the server\'s next three times, says when an expression is not valid, and drops a reply for an earlier expression', () => {
  const runs = ['2026-10-12T03:30:00.000Z', '2026-10-19T03:30:00.000Z', '2026-10-26T03:30:00.000Z'];
  assert.equal(view.cronPreviewText({ status: 'ok', cron: '0 9 * * 1', runs }, 'Asia/Kolkata'), 'Next runs: Mon 12 Oct, 09:00; Mon 19 Oct, 09:00; Mon 26 Oct, 09:00');
  assert.equal(view.cronPreviewText({ status: 'invalid', cron: 'nope' }, 'UTC'), 'Not a valid schedule yet.');
  assert.equal(view.CRON_PREVIEW_INVALID, 'Not a valid schedule yet.');
  assert.equal(view.cronPreviewText({ status: 'ok', cron: '0 0 30 2 *', runs: [] }, 'UTC'), 'This schedule never runs.');
  assert.equal(view.cronPreviewText({ status: 'loading', cron: 'x' }, 'UTC'), 'Checking the schedule...');
  assert.equal(view.cronPreviewText({ status: 'idle' }, 'UTC'), '');
  const reply = { status: 'ok', cron: '0 9 * * 1', runs };
  assert.equal(view.acceptCronPreview(' 0 9 * * 1 ', reply), reply);
  assert.equal(view.acceptCronPreview('0 10 * * 1', reply), null, 'the field moved on: the earlier reply is dropped');
  assert.equal(view.acceptCronPreview('nope', { status: 'invalid', cron: 'nop' }), null);
  assert.equal(view.acceptCronPreview('', { status: 'idle' }), null);
});

test('W19 after deleting the open job the view goes back to the list', () => {
  assert.equal(view.openJobAfterDelete('j1', 'j1'), null);
  assert.equal(view.openJobAfterDelete('j2', 'j1'), 'j2');
  assert.equal(view.openJobAfterDelete(null, 'j1'), null);
});

test('W20 the job list is ordered by creation time then id, and a status change does not move a row', () => {
  const jobs = [job({ id: 'b', createdAt: '2026-10-02T00:00:00.000Z' }), job({ id: 'c', createdAt: '2026-10-01T00:00:00.000Z' }), job({ id: 'a', createdAt: '2026-10-02T00:00:00.000Z' })];
  assert.deepEqual(view.sortJobs(jobs).map((j) => j.id), ['c', 'a', 'b']);
  const changed = jobs.map((j) => (j.id === 'b' ? { ...j, enabled: false, autoDisabled: true, lastEntry: entry({ outcome: 'failed' }), updatedAt: '2026-12-01T00:00:00.000Z' } : j));
  assert.deepEqual(view.sortJobs(changed).map((j) => j.id), ['c', 'a', 'b']);
  assert.deepEqual(jobs.map((j) => j.id), ['b', 'c', 'a'], 'the list handed in is not reordered');
});

test('the editor shows the missed-run rule for a schedule only and the interval for a watch job only', () => {
  assert.deepEqual(view.editorGroups({ triggerKind: 'cron', targetKind: 'slot' }), { cron: true, folder: false, api: false, interval: false, missed: true, slot: true, prompt: false, command: false });
  assert.deepEqual(view.editorGroups({ triggerKind: 'file', targetKind: 'prompt' }), { cron: false, folder: true, api: false, interval: true, missed: false, slot: false, prompt: true, command: false });
  assert.deepEqual(view.editorGroups({ triggerKind: 'api', targetKind: 'slot' }), { cron: false, folder: false, api: true, interval: true, missed: false, slot: true, prompt: false, command: false });
});

const COMMANDS = [{ id: 'c1', name: 'Build' }, { id: 'c2', name: 'Say "hi" <b>' }];

test('W30 a command target reads as Runs command "<name>", unloaded commands read generally, a deleted one says it no longer exists', () => {
  const target = (commandId) => ({ kind: 'command', commandId });
  assert.equal(view.targetLabel(target('c1'), SLOTS, AGENTS, [], COMMANDS), 'Runs command "Build"');
  assert.equal(view.targetLabel(target('c2'), SLOTS, AGENTS, [], COMMANDS), 'Runs command "Say "hi" <b>"');
  assert.equal(view.targetLabel(target('c1'), SLOTS, AGENTS), 'Runs a saved command');
  assert.match(view.targetLabel(target('gone'), SLOTS, AGENTS, [], COMMANDS), /command no longer exists/);
});

test('W31 a command job maps to the form and back; approval, usage limits and overlap are not sent for it', () => {
  const stored = job({ target: { kind: 'command', commandId: 'c1' }, overlap: 'queue', needsApproval: true, maxFiveHourPercent: 50, maxWeeklyPercent: 60 });
  const asForm = view.jobToForm(stored);
  assert.deepEqual([asForm.targetKind, asForm.commandId], ['command', 'c1']);
  const request = view.formToRequest(asForm);
  assert.deepEqual(request.target, { kind: 'command', commandId: 'c1' });
  assert.deepEqual([request.needsApproval, request.overlap, request.maxFiveHourPercent, request.maxWeeklyPercent], [false, 'skip', null, null]);
  assert.equal(view.formToRequest(form({ targetKind: 'slot', commandId: 'left over', needsApproval: true })).needsApproval, true);
  assert.equal(view.formToRequest(form({ targetKind: 'slot', commandId: 'left over' })).target.kind, 'slot');
  assert.equal(view.emptyJobForm(SLOTS).commandId, '');
});

test('W32 a command job needs one of the Building\'s saved commands; the server\'s target.commandId error lands on that field', () => {
  const commandForm = (commandId) => form({ targetKind: 'command', commandId, slot: '', task: '' });
  assert.deepEqual(view.validateJobForm(commandForm('c1'), SLOT_IDS, ['c1']), {});
  assert.equal(view.validateJobForm(commandForm(''), SLOT_IDS, ['c1']).command, 'Choose a saved command.');
  assert.equal(view.validateJobForm(commandForm('gone'), SLOT_IDS, ['c1']).command, 'Choose a saved command.');
  assert.equal(view.validateJobForm(commandForm('c1'), SLOT_IDS).command, 'Choose a saved command.');
  assert.deepEqual(Object.keys(view.serverErrorToForm({ message: 'm', field: 'target.commandId' }).errors), ['command']);
  const groups = view.editorGroups({ triggerKind: 'cron', targetKind: 'command' });
  assert.deepEqual([groups.command, groups.slot, groups.prompt], [true, false, false]);
});

test('W33 a command history entry offers no run link, and its note shows', () => {
  const row = view.historyRow(entry({ runId: 'command:abc', outcome: 'failed', note: 'Exited with code 2' }), NOW, 'UTC', null);
  assert.deepEqual([row.runId, row.details], [null, 'Exited with code 2']);
  assert.equal(view.historyRow(entry({ runId: 'command:abc' }), NOW, 'UTC', new Set(['command:abc'])).runId, null);
  assert.equal(view.historyRow(entry(), NOW, 'UTC', null).runId, 'run-1');
});
