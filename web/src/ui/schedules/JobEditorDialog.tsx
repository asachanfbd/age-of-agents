import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  CRON_PRESETS, RUN_GOING_NOTE, acceptCronPreview, cronLabel, cronPreviewText, editorGroups, emptyJobForm, errorSummary, formToRequest, jobToForm,
  serverErrorToForm, validateJobForm,
} from '../../lib/schedules';
import type { CronPreviewState, JobForm, JobFormErrors, JobFormField, ScheduledJob, TriggerKind } from '../../lib/schedules';
import { serverApi } from '../../lib/serverApi';
import { useWorldStore } from '../../store/worldStore';
import type { ProjectData } from '../../types';

const SELECT_CLASS = 'h-9 w-full rounded-md border border-border bg-card px-2 text-sm';
const TRIGGERS: { kind: TriggerKind; label: string }[] = [
  { kind: 'cron', label: 'On a schedule' },
  { kind: 'file', label: 'A folder or file changes' },
  { kind: 'api', label: 'An API response changes' },
];

/** One labelled field with its error underneath; `children` gets the ids and `aria-invalid` to put on the control. */
function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy })}
      {hint && !error && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}

/**
 * Creates or edits one job. The schedule's timezone is the Building's, set at the top of Schedules, so this only says
 * which one applies. The missed-run rule shows for a schedule only and the check interval for a watch job only.
 */
export function JobEditorDialog({ project, job, timezone, onClose }: { project: ProjectData; job: ScheduledJob | null; timezone: string; onClose: () => void }) {
  const slots = useWorldStore((s) => s.buildingTypes.find((type) => type.id === project.typeId)?.slots) ?? [];
  const workflows = useWorldStore((s) => s.catalogWorkflows);
  const agents = useWorldStore((s) => s.catalogAgents);
  const createScheduleJob = useWorldStore((s) => s.createScheduleJob);
  const updateScheduleJob = useWorldStore((s) => s.updateScheduleJob);
  const commands = useWorldStore((s) => s.commandsByProject[project.id]);
  const loadCommands = useWorldStore((s) => s.loadCommands);
  const [form, setForm] = useState<JobForm>(() => (job ? jobToForm(job) : emptyJobForm(slots)));
  const [errors, setErrors] = useState<JobFormErrors>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<CronPreviewState>({ status: 'idle' });
  const groups = editorGroups(form);
  const savedCommands = commands ?? [];
  const commandIsGone = groups.command && form.commandId !== '' && commands !== undefined && !commands.some((command) => command.id === form.commandId);

  useEffect(() => { if (!commands) void loadCommands(project.id); }, [commands, project.id, loadCommands]);

  const change = <K extends keyof JobForm>(key: K, value: JobForm[K], field?: JobFormField) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (field && errors[field]) setErrors(({ [field]: _cleared, ...rest }) => rest);
  };

  // The next three run times for the expression in the field, asked of the daemon so they match what it will do.
  // A reply is kept with its expression and shown only while that expression is still the one in the field.
  useEffect(() => {
    const cron = form.cron.trim();
    if (form.triggerKind !== 'cron' || !cron) return;
    let latest = true;
    const timer = window.setTimeout(() => {
      serverApi.previewScheduleCron(project.id, cron)
        .then((reply) => { if (latest) setPreview({ status: 'ok', cron, runs: reply.runs }); })
        .catch(() => { if (latest) setPreview({ status: 'invalid', cron }); });
    }, 250);
    return () => { latest = false; window.clearTimeout(timer); };
  }, [form.cron, form.triggerKind, project.id]);
  const shownPreview: CronPreviewState = acceptCronPreview(form.cron, preview) ?? (form.cron.trim() ? { status: 'loading', cron: form.cron.trim() } : { status: 'idle' });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const found = validateJobForm(form, slots.map((slot) => slot.id), savedCommands.map((command) => command.id));
    setErrors(found);
    setSummary(errorSummary(found));
    if (Object.keys(found).length) return;
    setSaving(true);
    const request = formToRequest(form);
    const result = job ? await updateScheduleJob(project.id, job.id, request) : await createScheduleJob(project.id, request);
    setSaving(false);
    if (result.ok) { onClose(); return; }
    const shown = serverErrorToForm({ message: result.error, field: result.field });
    setErrors(shown.errors);
    setSummary(shown.summary);
  }

  const workflowName = (workflowId: string) => workflows.find((workflow) => workflow.id === workflowId)?.name ?? workflowId;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[min(90vh,var(--popup-max-height))] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{job ? 'Edit job' : 'New job'}</DialogTitle></DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)} noValidate>
          {job?.activeRun && <Alert role="status"><AlertDescription>{RUN_GOING_NOTE}</AlertDescription></Alert>}
          {summary && <Alert variant="destructive" role="alert"><AlertDescription className="text-destructive">{summary}</AlertDescription></Alert>}

          <Field label="Name" error={errors.name}>
            {(props) => <Input {...props} value={form.name} maxLength={120} onChange={(event) => change('name', event.target.value, 'name')} />}
          </Field>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-semibold">What starts it</legend>
            <div className="flex flex-wrap gap-2" role="group" aria-label="What starts it">
              {TRIGGERS.map(({ kind, label }) => (
                <Button key={kind} type="button" size="sm" variant={form.triggerKind === kind ? 'secondary' : 'outline'} aria-pressed={form.triggerKind === kind} onClick={() => change('triggerKind', kind)}>{label}</Button>
              ))}
            </div>

            {groups.cron && (
              <>
                <Field label="Schedule (cron expression)" error={errors.cron} hint={`Times use this Building's timezone: ${timezone}. Change it at the top of Schedules.`}>
                  {(props) => <Input {...props} value={form.cron} className="font-mono" onChange={(event) => change('cron', event.target.value, 'cron')} />}
                </Field>
                <div className="flex flex-wrap gap-2">
                  {CRON_PRESETS.map((preset) => <Button key={preset.cron} type="button" size="sm" variant="outline" onClick={() => change('cron', preset.cron, 'cron')}>{preset.chip}</Button>)}
                </div>
                <p className="text-xs text-muted-foreground" aria-live="polite">{[cronLabel(form.cron) === form.cron ? null : cronLabel(form.cron), cronPreviewText(shownPreview, timezone)].filter(Boolean).join('. ')}</p>
              </>
            )}

            {groups.folder && (
              <>
                <Field label="Folder or file to watch" error={errors.path} hint="A path inside this Building's folder, or a full path anywhere on this computer.">
                  {(props) => <Input {...props} value={form.path} onChange={(event) => change('path', event.target.value, 'path')} />}
                </Field>
                <Field label="Count it as changed when">
                  {(props) => (
                    <select {...props} className={SELECT_CLASS} value={form.detect} onChange={(event) => change('detect', event.target.value as JobForm['detect'])}>
                      <option value="mtime">The modified time changes (faster)</option>
                      <option value="hash">The content changes (content hash)</option>
                    </select>
                  )}
                </Field>
              </>
            )}

            {groups.api && (
              <>
                <Field label="API address (GET)" error={errors.url}>
                  {(props) => <Input {...props} value={form.url} placeholder="https://" onChange={(event) => change('url', event.target.value, 'url')} />}
                </Field>
                <Field label="Only watch this JSON field (optional)" error={errors.jsonField} hint="For example plans[0].price. Leave empty to react to any change in the response.">
                  {(props) => <Input {...props} value={form.jsonField} onChange={(event) => change('jsonField', event.target.value, 'jsonField')} />}
                </Field>
              </>
            )}

            {groups.interval && (
              <Field label="Check every" error={errors.every} hint="At least 1 minute. If a check fails (address down, folder unreadable) the error is recorded, no run starts, and it tries again at the next check.">
                {(props) => (
                  <div className="flex gap-2">
                    <Input {...props} value={form.every} inputMode="numeric" className="w-28" onChange={(event) => change('every', event.target.value, 'every')} />
                    <select aria-label="Interval unit" className={`${SELECT_CLASS} w-32`} value={form.unit} onChange={(event) => change('unit', event.target.value as JobForm['unit'], 'every')}>
                      <option value="seconds">seconds</option>
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                    </select>
                  </div>
                )}
              </Field>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-semibold">What it runs</legend>
            {form.targetKind === 'capability' && <p className="text-sm text-muted-foreground">This job calls a capability of a linked Building. Its target is not changed here.</p>}
            {form.targetKind !== 'capability' && <div className="flex flex-wrap gap-2" role="group" aria-label="What it runs">
              <Button type="button" size="sm" variant={groups.slot ? 'secondary' : 'outline'} aria-pressed={groups.slot} onClick={() => change('targetKind', 'slot')}>One of this Building's workflows</Button>
              <Button type="button" size="sm" variant={groups.prompt ? 'secondary' : 'outline'} aria-pressed={groups.prompt} onClick={() => change('targetKind', 'prompt')}>A single agent prompt</Button>
              <Button type="button" size="sm" variant={groups.command ? 'secondary' : 'outline'} aria-pressed={groups.command} onClick={() => change('targetKind', 'command')}>A saved command</Button>
            </div>}

            {groups.slot && (
              <>
                <Field label="Workflow slot" error={errors.slot} hint="Which workflow fills a slot is set in the Catalog.">
                  {(props) => (
                    <select {...props} className={SELECT_CLASS} value={form.slot} onChange={(event) => change('slot', event.target.value, 'slot')}>
                      <option value="">Choose a slot</option>
                      {slots.map((slot) => <option key={slot.id} value={slot.id}>{slot.label} (runs "{workflowName(slot.defaultWorkflowId)}" by default)</option>)}
                    </select>
                  )}
                </Field>
                <Field label="Task description" error={errors.task} hint="Each run appears on the Tasks board as a task with this description.">
                  {(props) => <Textarea {...props} value={form.task} rows={3} onChange={(event) => change('task', event.target.value, 'task')} />}
                </Field>
              </>
            )}

            {groups.prompt && (
              <>
                <Field label="Agent" error={errors.agent}>
                  {(props) => (
                    <select {...props} className={SELECT_CLASS} value={form.agent} onChange={(event) => change('agent', event.target.value, 'agent')}>
                      <option value="">The Catalog's default agent</option>
                      {agents.filter((agent) => agent.enabled || agent.id === form.agent).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                    </select>
                  )}
                </Field>
                <Field label="Prompt" error={errors.prompt}>
                  {(props) => <Textarea {...props} value={form.prompt} rows={4} onChange={(event) => change('prompt', event.target.value, 'prompt')} />}
                </Field>
              </>
            )}

            {groups.command && (
              <>
                <Field label="Saved command" error={errors.command} hint={savedCommands.length === 0 ? 'This Building has no saved commands yet. Add one in Settings > Commands.' : 'Runs in the Building\'s folder, like pressing Run on the Commands tab.'}>
                  {(props) => (
                    <select {...props} className={SELECT_CLASS} value={form.commandId} disabled={savedCommands.length === 0} onChange={(event) => change('commandId', event.target.value, 'command')}>
                      <option value="">Choose a command</option>
                      {commandIsGone && <option value={form.commandId}>Command no longer exists</option>}
                      {savedCommands.map((command) => <option key={command.id} value={command.id}>{command.name} — {command.command}</option>)}
                    </select>
                  )}
                </Field>
                <p className="text-xs text-muted-foreground">A command uses no agent, so approval and usage limits do not apply, and a new run is skipped while the command is already running.</p>
              </>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-semibold">Guardrails</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="If the last run is still going">
                {(props) => (
                  <select {...props} className={SELECT_CLASS} value={groups.command ? 'skip' : form.overlap} disabled={groups.command} onChange={(event) => change('overlap', event.target.value as JobForm['overlap'])}>
                    <option value="skip">Skip the new run (default)</option>
                    <option value="queue">Queue one run</option>
                    <option value="parallel">Allow runs side by side</option>
                  </select>
                )}
              </Field>
              {groups.missed && (
                <Field label="If a run was missed while the app was off">
                  {(props) => (
                    <select {...props} className={SELECT_CLASS} value={form.missedPolicy} onChange={(event) => change('missedPolicy', event.target.value as JobForm['missedPolicy'])}>
                      <option value="skip">Skip it (default)</option>
                      <option value="once">Run once to catch up</option>
                    </select>
                  )}
                </Field>
              )}
              <Field label="Most runs per day (optional)" error={errors.perDay}>
                {(props) => <Input {...props} value={form.perDay} inputMode="numeric" onChange={(event) => change('perDay', event.target.value, 'perDay')} />}
              </Field>
              <Field label="Turn the job off after failed runs in a row" error={errors.failures}>
                {(props) => <Input {...props} value={form.failures} inputMode="numeric" onChange={(event) => change('failures', event.target.value, 'failures')} />}
              </Field>
              <Field label="Do not start above this 5-hour usage (%, optional)" error={errors.fiveHour}>
                {(props) => <Input {...props} value={form.fiveHour} disabled={groups.command} inputMode="numeric" onChange={(event) => change('fiveHour', event.target.value, 'fiveHour')} />}
              </Field>
              <Field label="Do not start above this weekly usage (%, optional)" error={errors.weekly}>
                {(props) => <Input {...props} value={form.weekly} disabled={groups.command} inputMode="numeric" onChange={(event) => change('weekly', event.target.value, 'weekly')} />}
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">Usage is the default coding agent's own limit, the same numbers as the bars in the status footer. A run held back by a budget is listed in the job's history with the reason.</p>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={form.needsApproval && !groups.command} disabled={groups.command} onChange={(event) => change('needsApproval', event.target.checked)} />
              <span><span className="font-medium">Needs approval.</span> The run pauses before its last step (publishing, sending) until you approve, request changes or stop it.</span>
            </label>
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>{job ? 'Save changes' : 'Create job'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
