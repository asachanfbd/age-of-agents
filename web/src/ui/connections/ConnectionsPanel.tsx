import { useEffect, useId, useMemo, useState } from 'react';
import { Link2, Pencil, PhoneCall, Plus, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { isBuildingReadOnly } from '../../lib/buildingTypes';
import {
  buildCallInputs, buildingLabel, callFields, callProblem, canPreApprove, defaultGrants, grantChoices, linkRows, toggleGrant, togglePreApproved,
} from '../../lib/connections';
import type { CallValues, LinkGrant, LinkView } from '../../lib/connections';
import { useWorldStore } from '../../store/worldStore';
import type { ProjectData } from '../../types';

const SELECT_CLASS = 'h-9 w-full rounded-md border border-border bg-card px-2 text-sm';

type Editing = { mode: 'new' } | { mode: 'edit'; link: LinkView } | null;

/**
 * The Connections view every Building gets: the links it uses and the links others use on it, what each link
 * grants, the events it listens to, and a manual call. Changes are refused on a read-only Building by disabling their
 * controls, so a refusal is never attempted just to be answered with a 409.
 */
export function ConnectionsPanel({ project }: { project: ProjectData }) {
  const links = useWorldStore((s) => s.linksByProject[project.id]);
  const subscriptions = useWorldStore((s) => s.subscriptionsByProject[project.id]) ?? [];
  const loadError = useWorldStore((s) => s.connectionLoadErrorByProject[project.id]);
  const loadLinks = useWorldStore((s) => s.loadLinks);
  const loadSubscriptions = useWorldStore((s) => s.loadSubscriptions);
  const loadSchedules = useWorldStore((s) => s.loadSchedules);
  const deleteLink = useWorldStore((s) => s.deleteLink);
  const setSubscriptionEnabled = useWorldStore((s) => s.setSubscriptionEnabled);
  const deleteSubscription = useWorldStore((s) => s.deleteSubscription);
  const [editing, setEditing] = useState<Editing>(null);
  const [calling, setCalling] = useState<LinkView | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = isBuildingReadOnly(project);

  useEffect(() => {
    void loadLinks(project.id);
    void loadSubscriptions(project.id);
    void loadSchedules(project.id);
  }, [project.id, loadLinks, loadSubscriptions, loadSchedules]);

  const report = (result: { ok: boolean; error?: string }) => setError(result.ok ? null : result.error ?? 'The change failed');
  const rows = links ? linkRows(links) : [];
  const byId = new Map([...(links?.outgoing ?? []), ...(links?.incoming ?? [])].map((link) => [link.id, link]));

  if (!links) {
    return <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" aria-label="Connections">{loadError ? <p className="text-sm text-destructive" role="alert">{loadError}</p> : <p className="text-sm text-muted-foreground">Loading connections...</p>}</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" aria-label="Connections">
      {(error || loadError) && <p className="mb-3 text-sm text-destructive" role="alert">{error ?? loadError}</p>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold tracking-tight">Connections</h3>
          <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">A link lets this Building use chosen capabilities and events of another Building. Without a link, calls are refused.</p>
        </div>
        <Button type="button" size="sm" disabled={readOnly} onClick={() => setEditing({ mode: 'new' })}><Plus aria-hidden="true" />Link to a Building</Button>
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">No links yet.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2" aria-label="Links">
          {rows.map((row) => {
            const link = byId.get(row.id)!;
            return (
              <li key={row.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
                <Link2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{row.direction === 'outgoing' ? `${project.name} → ${row.otherName}` : `${row.otherName} → ${project.name}`}</p>
                  <p className="text-xs text-muted-foreground">{row.direction === 'outgoing' ? 'Uses' : 'Used by'} · {row.summary}</p>
                  {row.broken && <p className="text-xs text-destructive" role="status">{row.brokenReasons.join('. ')}</p>}
                </div>
                {row.broken && <Badge variant="destructive">Broken</Badge>}
                {row.direction === 'outgoing' && (
                  <>
                    <Button type="button" variant="outline" size="sm" disabled={readOnly || row.broken} onClick={() => setCalling(link)}><PhoneCall aria-hidden="true" />Call</Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Edit link to ${row.otherName}`} disabled={readOnly} onClick={() => setEditing({ mode: 'edit', link })}><Pencil aria-hidden="true" /></Button>
                  </>
                )}
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove link with ${row.otherName}`} disabled={readOnly} onClick={async () => report(await deleteLink(project.id, row.id))}><Trash2 aria-hidden="true" /></Button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold tracking-tight">Event subscriptions</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">An event from a linked Building starts one of this Building's jobs.</p>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={readOnly || !(links.outgoing.some((l) => l.events.length))} onClick={() => setSubscribing(true)}><Plus aria-hidden="true" />Subscribe</Button>
      </div>
      {subscriptions.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No subscriptions.</p> : (
        <ul className="mt-3 flex flex-col gap-2" aria-label="Event subscriptions">
          {subscriptions.filter((s) => s.subscriberBuildingId === project.id).map((s) => {
            const source = links.outgoing.find((l) => l.toBuildingId === s.sourceBuildingId);
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{s.eventId} from {buildingLabel(source?.toName)}</span>
                {s.autoDisabled && <Badge variant="warning">Turned off: too many events</Badge>}
                <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={async () => report(await setSubscriptionEnabled(project.id, s.id, !s.enabled))}>{s.enabled ? 'Turn off' : 'Turn on'}</Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove subscription to ${s.eventId}`} disabled={readOnly} onClick={async () => report(await deleteSubscription(project.id, s.id))}><Trash2 aria-hidden="true" /></Button>
              </li>
            );
          })}
        </ul>
      )}

      {editing && <LinkEditorDialog project={project} editing={editing} onClose={() => setEditing(null)} />}
      {calling && <CallDialog project={project} link={calling} onClose={() => setCalling(null)} />}
      {subscribing && <SubscribeDialog project={project} links={links.outgoing} onClose={() => setSubscribing(false)} />}
    </div>
  );
}

function Labelled({ label, error, children }: { label: string; error?: string | null; children: (props: { id: string; 'aria-invalid': boolean }) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children({ id, 'aria-invalid': Boolean(error) })}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}

function LinkEditorDialog({ project, editing, onClose }: { project: ProjectData; editing: NonNullable<Editing>; onClose: () => void }) {
  const projects = useWorldStore((s) => s.projects);
  const types = useWorldStore((s) => s.buildingTypes);
  const createLink = useWorldStore((s) => s.createLink);
  const updateLink = useWorldStore((s) => s.updateLink);
  const links = useWorldStore((s) => s.linksByProject[project.id]);
  const existing = editing.mode === 'edit' ? editing.link : null;
  const linked = new Set((links?.outgoing ?? []).map((l) => l.toBuildingId));
  const candidates = projects.filter((p) => p.id !== project.id && (existing ? p.id === existing.toBuildingId : !linked.has(p.id)));
  const [targetId, setTargetId] = useState(existing?.toBuildingId ?? candidates[0]?.id ?? '');
  // null until the person changes a checkbox: the grants then follow the stored link, or every capability of the target.
  const [chosenGrants, setChosenGrants] = useState<LinkGrant[] | null>(null);
  const [events, setEvents] = useState<string[]>(existing?.events ?? []);
  const [error, setError] = useState<string | null>(null);
  const target = projects.find((p) => p.id === targetId);
  const choices = grantChoices(types.find((t) => t.id === (target?.typeId ?? 'software')));

  const grants = chosenGrants ?? existing?.capabilities ?? defaultGrants(choices.capabilities);

  async function save() {
    const result = existing
      ? await updateLink(project.id, existing.id, { capabilities: grants, events })
      : await createLink(project.id, { fromBuildingId: project.id, toBuildingId: targetId, capabilities: grants, events });
    if (result.ok) onClose(); else setError(result.error);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit link' : 'Link to a Building'}</DialogTitle>
          <DialogDescription>Choose what {project.name} may use. Anything not ticked is refused.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <Labelled label="Building">
            {(props) => (
              <select {...props} className={SELECT_CLASS} value={targetId} disabled={Boolean(existing)} onChange={(e) => { setTargetId(e.target.value); setChosenGrants(null); setEvents([]); }}>
                {candidates.length === 0 && <option value="">No Building left to link</option>}
                {candidates.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
          </Labelled>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Capabilities</legend>
            <p className="text-xs text-muted-foreground">All capabilities are on; uncheck any you don't want to share.</p>
            {choices.capabilities.length === 0 && <p className="text-xs text-muted-foreground">This Building offers no capabilities.</p>}
            {choices.capabilities.map((capability) => {
              const grant = grants.find((g) => g.capabilityId === capability.id);
              return (
                <div key={capability.id} className="flex flex-col gap-1">
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={Boolean(grant)} onChange={() => setChosenGrants(toggleGrant(grants, capability.id))} />
                    <span><span className="font-medium">{capability.id}</span> <Badge variant="secondary">{capability.mode === 'read' ? 'Reads' : 'Changes things'}</Badge><br /><span className="text-xs text-muted-foreground">{capability.description}</span></span>
                  </label>
                  {grant && canPreApprove(capability) && (
                    <label className="ml-6 flex items-center gap-2 text-xs"><input type="checkbox" checked={grant.preApproved} onChange={() => setChosenGrants(togglePreApproved(grants, capability.id))} />Pre-approved for scheduled jobs</label>
                  )}
                </div>
              );
            })}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Events</legend>
            {choices.events.length === 0 && <p className="text-xs text-muted-foreground">This Building publishes no events.</p>}
            {choices.events.map((event) => (
              <label key={event.id} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={events.includes(event.id)} onChange={() => setEvents((current) => (current.includes(event.id) ? current.filter((e) => e !== event.id) : [...current, event.id]))} />
                <span><span className="font-medium">{event.id}</span><br /><span className="text-xs text-muted-foreground">{event.description}</span></span>
              </label>
            ))}
          </fieldset>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={!targetId} onClick={save}>{existing ? 'Save' : 'Create link'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CallDialog({ project, link, onClose }: { project: ProjectData; link: LinkView; onClose: () => void }) {
  const projects = useWorldStore((s) => s.projects);
  const types = useWorldStore((s) => s.buildingTypes);
  const callCapability = useWorldStore((s) => s.callCapability);
  const target = projects.find((p) => p.id === link.toBuildingId);
  const capabilities = useMemo(() => (grantChoices(types.find((t) => t.id === (target?.typeId ?? 'software'))).capabilities)
    .filter((c) => link.capabilities.some((g) => g.capabilityId === c.id)), [types, target, link]);
  const [capabilityId, setCapabilityId] = useState(capabilities[0]?.id ?? '');
  const [values, setValues] = useState<CallValues>({});
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const capability = capabilities.find((c) => c.id === capabilityId);
  const problem = capability ? callProblem(capability, values) : null;

  async function send() {
    if (!capability || problem) return;
    const result = await callCapability(project.id, { targetBuildingId: link.toBuildingId, capabilityId: capability.id, inputs: buildCallInputs(capability, values) });
    if (!result.ok) { setOutcome({ tone: 'error', text: result.error }); return; }
    setOutcome({
      tone: 'ok',
      text: result.outcome.state === 'awaiting-approval' ? 'Waiting for approval. Approve it in Activity.' : `Done.${result.outcome.runRef ? ` Run: ${result.outcome.runRef}.` : ''} ${JSON.stringify(result.outcome.outputs ?? {})}`,
    });
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Call {buildingLabel(link.toName)}</DialogTitle>
          <DialogDescription>A call that changes things waits for approval first.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {outcome && <Alert variant={outcome.tone === 'error' ? 'destructive' : 'default'} role={outcome.tone === 'error' ? 'alert' : 'status'}><AlertDescription>{outcome.text}</AlertDescription></Alert>}
          <Labelled label="Capability">
            {(props) => (
              <select {...props} className={SELECT_CLASS} value={capabilityId} onChange={(e) => { setCapabilityId(e.target.value); setValues({}); setOutcome(null); }}>
                {capabilities.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
              </select>
            )}
          </Labelled>
          {capability && callFields(capability).map((field) => (
            <Labelled key={field.name} label={`${field.label}${field.required ? ' *' : ''}`} error={problem?.field === field.name ? problem.message : null}>
              {(props) => field.kind === 'select' ? (
                <select {...props} className={SELECT_CLASS} value={String(values[field.name] ?? '')} onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}>
                  <option value="" />{field.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : field.kind === 'checkbox' ? (
                <input {...props} type="checkbox" checked={values[field.name] === true} onChange={(e) => setValues({ ...values, [field.name]: e.target.checked })} />
              ) : field.kind === 'json' || (field.max !== null && field.max > 200) ? (
                <Textarea {...props} value={String(values[field.name] ?? '')} onChange={(e) => setValues({ ...values, [field.name]: e.target.value })} />
              ) : (
                <Input {...props} value={String(values[field.name] ?? '')} onChange={(e) => setValues({ ...values, [field.name]: e.target.value })} />
              )}
            </Labelled>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
          <Button type="button" disabled={!capability || Boolean(problem)} onClick={send}>Send</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SubscribeDialog({ project, links, onClose }: { project: ProjectData; links: LinkView[]; onClose: () => void }) {
  const jobs = useWorldStore((s) => s.schedulesByProject[project.id]?.jobs) ?? [];
  const createSubscription = useWorldStore((s) => s.createSubscription);
  const options = links.flatMap((link) => link.events.map((eventId) => ({ key: `${link.toBuildingId}|${eventId}`, sourceBuildingId: link.toBuildingId, eventId, label: `${eventId} from ${buildingLabel(link.toName)}` })));
  const [choice, setChoice] = useState(options[0]?.key ?? '');
  const [jobId, setJobId] = useState(jobs[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const picked = options.find((o) => o.key === choice);
    if (!picked) return;
    const result = await createSubscription(project.id, { sourceBuildingId: picked.sourceBuildingId, eventId: picked.eventId, jobId });
    if (result.ok) onClose(); else setError(result.error);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Subscribe to an event</DialogTitle>
          <DialogDescription>When the event happens, the chosen job starts in {project.name}.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <Labelled label="Event">{(props) => <select {...props} className={SELECT_CLASS} value={choice} onChange={(e) => setChoice(e.target.value)}>{options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select>}</Labelled>
          <Labelled label="Job to start">{(props) => <select {...props} className={SELECT_CLASS} value={jobId} onChange={(e) => setJobId(e.target.value)}>{jobs.length === 0 && <option value="">No jobs in Schedules yet</option>}{jobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select>}</Labelled>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={!choice || !jobId} onClick={save}>Subscribe</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
