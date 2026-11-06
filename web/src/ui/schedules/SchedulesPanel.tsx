import { useEffect, useState } from 'react';
import { ArrowLeft, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { isBuildingReadOnly } from '../../lib/buildingTypes';
import {
  HISTORY_EMPTY_TEXT, HISTORY_FILTERS, deleteConfirmation, effectiveTimezone, filterHistory, guardrailCards, historyRow, jobNotes, nextLabel, nextText,
  openJobAfterDelete, outcomeBadge, runNowPanelError, scheduleControls, sortJobs, targetLabel, timezoneOptions, triggerDetail, triggerLabel,
} from '../../lib/schedules';
import type { BadgeTone, HistoryFilter, ScheduledJob, SchedulesView } from '../../lib/schedules';
import { useNow } from '../../lib/useNow';
import { useWorldStore } from '../../store/worldStore';
import type { ProjectData } from '../../types';
import { JobEditorDialog } from './JobEditorDialog';

const TONE_VARIANT: Record<BadgeTone, 'success' | 'destructive' | 'warning' | 'default' | 'secondary'> = {
  ok: 'success', bad: 'destructive', warn: 'warning', info: 'default', neutral: 'secondary',
};

const KNOWN_TIMEZONES: readonly string[] = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

type Controls = ReturnType<typeof scheduleControls>;
type Editing = { mode: 'new' } | { mode: 'edit'; job: ScheduledJob } | null;

/**
 * The generic Schedules area every Building gets: its jobs, each job's guardrails and run history, and the Job editor.
 * It takes the Building and a way to open a run, and nothing from the workspace shell, so a Building Type can embed it
 * in its own popup or put its own screen in its place.
 *
 * On a read-only Building the controls that change something are disabled one by one; opening a job, Back, the history
 * filter and "Open run" keep working, which is why this is never wrapped in the shell's disabling fieldset.
 */
export function SchedulesPanel({ project, onOpenRun }: { project: ProjectData; onOpenRun: (runId: string) => void }) {
  const view = useWorldStore((s) => s.schedulesByProject[project.id]);
  const loadError = useWorldStore((s) => s.scheduleLoadErrorByProject[project.id]);
  const loadSchedules = useWorldStore((s) => s.loadSchedules);
  const setScheduleTimezone = useWorldStore((s) => s.setScheduleTimezone);
  const restoreScheduleDefaults = useWorldStore((s) => s.restoreScheduleDefaults);
  const deleteScheduleJob = useWorldStore((s) => s.deleteScheduleJob);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<ScheduledJob | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => { void loadSchedules(project.id); }, [project.id, loadSchedules]);

  const controls = scheduleControls(isBuildingReadOnly(project));
  const report = (result: { ok: boolean; error?: string }) => setActionError(result.ok ? null : result.error ?? 'The change failed');

  if (!view) {
    return <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" aria-label="Schedules">{loadError ? <p className="text-sm text-destructive" role="alert">{loadError}</p> : <p className="text-sm text-muted-foreground">Loading schedules...</p>}</div>;
  }

  const jobs = sortJobs(view.jobs);
  const openJob = jobs.find((job) => job.id === openJobId) ?? null;
  const timezone = effectiveTimezone(view);

  async function confirmDelete(job: ScheduledJob) {
    const result = await deleteScheduleJob(project.id, job.id);
    report(result);
    setDeleting(null);
    if (result.ok) setOpenJobId((current) => openJobAfterDelete(current, job.id));
  }

  const rowProps = { project, view, now, controls, onEdit: (job: ScheduledJob) => setEditing({ mode: 'edit', job }), onDelete: setDeleting, onError: setActionError };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" aria-label="Schedules">
      {(actionError || loadError) && <p className="mb-3 text-sm text-destructive" role="alert">{actionError ?? loadError}</p>}
      {openJob ? (
        <JobDetail {...rowProps} job={openJob} onBack={() => setOpenJobId(null)} onOpenRun={onOpenRun} />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold tracking-tight">Schedules</h3>
              <p className="mt-0.5 text-sm text-muted-foreground">Jobs that start runs on their own: on a schedule, or when a watched folder or API changes.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                Times in
                <select
                  aria-label="Timezone for this Building's schedules"
                  className="h-8 rounded-md border border-border bg-card px-2 text-sm text-foreground"
                  value={view.timezone ?? ''}
                  disabled={controls.timezone.disabled}
                  onChange={(event) => void setScheduleTimezone(project.id, event.target.value || null).then(report)}
                >
                  {timezoneOptions(view.hostTimezone, view.timezone, KNOWN_TIMEZONES).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <Button type="button" size="sm" disabled={controls.newJob.disabled} onClick={() => setEditing({ mode: 'new' })}><Plus aria-hidden="true" />New job</Button>
            </div>
          </div>

          {jobs.length === 0 ? (
            <div className="mt-6 rounded-xl border border-dashed p-8 text-center">
              <h4 className="text-sm font-semibold">No jobs yet</h4>
              <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">Create a job to run a workflow every week, or whenever a file or an API response changes.</p>
              <Button type="button" size="sm" className="mt-4" disabled={controls.newJob.disabled} onClick={() => setEditing({ mode: 'new' })}><Plus aria-hidden="true" />New job</Button>
            </div>
          ) : (
            <ul className="mt-4 flex flex-col gap-3" aria-label="Jobs">
              {jobs.map((job) => <JobRow key={job.id} {...rowProps} job={job} onOpen={() => setOpenJobId(job.id)} />)}
            </ul>
          )}

          {view.missingDefaults > 0 && (
            <p className="mt-4 text-sm text-muted-foreground">
              <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={controls.restoreDefaults.disabled} onClick={() => void restoreScheduleDefaults(project.id).then(report)}>Restore default jobs</Button>
              {' '}that this Building's type comes with.
            </p>
          )}
        </>
      )}

      {editing && <JobEditorDialog project={project} timezone={timezone} job={editing.mode === 'edit' ? editing.job : null} onClose={() => setEditing(null)} />}

      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        {deleting && (
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{deleteConfirmation(deleting).title}</DialogTitle>
              <DialogDescription>{deleteConfirmation(deleting).body}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
              <Button type="button" variant="destructive" onClick={() => void confirmDelete(deleting)}>Delete job</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

interface JobProps {
  project: ProjectData;
  view: SchedulesView;
  job: ScheduledJob;
  now: number;
  controls: Controls;
  onEdit: (job: ScheduledJob) => void;
  onDelete: (job: ScheduledJob) => void;
  onError: (message: string | null) => void;
}

function OutcomeBadge({ job }: { job: ScheduledJob }) {
  const badge = outcomeBadge(job.lastEntry?.outcome);
  return <Badge variant={TONE_VARIANT[badge.tone]}>{badge.label}</Badge>;
}

function JobTags({ job }: { job: ScheduledJob }) {
  return (
    <>
      {job.declaredJobId !== null && <Badge variant="outline">From type</Badge>}
      {job.needsApproval && <Badge variant="outline">Needs approval</Badge>}
      {job.queued && <Badge variant="secondary">Queued</Badge>}
    </>
  );
}

/** The job's on/off switch. Switching a job off never stops a run that is going. */
function JobSwitch({ project, job, controls, onError }: Pick<JobProps, 'project' | 'job' | 'controls' | 'onError'>) {
  const updateScheduleJob = useWorldStore((s) => s.updateScheduleJob);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={job.enabled}
      aria-label={`${job.name}: ${job.enabled ? 'on' : 'off'}`}
      disabled={controls.toggle.disabled}
      onClick={() => void updateScheduleJob(project.id, job.id, { enabled: !job.enabled }).then((result) => onError(result.ok ? null : result.error))}
      className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent px-0.5 transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${job.enabled ? 'justify-end bg-primary' : 'justify-start bg-input'}`}
    >
      <span className="size-4 rounded-full bg-background" aria-hidden="true" />
    </button>
  );
}

function JobActions({ project, job, controls, onEdit, onDelete, onError }: Pick<JobProps, 'project' | 'job' | 'controls' | 'onEdit' | 'onDelete' | 'onError'>) {
  const runScheduleJobNow = useWorldStore((s) => s.runScheduleJobNow);
  // A 409 is shown on the job itself (the store keeps it); any other failure has nowhere else to show.
  const runNow = () => void runScheduleJobNow(project.id, job.id).then((result) => onError(runNowPanelError(result)));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={controls.runNow.disabled} onClick={runNow}><Play aria-hidden="true" />Run now</Button>
      <Button type="button" variant="outline" size="sm" disabled={controls.edit.disabled} onClick={() => onEdit(job)}><Pencil aria-hidden="true" />Edit</Button>
      <Button type="button" variant="outline" size="sm" disabled={controls.delete.disabled} onClick={() => onDelete(job)} aria-label={`Delete ${job.name}`}><Trash2 aria-hidden="true" />Delete</Button>
    </div>
  );
}

function JobNotes({ job }: { job: ScheduledJob }) {
  const runError = useWorldStore((s) => s.scheduleRunErrorByJob[job.id]);
  return (
    <>
      {jobNotes(job, runError).map((note) => (
        <Alert key={note.kind} role={note.role} variant={note.kind === 'auto-disabled' ? 'default' : 'destructive'} className="mt-3">
          <AlertDescription>{note.text}</AlertDescription>
        </Alert>
      ))}
    </>
  );
}

function useTargetLabel(project: ProjectData, job: ScheduledJob): string {
  const slots = useWorldStore((s) => s.buildingTypes.find((type) => type.id === project.typeId)?.slots);
  const agents = useWorldStore((s) => s.catalogAgents);
  const buildings = useWorldStore((s) => s.projects);
  const commands = useWorldStore((s) => s.commandsByProject[project.id]);
  const loadCommands = useWorldStore((s) => s.loadCommands);
  const usesCommand = job.target.kind === 'command';
  useEffect(() => { if (usesCommand && !commands) void loadCommands(project.id); }, [usesCommand, commands, project.id, loadCommands]);
  return targetLabel(job.target, slots ?? [], agents, buildings, commands ?? null);
}

function JobRow({ onOpen, ...props }: JobProps & { onOpen: () => void }) {
  const { project, view, job, now } = props;
  const runs = useTargetLabel(project, job);
  return (
    <li className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <JobSwitch {...props} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="truncate text-left text-sm font-semibold hover:underline" onClick={onOpen}>{job.name}</button>
              <JobTags job={job} />
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{triggerLabel(job.trigger)} · {runs}</p>
          </div>
        </div>
        <JobActions {...props} />
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-1 text-sm">
        <div className="flex gap-2"><dt className="text-muted-foreground">{nextLabel(job.trigger)}</dt><dd>{nextText(job, now, effectiveTimezone(view))}</dd></div>
        <div className="flex items-center gap-2"><dt className="text-muted-foreground">Last</dt><dd><OutcomeBadge job={job} /></dd></div>
      </dl>
      <JobNotes job={job} />
    </li>
  );
}

function JobDetail({ onBack, onOpenRun, ...props }: JobProps & { onBack: () => void; onOpenRun: (runId: string) => void }) {
  const { project, view, job, now, controls } = props;
  const runs = useTargetLabel(project, job);
  const history = useWorldStore((s) => s.scheduleHistoryByJob[job.id]);
  const loadScheduleHistory = useWorldStore((s) => s.loadScheduleHistory);
  // Null until the Building's runs are loaded: an entry's run link is then offered on the entry's word alone.
  const knownRuns = useWorldStore((s) => s.workflowRunsByProject[project.id]);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const timezone = effectiveTimezone(view);

  useEffect(() => { void loadScheduleHistory(project.id, job.id); }, [project.id, job.id, loadScheduleHistory]);

  const knownRunIds = knownRuns ? new Set(knownRuns.map((run) => run.id)) : null;
  const rows = filterHistory(history?.entries ?? [], filter).map((entry) => historyRow(entry, now, timezone, knownRunIds));
  const cards = [
    { label: 'Starts', value: `${triggerLabel(job.trigger)} (${triggerDetail(job.trigger)})` },
    { label: 'Runs', value: runs },
    { label: nextLabel(job.trigger), value: `${nextText(job, now, timezone)}, ${timezone}` },
    ...guardrailCards(job),
  ];

  return (
    <section aria-label={`Job: ${job.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={controls.back.disabled} onClick={onBack}><ArrowLeft aria-hidden="true" />Back</Button>
          <h3 className="truncate text-base font-semibold tracking-tight">{job.name}</h3>
          <JobTags job={job} />
          <OutcomeBadge job={job} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 text-sm"><JobSwitch {...props} />{job.enabled ? 'On' : 'Off'}</span>
          <JobActions {...props} />
        </div>
      </div>
      <JobNotes job={job} />

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border bg-card p-3 shadow-sm">
            <dt className="text-xs text-muted-foreground">{card.label}</dt>
            <dd className="mt-1 break-words text-sm">{card.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">Run history</h4>
        <div className="flex gap-1" role="group" aria-label="Filter run history">
          {HISTORY_FILTERS.map(({ key, label }) => (
            <Button key={key} type="button" size="sm" variant={filter === key ? 'secondary' : 'ghost'} aria-pressed={filter === key} disabled={controls.historyFilter.disabled} onClick={() => setFilter(key)}>{label}</Button>
          ))}
        </div>
      </div>
      <div className="mt-3 overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>{['Started', 'Started by', 'Outcome', 'Duration', 'Details', 'Run'].map((heading) => <th key={heading} scope="col" className="px-3 py-2 font-medium">{heading}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t align-top">
                <td className="whitespace-nowrap px-3 py-2">{row.when}</td>
                <td className="whitespace-nowrap px-3 py-2">{row.startedBy}</td>
                <td className="px-3 py-2"><Badge variant={TONE_VARIANT[row.badge.tone]}>{row.badge.label}</Badge></td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{row.duration}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.details}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  {row.runId ? <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={controls.openRun.disabled} onClick={() => onOpenRun(row.runId!)}>Open run</Button> : <span className="text-muted-foreground">No run</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center italic text-muted-foreground">{history ? HISTORY_EMPTY_TEXT : 'Loading history...'}</td></tr>}
          </tbody>
        </table>
      </div>
      {history?.nextCursor && (
        <Button type="button" variant="outline" size="sm" className="mt-3" disabled={controls.loadMore.disabled} onClick={() => void loadScheduleHistory(project.id, job.id, { more: true })}>Show older entries</Button>
      )}
      <p className="mt-4 text-xs text-muted-foreground">Editing a job while its run is going changes later runs only.</p>
    </section>
  );
}
