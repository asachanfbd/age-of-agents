import { Badge } from '@/components/ui/badge';
import { Section } from '../design/Header';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { crmApi } from '../../lib/crmApi';
import { agentBanner, ATTACHMENT_MAX_BYTES, ATTACHMENTS_MAX, badgeFor, canSaveNotes, checkAttachment, momListParams, transcriptLabel } from '../../lib/crmNotes';
import { pagingLabel } from '../../lib/crmProspects';
import { crmControlsDisabled, disabledTitle } from '../../lib/crmWorkspace';
import type { MomDto } from '../../lib/crmTypes';
import { ErrorNote } from './shared';
import { errorText, useLoad } from './crmHooks';
import { RelativeTime } from '../design/RelativeTime';
import type { CrmTabProps } from './types';

function MomEditor({ projectId, mom, readOnly, onChanged }: { projectId: string; mom: MomDto; readOnly: boolean; onChanged: () => void }) {
  const [notes, setNotes] = useState(mom.notes);
  const [transcript, setTranscript] = useState(mom.transcript);
  const [summary, setSummary] = useState(mom.draft?.summary ?? mom.summary);
  const [decisions, setDecisions] = useState(mom.draft?.decisions ?? mom.decisions);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const disabled = crmControlsDisabled(readOnly);
  const banner = agentBanner(mom, agentError);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(null); try { await work(); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const upload = (kind: 'attachment' | 'audio', file: File | undefined) => run(async () => {
    if (!file) return;
    const problem = kind === 'attachment' ? checkAttachment(file, mom.files.filter((f) => f.kind === 'attachment').length) : null;
    if (problem) throw new Error(problem);
    await crmApi.uploadMomFile(projectId, mom.id, kind, file);
  });

  return (
    <div className="grid gap-3 text-sm" aria-label="MOM editor">
      <ErrorNote message={error} />
      {banner?.kind === 'error' && <div className="rounded-2xl border border-destructive bg-destructive/15 p-2 text-destructive" role="alert">The agent failed: {banner.message}. Your typed notes are safe and can still be saved.</div>}
      {banner?.kind === 'draft' && (
        <div className="grid gap-2 rounded-2xl border border-info bg-info/15 p-2 text-info-foreground" role="status">
          <span>An agent drafted this MOM. Review it, edit the text below if needed, then accept or discard.</span>
          <span className="flex gap-2">
            <Button size="sm" disabled={disabled || busy} onClick={() => void run(async () => { await crmApi.acceptMomDraft(projectId, mom.id, { summary, decisions }); })}>Accept</Button>
            <Button size="sm" variant="outline" onClick={() => document.getElementById(`mom-summary-${mom.id}`)?.focus()}>Edit</Button>
            <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void run(async () => { await crmApi.discardMomDraft(projectId, mom.id); })}>Discard</Button>
          </span>
        </div>
      )}
      <label className="grid gap-1">Typed notes<Textarea aria-label="Typed notes" className="min-h-24" value={notes} disabled={disabled} onChange={(e) => setNotes(e.target.value)} /></label>
      <label className="grid gap-1">Transcript <span className="text-xs text-muted-foreground">({transcriptLabel(mom.transcriptStatus)})</span>
        <Textarea aria-label="Transcript" className="min-h-20" placeholder="Paste a transcript if the audio could not be transcribed" value={transcript} disabled={disabled} onChange={(e) => setTranscript(e.target.value)} /></label>
      <label className="grid gap-1">Summary<Textarea id={`mom-summary-${mom.id}`} aria-label="Summary" className="min-h-20" value={summary} disabled={disabled} onChange={(e) => setSummary(e.target.value)} /></label>
      <label className="grid gap-1">Decisions<Textarea aria-label="Decisions" className="min-h-16" value={decisions} disabled={disabled} onChange={(e) => setDecisions(e.target.value)} /></label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!canSaveNotes(readOnly) || busy} title={disabledTitle(readOnly)} onClick={() => void run(async () => { await crmApi.patchMom(projectId, mom.id, { notes, transcript, ...(mom.draft ? {} : { summary, decisions }) }); })}>Save</Button>
        <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void run(async () => { await crmApi.patchMom(projectId, mom.id, { notes, transcript }); const r = await crmApi.analyse(projectId, mom.id); setAgentError(r.agentError ?? null); })}>Analyse with an agent</Button>
        <Button size="sm" variant="outline" disabled={disabled || busy || !mom.files.some((f) => f.kind === 'audio')} onClick={() => void run(async () => { const r = await crmApi.transcribe(projectId, mom.id); setAgentError(r.agentError ?? null); })}>Transcribe audio</Button>
      </div>
      <Section title={`Attachments and audio (${mom.files.length})`}>
        <ul className="m-0 grid list-none gap-1 p-0">
          {mom.files.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2"><a className="truncate underline" href={crmApi.momFileUrl(projectId, mom.id, f.id)} download={f.name}>{f.name}</a><span className="text-xs text-muted-foreground">{f.kind} · {(f.size / 1024).toFixed(1)} KB</span>
              <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void run(async () => { await crmApi.deleteMomFile(projectId, mom.id, f.id); })}>Remove</Button></li>
          ))}
        </ul>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-xs text-muted-foreground">Add a document (max {ATTACHMENT_MAX_BYTES / 1_048_576} MB each, {ATTACHMENTS_MAX} per MOM)<Input aria-label="Add a document" type="file" disabled={disabled} onChange={(e) => void upload('attachment', e.target.files?.[0])} /></label>
          <label className="grid gap-1 text-xs text-muted-foreground">Add an audio note<Input aria-label="Add an audio note" type="file" accept="audio/*" disabled={disabled} onChange={(e) => void upload('audio', e.target.files?.[0])} /></label>
        </div>
      </Section>
      <Section title="Action items">
        {mom.actionItems.length === 0 && <p className="m-0 text-muted-foreground">No action items yet.</p>}
        <ul className="m-0 grid list-none gap-1 p-0">
          {mom.actionItems.map((a, i) => (
            <li key={`${i}-${a.title}`} className="flex items-center justify-between gap-2"><span>{a.title}</span>
              {a.followupId ? <Badge variant="success">Followup created</Badge> : <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void run(async () => { await crmApi.actionItemToFollowup(projectId, mom.id, i); })}>Make a followup</Button>}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/** Meeting notes across contacts: searchable by text, contact and date, and an editor with attachments, audio and agent drafts. */
export function NotesTab({ project, readOnly, onOpenContact }: CrmTabProps) {
  const [filters, setFilters] = useState({ search: '', contactId: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const list = useLoad(() => crmApi.moms(project.id, momListParams({ search: filters.search, contactId: filters.contactId ? Number(filters.contactId) : null, from: filters.from, to: filters.to, offset, limit: 50 })), [project.id, filters, offset]);
  const settings = useLoad(() => crmApi.settings(project.id), [project.id]);
  const open = useLoad(() => (selected === null ? Promise.resolve(null) : crmApi.mom(project.id, selected)), [project.id, selected]);
  const change = (patch: Partial<typeof filters>) => { setOffset(0); setFilters((f) => ({ ...f, ...patch })); };
  const page = list.data;
  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_1fr]" aria-label="Notes (MOM)">
      <div className="grid content-start gap-2">
        <Input aria-label="Search notes" placeholder="Search notes" value={filters.search} onChange={(e) => change({ search: e.target.value })} />
        <div className="grid grid-cols-3 gap-1">
          <Input aria-label="Contact id" placeholder="Contact id" inputMode="numeric" value={filters.contactId} onChange={(e) => change({ contactId: e.target.value.replace(/\D/g, '') })} />
          <Input aria-label="From" type="date" value={filters.from} onChange={(e) => change({ from: e.target.value })} />
          <Input aria-label="To" type="date" value={filters.to} onChange={(e) => change({ to: e.target.value })} />
        </div>
        <ErrorNote message={list.error} />
        {page && page.rows.length === 0 && <p className="m-0 text-sm text-muted-foreground">No notes match. Open a meeting on the Calendar and add notes to it.</p>}
        <ul className="m-0 grid list-none gap-1 p-0">
          {(page?.rows ?? []).map((m) => (
            <li key={m.id}>
              <button type="button" className={`w-full rounded-2xl border p-2 text-left text-sm hover:bg-muted/50 ${selected === m.id ? 'bg-muted' : 'bg-card'}`} onClick={() => setSelected(m.id)}>
                <span className="flex items-center justify-between gap-2"><strong className="truncate">{m.contactName ?? `Contact ${m.contactId}`}</strong>{badgeFor(m) && <Badge variant="info">{badgeFor(m)}</Badge>}</span>
                <span className="block truncate text-xs text-muted-foreground"><RelativeTime at={m.createdAt} timeZone={settings.data?.timezone} /> · {transcriptLabel(m.transcriptStatus)} · {m.summary || m.notes || 'No text yet'}</span>
              </button>
            </li>
          ))}
        </ul>
        {page && page.total > 0 && <p className="m-0 text-xs text-muted-foreground">{pagingLabel(page)}</p>}
        {page && (offset > 0 || page.hasMore) && (
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>‹ Prev</Button><Button size="sm" variant="outline" disabled={!page.hasMore} onClick={() => setOffset(offset + 50)}>Next ›</Button></div>
        )}
      </div>
      <div className="min-w-0">
        {!open.data && <p className="m-0 text-sm text-muted-foreground">Pick a MOM to read or edit it.</p>}
        {open.data && (
          <>
            <div className="mb-2 flex items-center justify-between"><h3 className="m-0 text-sm font-semibold">{open.data.contactName ?? `Contact ${open.data.contactId}`}</h3><Button size="sm" variant="outline" onClick={() => onOpenContact(open.data!.contactId)}>Open contact</Button></div>
            <MomEditor key={`${open.data.id}-${open.data.updatedAt}`} projectId={project.id} mom={open.data} readOnly={readOnly} onChanged={() => { open.reload(); list.reload(); }} />
          </>
        )}
      </div>
    </div>
  );
}
