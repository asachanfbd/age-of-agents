/**
 * The Schedules area's data shapes (mirroring server/src/scheduler) and its pure view-models: every label, badge and
 * form rule the Schedules panel and the Job editor show, kept out of the components so it can be tested without a DOM.
 */

export type OverlapRule = 'skip' | 'queue' | 'parallel';
export type MissedPolicy = 'skip' | 'once';
export type DetectMode = 'mtime' | 'hash';

export type JobTrigger =
  | { kind: 'cron'; cron: string }
  | { kind: 'file'; path: string; detect: DetectMode; intervalSeconds: number }
  | { kind: 'api'; url: string; jsonField: string | null; intervalSeconds: number };

export type JobTarget =
  | { kind: 'slot'; slotId: string; description: string }
  | { kind: 'prompt'; agentId: string | null; prompt: string }
  /** A call to a capability of a linked Building. The Job editor shows it but cannot create or change it. */
  | { kind: 'capability'; targetBuildingId: string; capabilityId: string; inputs: Record<string, unknown> }
  /** One of the Building's saved commands (Settings > Commands). It runs without an agent. */
  | { kind: 'command'; commandId: string };

export interface JobSettings {
  name: string;
  enabled: boolean;
  trigger: JobTrigger;
  target: JobTarget;
  overlap: OverlapRule;
  missedPolicy: MissedPolicy | null;
  maxRunsPerDay: number | null;
  maxFiveHourPercent: number | null;
  maxWeeklyPercent: number | null;
  needsApproval: boolean;
  failureThreshold: number;
}

export type StartedBy = 'schedule' | 'poll' | 'run-now' | 'catch-up' | 'event';
export type EntryOutcome = 'queued' | 'deferred' | 'running' | 'awaiting-approval' | 'succeeded' | 'failed' | 'stopped' | 'skipped' | 'check-failed';

export interface JobHistoryEntry {
  id: string;
  jobId: string;
  projectId: string;
  seq: number;
  startedBy: StartedBy;
  outcome: EntryOutcome;
  dueAt: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  note: string | null;
  change: string | null;
  runId: string | null;
  runStartedAt: string | null;
  deferredUntil: string | null;
}

export interface ScheduledJob extends JobSettings {
  id: string;
  projectId: string;
  declaredJobId: string | null;
  consecutiveFailures: number;
  autoDisabled: boolean;
  nextRunAt: string | null;
  pollError: string | null;
  createdAt: string;
  updatedAt: string;
  runsToday: number;
  activeRun: { entryId: string; runId: string | null; outcome: EntryOutcome } | null;
  queued: boolean;
  lastEntry: JobHistoryEntry | null;
}

export interface SchedulesView {
  projectId: string;
  timezone: string | null;
  hostTimezone: string;
  jobs: ScheduledJob[];
  missingDefaults: number;
}

export interface HistoryPage { entries: JobHistoryEntry[]; nextCursor: string | null }
export interface CronPreview { cron: string; timezone: string; runs: string[] }

/** A new or edited job as sent to the daemon; an edit may carry only the fields that changed. */
export type JobRequest = Partial<JobSettings>;

// ---- The job list ----

/** Jobs keep their creation order, so a row never moves when its status changes. */
export function sortJobs<T extends Pick<ScheduledJob, 'createdAt' | 'id'>>(jobs: readonly T[]): T[] {
  return [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export const CRON_PRESETS: { cron: string; chip: string; label: string }[] = [
  { cron: '0 * * * *', chip: 'Every hour', label: 'Every hour, on the hour' },
  { cron: '0 9 * * *', chip: 'Every day 09:00', label: 'Every day at 09:00' },
  { cron: '0 9 * * 1', chip: 'Every Monday 09:00', label: 'Every Monday at 09:00' },
  { cron: '0 10 */3 * *', chip: 'Every 3 days 10:00', label: 'Every 3 days at 10:00' },
];

/** Plain words for a preset schedule, the expression itself otherwise. */
export function cronLabel(cron: string): string {
  return CRON_PRESETS.find((preset) => preset.cron === cron.trim())?.label ?? cron;
}

const INTERVAL_UNITS: { seconds: number; one: string; many: string }[] = [
  { seconds: 86_400, one: 'day', many: 'days' },
  { seconds: 3_600, one: 'hour', many: 'hours' },
  { seconds: 60, one: 'min', many: 'min' },
];

/** `300` reads "5 min"; a value that is not a whole number of minutes stays in seconds. */
export function intervalLabel(seconds: number): string {
  const unit = INTERVAL_UNITS.find((u) => seconds >= u.seconds && seconds % u.seconds === 0);
  if (!unit) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  const count = seconds / unit.seconds;
  return `${count} ${count === 1 ? unit.one : unit.many}`;
}

export function triggerLabel(trigger: JobTrigger): string {
  if (trigger.kind === 'cron') return cronLabel(trigger.cron);
  return `${trigger.kind === 'file' ? 'Folder' : 'API'} changes, checked every ${intervalLabel(trigger.intervalSeconds)}`;
}

/** The exact thing a trigger watches, shown under its label in the job's details. */
export function triggerDetail(trigger: JobTrigger): string {
  if (trigger.kind === 'cron') return trigger.cron;
  if (trigger.kind === 'file') return `${trigger.path} (${trigger.detect === 'hash' ? 'by content hash' : 'by modified time'})`;
  return `GET ${trigger.url}${trigger.jsonField ? ` field: ${trigger.jsonField}` : ''}`;
}

export function targetLabel(target: JobTarget, slots: readonly { id: string; label: string }[], agents: readonly { id: string; name: string }[], buildings: readonly { id: string; name: string }[] = [], commands: readonly { id: string; name: string }[] | null = null): string {
  if (target.kind === 'command') {
    if (commands === null) return 'Runs a saved command';
    const command = commands.find((c) => c.id === target.commandId);
    return command ? `Runs command "${command.name}"` : 'Runs a saved command: command no longer exists';
  }
  if (target.kind === 'slot') {
    const slot = slots.find((s) => s.id === target.slotId);
    return slot ? `Workflow slot: ${slot.label}` : `Workflow slot: unknown (${target.slotId})`;
  }
  if (target.kind === 'capability') return `Calls "${target.capabilityId}" on ${buildings.find((b) => b.id === target.targetBuildingId)?.name ?? 'a Building that is no longer there'}`;
  const agent = target.agentId === null ? 'default agent' : agents.find((a) => a.id === target.agentId)?.name ?? `unknown agent ${target.agentId}`;
  return `Single agent prompt (${agent})`;
}

export function nextLabel(trigger: JobTrigger): 'Next run' | 'Next check' {
  return trigger.kind === 'cron' ? 'Next run' : 'Next check';
}

const MINUTE = 60_000;

/** "in 22 h", "in 10 min", "in 2 days"; a time that has passed reads "due now". */
export function relativeTime(target: number, now: number): string {
  const minutes = Math.round((target - now) / MINUTE);
  if (minutes <= 0) return 'due now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

/** A date in the Building's timezone, never the browser's: "Mon 12 Oct, 09:00". */
export function formatInZone(iso: string, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

export function effectiveTimezone(view: Pick<SchedulesView, 'timezone' | 'hostTimezone'>): string {
  return view.timezone ?? view.hostTimezone;
}

export function nextText(job: Pick<ScheduledJob, 'enabled' | 'nextRunAt'>, now: number, timezone: string): string {
  if (!job.enabled) return 'Off';
  if (job.nextRunAt === null) return 'No upcoming run';
  return `${formatInZone(job.nextRunAt, timezone)} (${relativeTime(Date.parse(job.nextRunAt), now)})`;
}

export type BadgeTone = 'ok' | 'bad' | 'info' | 'warn' | 'neutral';

const OUTCOME_BADGES: Record<EntryOutcome, { label: string; tone: BadgeTone }> = {
  succeeded: { label: 'Succeeded', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  running: { label: 'Running', tone: 'info' },
  queued: { label: 'Queued', tone: 'neutral' },
  'awaiting-approval': { label: 'Waiting for approval', tone: 'warn' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  deferred: { label: 'Deferred', tone: 'warn' },
  'check-failed': { label: 'Check failed', tone: 'bad' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};

export function outcomeBadge(outcome: EntryOutcome | null | undefined): { label: string; tone: BadgeTone } {
  return outcome ? OUTCOME_BADGES[outcome] : { label: 'Never ran', tone: 'neutral' };
}

/** The strips under a job: why it turned itself off, its latest failed check, and a refused Run now. */
export interface JobNote { kind: 'auto-disabled' | 'poll-error' | 'run-error'; text: string; role: 'status' | 'alert' }

export function jobNotes(job: Pick<ScheduledJob, 'autoDisabled' | 'consecutiveFailures' | 'pollError'>, runError: string | null | undefined): JobNote[] {
  const notes: JobNote[] = [];
  if (job.autoDisabled) {
    const count = job.consecutiveFailures;
    notes.push({ kind: 'auto-disabled', role: 'status', text: `Turned off after ${count} failed run${count === 1 ? '' : 's'} in a row. Switch it back on to try again; the count starts from zero.` });
  }
  if (job.pollError) notes.push({ kind: 'poll-error', role: 'status', text: `Last check failed: ${job.pollError}. No run was started. It is checked again at the next interval.` });
  if (runError) notes.push({ kind: 'run-error', role: 'alert', text: `Cannot start now: ${runError}` });
  return notes;
}

// ---- A job's details ----

const OVERLAP_TEXT: Record<OverlapRule, string> = { skip: 'Skip the new run', queue: 'Queue one run', parallel: 'Allow runs side by side' };

function budgetText(job: Pick<ScheduledJob, 'maxRunsPerDay' | 'runsToday' | 'maxFiveHourPercent' | 'maxWeeklyPercent'>): string {
  const parts: string[] = [];
  if (job.maxRunsPerDay !== null) {
    const limit = job.maxRunsPerDay === 1 ? '1 run a day' : `Up to ${job.maxRunsPerDay} runs a day`;
    parts.push(`${limit} (${job.runsToday} used today)`);
  }
  if (job.maxFiveHourPercent !== null) parts.push(`not above ${job.maxFiveHourPercent}% of 5-hour usage`);
  if (job.maxWeeklyPercent !== null) parts.push(`not above ${job.maxWeeklyPercent}% of weekly usage`);
  return parts.length ? parts.join('; ') : 'No limit';
}

export function guardrailCards(job: ScheduledJob): { label: string; value: string }[] {
  return [
    { label: 'If the last run is still going', value: OVERLAP_TEXT[job.overlap] },
    { label: 'After the app was off', value: job.missedPolicy === null ? 'Does not apply to a watch job' : job.missedPolicy === 'once' ? 'Run once to catch up' : 'Skip missed runs' },
    { label: 'Budget', value: budgetText(job) },
    { label: 'Approval', value: job.needsApproval ? 'Pauses for approval before publishing or sending' : 'Not needed' },
    { label: 'Failed runs in a row', value: `${job.consecutiveFailures} of ${job.failureThreshold} before the job turns itself off` },
  ];
}

export type HistoryFilter = 'all' | 'runs' | 'other';

export const HISTORY_FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'runs', label: 'Runs' },
  { key: 'other', label: 'Skipped and errors' },
];

export const HISTORY_EMPTY_TEXT = 'Nothing here yet.';

const startedRun = (entry: Pick<JobHistoryEntry, 'runStartedAt'>): boolean => entry.runStartedAt !== null;

/** "Runs" are the entries that started a run; everything else (skipped, deferred, queued, failed checks) is "Skipped and errors". */
export function filterHistory<T extends Pick<JobHistoryEntry, 'runStartedAt'>>(entries: readonly T[], filter: HistoryFilter): T[] {
  if (filter === 'all') return [...entries];
  return entries.filter((entry) => startedRun(entry) === (filter === 'runs'));
}

const STARTED_BY: Record<StartedBy, string> = { schedule: 'Schedule', poll: 'Poll', 'run-now': 'Run now', 'catch-up': 'Catch-up', event: 'Event' };

export function startedByLabel(startedBy: StartedBy): string {
  return STARTED_BY[startedBy];
}

function spanText(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 1) return 'under 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** "14 min" for a finished run, "5 min so far" while it is going, "-" for an entry with no run. */
export function durationText(entry: Pick<JobHistoryEntry, 'durationMs' | 'runStartedAt' | 'finishedAt'>, now: number): string {
  if (entry.durationMs !== null) return spanText(entry.durationMs);
  if (entry.runStartedAt !== null && entry.finishedAt === null) return `${spanText(Math.max(0, now - Date.parse(entry.runStartedAt)))} so far`;
  return '-';
}

/** The run an entry links to: only a run that exists. `knownRunIds` is null while the Building's runs are not loaded. */
export function openRunTarget(entry: Pick<JobHistoryEntry, 'runId'>, knownRunIds: ReadonlySet<string> | null): string | null {
  // A command run has its own log, which this area does not open.
  if (entry.runId === null || entry.runId.startsWith('command:')) return null;
  return knownRunIds === null || knownRunIds.has(entry.runId) ? entry.runId : null;
}

export interface HistoryRow {
  id: string;
  when: string;
  startedBy: string;
  badge: { label: string; tone: BadgeTone };
  duration: string;
  details: string;
  runId: string | null;
}

/** What started or changed a run, in words: a poll names what changed; an event entry keeps only the event's name, not the delivery id the daemon stores with it. */
export function changeText(change: string | null): string | null {
  if (!change) return null;
  const event = /^event:\S+ (.*)$/.exec(change);
  return event ? `Event: ${event[1]}.` : `Change: ${change}.`;
}

export function historyRow(entry: JobHistoryEntry, now: number, timezone: string, knownRunIds: ReadonlySet<string> | null): HistoryRow {
  const details = [changeText(entry.change), entry.note].filter((part): part is string => Boolean(part)).join(' ');
  return {
    id: entry.id,
    when: formatInZone(entry.startedAt, timezone),
    startedBy: startedByLabel(entry.startedBy),
    badge: outcomeBadge(entry.outcome),
    duration: durationText(entry, now),
    details,
    runId: openRunTarget(entry, knownRunIds),
  };
}

export function deleteConfirmation(job: Pick<ScheduledJob, 'name' | 'declaredJobId' | 'activeRun'>): { title: string; body: string } {
  const parts = [`"${job.name}" and its run history are removed.`];
  if (job.activeRun) parts.push('A run of this job is going. It carries on, but is no longer listed here.');
  if (job.declaredJobId !== null) parts.push('This job comes with the Building\'s type. You can add it back with "Restore default jobs".');
  return { title: 'Delete this job?', body: parts.join(' ') };
}

/**
 * What the panel's own error line shows after Run now: nothing when it worked or when the daemon refused it with a 409
 * (that reason is shown on the job itself), the message for any other failure (the job was deleted elsewhere, the
 * daemon failed or cannot be reached).
 */
export function runNowPanelError(result: { ok: true } | { ok: false; status: number; error: string }): string | null {
  return result.ok || result.status === 409 ? null : result.error;
}

/** After a delete, the detail view of the deleted job falls back to the list. */
export function openJobAfterDelete(openJobId: string | null, deletedJobId: string): string | null {
  return openJobId === deletedJobId ? null : openJobId;
}

/** A read-only Building: everything that changes something is disabled; looking around is not. */
export function scheduleControls(readOnly: boolean): Record<'newJob' | 'toggle' | 'runNow' | 'edit' | 'delete' | 'timezone' | 'restoreDefaults' | 'openJob' | 'back' | 'historyFilter' | 'openRun' | 'loadMore', { disabled: boolean }> {
  const change = { disabled: readOnly };
  const look = { disabled: false };
  return {
    newJob: change, toggle: change, runNow: change, edit: change, delete: change, timezone: change, restoreDefaults: change,
    openJob: look, back: look, historyFilter: look, openRun: look, loadMore: look,
  };
}

/** The timezone selector's options: this computer's first (stored as "no timezone of its own"), and the current value kept even when the list lacks it. */
export function timezoneOptions(hostTimezone: string, current: string | null, known: readonly string[]): { value: string; label: string }[] {
  const others = [...new Set([...(current !== null ? [current] : []), ...known])].filter((zone) => zone !== hostTimezone).sort();
  return [{ value: '', label: `${hostTimezone} (this computer's)` }, ...others.map((zone) => ({ value: zone, label: zone }))];
}

// ---- The cron preview ----

export type CronPreviewState =
  | { status: 'idle' }
  | { status: 'loading'; cron: string }
  | { status: 'ok'; cron: string; runs: string[] }
  | { status: 'invalid'; cron: string };

export const CRON_PREVIEW_INVALID = 'Not a valid schedule yet.';

export function cronPreviewText(state: CronPreviewState, timezone: string): string {
  if (state.status === 'invalid') return CRON_PREVIEW_INVALID;
  if (state.status === 'ok') return state.runs.length ? `Next runs: ${state.runs.map((run) => formatInZone(run, timezone)).join('; ')}` : 'This schedule never runs.';
  return state.status === 'loading' ? 'Checking the schedule...' : '';
}

/** A preview reply counts only for the expression still in the field; a reply for an earlier one is dropped. */
export function acceptCronPreview(current: string, reply: CronPreviewState): CronPreviewState | null {
  return reply.status !== 'idle' && reply.cron === current.trim() ? reply : null;
}

// ---- The Job editor ----

export type TriggerKind = JobTrigger['kind'];
export type IntervalUnit = 'seconds' | 'minutes' | 'hours';
const UNIT_SECONDS: Record<IntervalUnit, number> = { seconds: 1, minutes: 60, hours: 3600 };

/** The editor's fields, all text as typed. Every trigger's and target's fields are kept so switching back and forth loses nothing. */
export interface JobForm {
  name: string;
  triggerKind: TriggerKind;
  cron: string;
  path: string;
  detect: DetectMode;
  url: string;
  jsonField: string;
  every: string;
  unit: IntervalUnit;
  targetKind: JobTarget['kind'];
  slot: string;
  task: string;
  agent: string;
  prompt: string;
  commandId: string;
  overlap: OverlapRule;
  missedPolicy: MissedPolicy;
  perDay: string;
  failures: string;
  fiveHour: string;
  weekly: string;
  needsApproval: boolean;
}

export type JobFormField = 'name' | 'cron' | 'path' | 'url' | 'jsonField' | 'every' | 'slot' | 'task' | 'agent' | 'prompt' | 'command' | 'perDay' | 'failures' | 'fiveHour' | 'weekly';
export type JobFormErrors = Partial<Record<JobFormField, string>>;

/** `300` shows as 5 minutes and `90` as 90 seconds: the largest unit that divides the interval evenly. */
export function splitInterval(seconds: number): { every: string; unit: IntervalUnit } {
  const unit = (['hours', 'minutes'] as const).find((u) => seconds % UNIT_SECONDS[u] === 0) ?? 'seconds';
  return { every: String(seconds / UNIT_SECONDS[unit]), unit };
}

export function emptyJobForm(slots: readonly { id: string }[]): JobForm {
  return {
    name: '', triggerKind: 'cron', cron: '0 9 * * 1', path: '', detect: 'mtime', url: '', jsonField: '', every: '15', unit: 'minutes',
    targetKind: 'slot', slot: slots.length === 1 ? slots[0]!.id : '', task: '', agent: '', prompt: '', commandId: '',
    overlap: 'skip', missedPolicy: 'skip', perDay: '', failures: '3', fiveHour: '', weekly: '', needsApproval: false,
  };
}

const optionalText = (value: number | null): string => (value === null ? '' : String(value));

export function jobToForm(job: JobSettings): JobForm {
  const form = emptyJobForm([]);
  const { trigger, target } = job;
  Object.assign(form, {
    name: job.name, triggerKind: trigger.kind, targetKind: target.kind, overlap: job.overlap, missedPolicy: job.missedPolicy ?? 'skip',
    perDay: optionalText(job.maxRunsPerDay), failures: String(job.failureThreshold), fiveHour: optionalText(job.maxFiveHourPercent),
    weekly: optionalText(job.maxWeeklyPercent), needsApproval: job.needsApproval,
  });
  if (trigger.kind === 'cron') form.cron = trigger.cron;
  else Object.assign(form, splitInterval(trigger.intervalSeconds), trigger.kind === 'file' ? { path: trigger.path, detect: trigger.detect } : { url: trigger.url, jsonField: trigger.jsonField ?? '' });
  if (target.kind === 'slot') Object.assign(form, { slot: target.slotId, task: target.description });
  else if (target.kind === 'prompt') Object.assign(form, { agent: target.agentId ?? '', prompt: target.prompt });
  else if (target.kind === 'command') form.commandId = target.commandId;
  return form;
}

export function intervalSeconds(form: Pick<JobForm, 'every' | 'unit'>): number {
  return Number(form.every.trim()) * UNIT_SECONDS[form.unit];
}

const optionalNumber = (text: string): number | null => (text.trim() === '' ? null : Number(text.trim()));

/** The request for the form as it stands. Fields of a trigger or target that is not selected are not sent, and a watch job carries no missed-run policy. */
export function formToRequest(form: JobForm): JobRequest & { enabled?: boolean } {
  const trigger: JobTrigger = form.triggerKind === 'cron' ? { kind: 'cron', cron: form.cron.trim() }
    : form.triggerKind === 'file' ? { kind: 'file', path: form.path.trim(), detect: form.detect, intervalSeconds: intervalSeconds(form) }
      : { kind: 'api', url: form.url.trim(), jsonField: form.jsonField.trim() || null, intervalSeconds: intervalSeconds(form) };
  const target: JobTarget = form.targetKind === 'slot'
    ? { kind: 'slot', slotId: form.slot, description: form.task.trim() }
    : form.targetKind === 'command' ? { kind: 'command', commandId: form.commandId }
      : { kind: 'prompt', agentId: form.agent || null, prompt: form.prompt.trim() };
  // A job that calls a capability is not edited here, so its target is left out and the daemon keeps the one it has.
  // A command job uses no agent: it never waits for approval or usage, and a new run is skipped while one is going.
  const command = form.targetKind === 'command';
  const request = {
    name: form.name.trim(), trigger, ...(form.targetKind === 'capability' ? {} : { target }), overlap: command ? 'skip' as const : form.overlap,
    maxRunsPerDay: optionalNumber(form.perDay), maxFiveHourPercent: command ? null : optionalNumber(form.fiveHour), maxWeeklyPercent: command ? null : optionalNumber(form.weekly),
    needsApproval: command ? false : form.needsApproval, failureThreshold: Number(form.failures.trim()),
  };
  return form.triggerKind === 'cron' ? { ...request, missedPolicy: form.missedPolicy } : request;
}

const LIMITS = { name: 120, text: 10_000, path: 1_024, url: 2_048, jsonField: 256, minInterval: 60, maxInterval: 30 * 24 * 3600 };
const isWhole = (text: string, min: number, max: number): boolean => /^\d+$/.test(text.trim()) && Number(text.trim()) >= min && Number(text.trim()) <= max;

function optionalWhole(text: string, max: number, message: string): string | undefined {
  return text.trim() === '' || isWhole(text, 1, max) ? undefined : message;
}

function requiredText(text: string, max: number, missing: string, label: string): string | undefined {
  if (!text.trim()) return missing;
  return text.trim().length > max ? `${label} must be at most ${max.toLocaleString('en-US')} characters.` : undefined;
}

/** The same rules the daemon applies, checked before a save so most mistakes never leave the form. The cron expression itself is checked by the daemon. */
export function validateJobForm(form: JobForm, slotIds: readonly string[], commandIds: readonly string[] = []): JobFormErrors {
  const errors: JobFormErrors = {};
  const set = (field: JobFormField, message: string | undefined) => { if (message) errors[field] = message; };
  set('name', requiredText(form.name, LIMITS.name, 'Give the job a name.', 'The name'));
  if (form.triggerKind === 'cron') {
    const fields = form.cron.trim().split(/\s+/).filter(Boolean);
    if (!form.cron.trim()) set('cron', 'Enter a cron expression.');
    else if (!form.cron.trim().startsWith('@') && fields.length !== 5) set('cron', `Invalid cron expression: it needs 5 fields (minute hour day month weekday) and has ${fields.length}.`);
  } else {
    const seconds = intervalSeconds(form);
    if (!/^\d+$/.test(form.every.trim())) set('every', `Enter a whole number of ${form.unit}.`);
    else if (seconds < LIMITS.minInterval) set('every', 'The check interval must be at least 1 minute.');
    else if (seconds > LIMITS.maxInterval) set('every', 'The check interval must be at most 30 days.');
    if (form.triggerKind === 'file') set('path', requiredText(form.path, LIMITS.path, 'Enter the folder or file to watch.', 'The path'));
    else {
      if (!/^https?:\/\/\S+$/i.test(form.url.trim())) set('url', 'Enter a full address starting with http:// or https://.');
      else if (form.url.trim().length > LIMITS.url) set('url', `The address must be at most ${LIMITS.url.toLocaleString('en-US')} characters.`);
      if (form.jsonField.trim().length > LIMITS.jsonField) set('jsonField', `The JSON field must be at most ${LIMITS.jsonField} characters.`);
    }
  }
  if (form.targetKind === 'capability') {
    // Not editable here; nothing to check.
  } else if (form.targetKind === 'command') {
    if (!commandIds.includes(form.commandId)) set('command', 'Choose a saved command.');
  } else if (form.targetKind === 'slot') {
    if (!slotIds.includes(form.slot)) set('slot', 'Choose a workflow slot.');
    set('task', requiredText(form.task, LIMITS.text, 'Describe what each run should do.', 'The task description'));
  } else {
    set('prompt', requiredText(form.prompt, LIMITS.text, 'Write the prompt for the agent.', 'The prompt'));
  }
  set('perDay', optionalWhole(form.perDay, 1000, 'Enter a whole number from 1 to 1,000, or leave empty for no limit.'));
  set('failures', isWhole(form.failures, 1, 100) ? undefined : 'Enter a whole number from 1 to 100.');
  set('fiveHour', optionalWhole(form.fiveHour, 100, 'Enter a whole percentage from 1 to 100, or leave empty.'));
  set('weekly', optionalWhole(form.weekly, 100, 'Enter a whole percentage from 1 to 100, or leave empty.'));
  return errors;
}

export function errorSummary(errors: JobFormErrors): string | null {
  const count = Object.keys(errors).length;
  return count ? `Fix ${count} problem${count === 1 ? '' : 's'} to save.` : null;
}

const SERVER_FIELDS: Record<string, JobFormField> = {
  name: 'name', 'trigger.cron': 'cron', 'trigger.path': 'path', 'trigger.url': 'url', 'trigger.jsonField': 'jsonField', 'trigger.intervalSeconds': 'every',
  'target.slotId': 'slot', 'target.description': 'task', 'target.agentId': 'agent', 'target.prompt': 'prompt', 'target.commandId': 'command',
  maxRunsPerDay: 'perDay', failureThreshold: 'failures', maxFiveHourPercent: 'fiveHour', maxWeeklyPercent: 'weekly',
};

/** Where a refused save shows: on the field the daemon named, plus the summary; a field the form does not have shows in the summary alone. */
export function serverErrorToForm(error: { message: string; field: string | null }): { errors: JobFormErrors; summary: string } {
  const field = error.field !== null && Object.hasOwn(SERVER_FIELDS, error.field) ? SERVER_FIELDS[error.field] : undefined;
  return field ? { errors: { [field]: error.message }, summary: 'Fix 1 problem to save.' } : { errors: {}, summary: error.message };
}

/** Which groups of the editor show: the interval for a watch job only, the missed-run rule for a schedule only. */
export function editorGroups(form: Pick<JobForm, 'triggerKind' | 'targetKind'>): Record<'cron' | 'folder' | 'api' | 'interval' | 'missed' | 'slot' | 'prompt' | 'command', boolean> {
  return {
    cron: form.triggerKind === 'cron', folder: form.triggerKind === 'file', api: form.triggerKind === 'api',
    interval: form.triggerKind !== 'cron', missed: form.triggerKind === 'cron',
    slot: form.targetKind === 'slot', prompt: form.targetKind === 'prompt', command: form.targetKind === 'command',
  };
}

export const RUN_GOING_NOTE = 'A run of this job is going. Your changes apply from the next run; the current run is not touched.';
