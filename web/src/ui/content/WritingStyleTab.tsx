import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { contentApi } from '../../lib/contentApi';
import {
  acceptBody, acceptLabel, actionLabel, AUTO_APPLY_REFUSED, badgeLabel, badgeText, changeDiff, charCounter, DISCARD_TOAST, draftsLine, editProblems, historyWho,
  logRowText, sourceChips, staleMessage,
} from '../../lib/contentRetro';
import type { ChangeEdits } from '../../lib/contentRetro';
import type { AcceptBody, FailedChangeDto, ProposalDto, RetroLogEntryDto, RetroSourceDto, StyleChangeDto, StyleHistoryDto } from '../../lib/contentTypes';
import { READ_ONLY_TITLE } from '../../lib/contentView';
import { useContentStore } from '../../store/contentStore';
import { useLoad } from '../crm/crmHooks';
import { ErrorNote } from '../crm/shared';
import { RelativeTime } from '../design/RelativeTime';
import { VersionedEditor } from './VersionedEditor';

const STYLE_MAX = 50_000;

/** The Writing style tab's count of pending proposals; nothing at 0. */
export function ProposalBadge({ count }: { count: number }) {
  const text = badgeText(count);
  if (!text) return null;
  return <span aria-label={badgeLabel(count)} className="ml-1.5 rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-5 text-primary-foreground">{text}</span>;
}

const chip = 'rounded-full border border-border px-2 py-0.5 text-[11px] font-medium';

function SourceLine({ source, at, draftCount, roundCount, now, onOpenConcept }: { source: RetroSourceDto; at: string; draftCount?: number; roundCount?: number; now?: number; onOpenConcept: (conceptId: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {sourceChips(source).map((label) => <span key={label} className={chip}>{label}</span>)}
      <button type="button" className="text-left font-medium text-foreground underline underline-offset-2 [overflow-wrap:anywhere]" data-wrap onClick={() => onOpenConcept(source.conceptId)}>{source.conceptTitle}</button>
      <span>· <RelativeTime at={at} now={now} />{draftCount !== undefined && roundCount !== undefined && source.kind !== 'imported' && <> · {draftsLine(draftCount, roundCount)}</>}</span>
    </div>
  );
}

const DIFF_TONE = { context: 'text-muted-foreground', removed: 'bg-destructive/10 text-destructive', added: 'bg-success/10 text-success-foreground', note: 'italic text-muted-foreground' };
const DIFF_MARK = { context: ' ', removed: '−', added: '+', note: '' };

/** One change as a diff against the current section text. */
export function ChangeDiff({ content, change }: { content: string; change: StyleChangeDto }) {
  return (
    <div role="group" aria-label={`Diff of change ${change.id + 1}`} className="max-h-[14rem] overflow-auto rounded-card border border-border font-mono text-xs" data-diff>
      {changeDiff(content, change).map((line, i) => (
        <div key={i} className={cn('whitespace-pre-wrap px-2 py-0.5 [overflow-wrap:anywhere]', DIFF_TONE[line.kind])}>{DIFF_MARK[line.kind] && <span aria-hidden="true">{DIFF_MARK[line.kind]} </span>}{line.text}</div>
      ))}
    </div>
  );
}

/** Edit mode: `find` and `text` of each kept change as editable text; section and action stay fixed. */
export function ProposalEditFields({ proposal, edits, disabled, onEdit }: { proposal: ProposalDto; edits: ChangeEdits; disabled: boolean; onEdit: (id: number, patch: { find?: string; text?: string }) => void }) {
  return (
    <ol className="m-0 grid list-none gap-3 p-0">
      {proposal.changes.map((c) => {
        const value = { ...c, ...edits[c.id] };
        const problems = editProblems(value);
        const id = `edit-${proposal.id}-${c.id}`;
        return (
          <li key={c.id} className="grid gap-2">
            <div className="text-sm font-medium">{c.id + 1} · {actionLabel(c)}</div>
            {c.action !== 'add' && (
              <div className="grid gap-1">
                <label htmlFor={`${id}-find`} className="text-xs font-medium">Find (must occur exactly once in {c.section})</label>
                <Textarea id={`${id}-find`} rows={1} value={value.find ?? ''} disabled={disabled} onChange={(e) => onEdit(c.id, { find: e.target.value })} />
                {problems.find && <span className="text-xs text-destructive">{problems.find}</span>}
              </div>
            )}
            {c.action !== 'remove' && (
              <div className="grid gap-1">
                <label htmlFor={`${id}-text`} className="text-xs font-medium">{c.action === 'add' ? `Text to add at the end of ${c.section}` : 'Replace with'}</label>
                <Textarea id={`${id}-text`} rows={2} value={value.text ?? ''} disabled={disabled} onChange={(e) => onEdit(c.id, { text: e.target.value })} />
                <span className={cn('text-xs', problems.text ? 'text-destructive' : 'text-muted-foreground')}>{problems.text ?? charCounter(value.text ?? '')}</span>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export interface ProposalCardProps {
  proposal: ProposalDto;
  /** The writing style as it is now; diffs are drawn against it. */
  styleContent: string;
  stale: FailedChangeDto[] | undefined;
  readOnly: boolean;
  busy: boolean;
  onAccept: (body: AcceptBody) => void;
  onDiscard: () => void;
  onOpenConcept: (conceptId: string) => void;
  /** Starts in edit mode (tests). */
  editing?: boolean;
  now?: number;
}

export function ProposalCard({ proposal, styleContent, stale, readOnly, busy, onAccept, onDiscard, onOpenConcept, editing: startEditing = false, now }: ProposalCardProps) {
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const [editing, setEditing] = useState(startEditing);
  const [edits, setEdits] = useState<ChangeEdits>({});
  const ticked = proposal.changes.length - excluded.size;
  const accept = acceptLabel(ticked, proposal.changes.length);
  const failedIds = new Set(stale?.map((f) => f.id));
  const title = readOnly ? READ_ONLY_TITLE : undefined;
  const toggle = (id: number) => setExcluded((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const editsValid = proposal.changes.every((c) => !Object.keys(editProblems({ ...c, ...edits[c.id] })).length);
  return (
    <article className="grid gap-3 rounded-card border border-border bg-card p-4" aria-label={`Proposal from ${sourceChips(proposal.source)[0]}`} data-proposal={proposal.id}>
      <SourceLine source={proposal.source} at={proposal.at} draftCount={proposal.draftCount} roundCount={proposal.roundCount} now={now} onOpenConcept={onOpenConcept} />
      {proposal.autoApplyError && (
        <div role="status" className="grid gap-1 rounded-card border border-warning/50 bg-warning/15 p-2.5 text-sm"><strong>{AUTO_APPLY_REFUSED}</strong><span className="text-xs">{proposal.autoApplyError}</span></div>
      )}
      <p className="m-0 text-sm">{proposal.summary}</p>
      {stale?.length ? (
        <div role="alert" className="grid gap-1 rounded-card border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
          <strong>The writing style changed since this proposal was made. Nothing was applied.</strong>
          <ul className="m-0 pl-5">{stale.map((f) => <li key={f.id}>{staleMessage(f, proposal.changes.find((c) => c.id === f.id))}</li>)}</ul>
          <span className="text-xs">Leave that change out, edit it, or discard the proposal.</span>
        </div>
      ) : null}
      {editing ? (
        <>
          <ProposalEditFields proposal={proposal} edits={edits} disabled={readOnly} onEdit={(id, patch) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } }))} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={readOnly || busy || !editsValid || ticked === 0} title={title} onClick={() => onAccept(acceptBody(proposal.changes, excluded, edits))}>Apply edited changes</Button>
            <Button type="button" variant="ghost" onClick={() => { setEditing(false); setEdits({}); }}>Cancel</Button>
          </div>
        </>
      ) : (
        <>
          <ol className="m-0 grid list-none gap-3 p-0">
            {proposal.changes.map((c) => {
              const id = `change-${proposal.id}-${c.id}`;
              return (
                <li key={c.id} className={cn('grid gap-1.5', excluded.has(c.id) && 'opacity-60')} data-change={c.id}>
                  <div className="flex items-start gap-2">
                    <input id={id} type="checkbox" className="mt-1" checked={!excluded.has(c.id)} disabled={readOnly} title={title} onChange={() => toggle(c.id)} />
                    <label htmlFor={id} className="grid gap-0.5 text-sm">
                      <span className="font-medium">{actionLabel(c)}{failedIds.has(c.id) && <span className="ml-2 rounded-full bg-destructive/15 px-2 text-[11px] text-destructive">Can't apply</span>}</span>
                      <span className="text-muted-foreground">{c.reason}</span>
                    </label>
                  </div>
                  <ChangeDiff content={styleContent} change={c} />
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={readOnly || busy || accept.disabled} title={title} onClick={() => onAccept(acceptBody(proposal.changes, excluded, null))}>{accept.label}</Button>
            <Button type="button" variant="outline" disabled={readOnly || busy} title={title} onClick={() => setEditing(true)}>Edit</Button>
            <Button type="button" variant="ghost" disabled={readOnly || busy} title={title} onClick={onDiscard}>Discard</Button>
            {!readOnly && accept.hint && <span className="text-xs text-muted-foreground">{accept.hint}</span>}
          </div>
        </>
      )}
    </article>
  );
}

export function RetroLog({ entries, onOpenConcept, now }: { entries: RetroLogEntryDto[]; onOpenConcept: (conceptId: string) => void; now?: number }) {
  return (
    <details className="rounded-card border border-border bg-card px-4 py-3" aria-label="Retro log">
      <summary className="cursor-pointer text-sm font-medium">Retro log ({entries.length})</summary>
      <p className="m-0 mt-2 text-xs text-muted-foreground">Retros that did not produce a proposal, newest first (last 50). Run retro on the finalized text tries again.</p>
      {entries.length ? (
        <ul className="m-0 mt-3 grid list-none p-0">
          {entries.map((e) => (
            <li key={e.id} className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 border-t border-border py-2 text-sm" data-status={e.status}>
              <span aria-hidden="true" className={cn('mt-2 size-2 rounded-full', e.status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground')} />
              <span className="font-medium [overflow-wrap:anywhere]">{logRowText(e)}</span>
              <span className="col-start-2"><SourceLine source={e.source} at={e.at} now={now} onOpenConcept={onOpenConcept} /></span>
            </li>
          ))}
        </ul>
      ) : <p className="m-0 mt-3 text-sm text-muted-foreground">No retros yet.</p>}
    </details>
  );
}

export function StyleHistory({ entries, error }: { entries: StyleHistoryDto[] | null; error: string | null }) {
  return (
    <section className="grid gap-2" aria-label="Change history">
      <h3 className="m-0 text-base font-semibold">Change history</h3>
      <ErrorNote message={error} />
      <table className="w-full border-collapse text-left text-sm">
        <thead><tr className="text-xs text-muted-foreground"><th className="pb-1 font-medium">Who</th><th className="pb-1 font-medium">When</th><th className="pb-1 font-medium">Change</th></tr></thead>
        <tbody>
          {(entries ?? []).map((h) => (
            <tr key={h.id} className="border-t border-border">
              <td className="py-1.5">{historyWho(h.who)}{h.autoApplied && <span className="ml-1.5 whitespace-nowrap rounded-full bg-info/15 px-2 text-[11px] font-semibold text-info-foreground">auto-applied</span>}</td>
              <td><RelativeTime at={h.at} /></td><td>{h.summary}</td>
            </tr>
          ))}
          {entries && !entries.length && <tr><td colSpan={3} className="py-1.5 text-muted-foreground">No changes yet</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

export interface PendingProposalsProps {
  proposals: ProposalDto[];
  styleContent: string;
  staleByProposal: Record<string, FailedChangeDto[]>;
  readOnly: boolean;
  busyId: string | null;
  onAccept: (pid: string, body: AcceptBody) => void;
  onDiscard: (pid: string) => void;
  onOpenConcept: (conceptId: string) => void;
  now?: number;
}

export function PendingProposals({ proposals, styleContent, staleByProposal, readOnly, busyId, onAccept, onDiscard, onOpenConcept, now }: PendingProposalsProps) {
  return (
    <section className="grid gap-2" aria-label="Pending proposals">
      <h3 className="m-0 text-base font-semibold">Pending proposals <span className="text-sm font-normal text-muted-foreground">({proposals.length})</span></h3>
      <p className="m-0 text-sm text-muted-foreground">After you finalize a script, post text or article, a retro compares the agent's drafts with your final text and suggests style changes. Nothing changes until you accept.</p>
      {proposals.length ? (
        <div className="grid gap-3">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} styleContent={styleContent} stale={staleByProposal[p.id]} readOnly={readOnly} busy={busyId === p.id}
              onAccept={(body) => onAccept(p.id, body)} onDiscard={() => onDiscard(p.id)} onOpenConcept={onOpenConcept} now={now} />
          ))}
        </div>
      ) : <p className="m-0 rounded-card border border-dashed border-border p-5 text-center text-sm text-muted-foreground">No pending proposals. The next one appears after you finalize a script, post text or article.</p>}
    </section>
  );
}

/** Pending retro proposals first (the tab badge leads here), then the document with its version rule, the retro log and the change history. */
export function WritingStyleTab({ projectId, readOnly, onOpenConcept }: { projectId: string; readOnly: boolean; onOpenConcept: (conceptId: string) => void }) {
  const loaded = useContentStore((s) => s.proposalsByProject[projectId]);
  const proposals = loaded ?? [];
  const log = useContentStore((s) => s.retroLogByProject[projectId]) ?? [];
  const stale = useContentStore((s) => s.staleByProposal);
  const styleRev = useContentStore((s) => s.styleRevByProject[projectId] ?? 0);
  const { loadProposals, loadRetroLog, acceptProposal, discardProposal } = useContentStore.getState();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const style = useLoad(() => contentApi.style(projectId), [projectId, styleRev, loaded]);
  const history = useLoad(() => contentApi.styleHistory(projectId), [projectId, styleRev]);
  useEffect(() => { void loadProposals(projectId); void loadRetroLog(projectId); }, [projectId, loadProposals, loadRetroLog]);
  const load = useCallback(() => contentApi.style(projectId), [projectId]);
  const save = useCallback((content: string, version: string) => contentApi.saveStyle(projectId, { content, version }), [projectId]);
  const act = async (pid: string, work: () => Promise<{ ok: boolean; error?: string }>, done?: () => void) => {
    setBusyId(pid);
    const result = await work();
    setBusyId(null);
    setError(result.ok ? null : result.error ?? null);
    if (result.ok) done?.();
  };
  return (
    <div className="grid gap-6">
      <ErrorNote message={error} />
      <PendingProposals
        proposals={proposals} styleContent={style.data?.content ?? ''} staleByProposal={stale} readOnly={readOnly} busyId={busyId} onOpenConcept={onOpenConcept}
        onAccept={(pid, body) => void act(pid, () => acceptProposal(projectId, pid, body))}
        onDiscard={(pid) => void act(pid, () => discardProposal(projectId, pid), () => toast(DISCARD_TOAST))}
      />
      <RetroLog entries={log} onOpenConcept={onOpenConcept} />
      <section className="grid gap-2" aria-label="Writing style">
        <h3 className="m-0 text-base font-semibold">Writing style</h3>
        <p className="m-0 text-sm text-muted-foreground">A General section and one section per platform. Agents read this before they write.</p>
        <VersionedEditor label="Writing style (Markdown)" max={STYLE_MAX} readOnly={readOnly} load={load} save={save} reloadKey={styleRev} onSaved={() => { history.reload(); style.reload(); }} />
      </section>
      <StyleHistory entries={history.data?.entries ?? null} error={history.error} />
    </div>
  );
}
