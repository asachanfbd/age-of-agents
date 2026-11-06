import { useEffect, useMemo, useState } from 'react';
import { Ellipsis, Plus, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { crmApi } from '../../lib/crmApi';
import { isMessageType } from '../../lib/crmCalendar';
import { CHANNEL_OPTIONS, validateHandForm } from '../../lib/crmImport';
import { initialQuery, pageNav, pagingLabel, rowStatuses, withFilter, withOffset, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../../lib/crmProspects';
import type { ListQuery } from '../../lib/crmProspects';
import { crmControlsDisabled, disabledTitle } from '../../lib/crmWorkspace';
import type { ChannelType, ContactDto, FollowupDto } from '../../lib/crmTypes';
import { useCrmStore } from '../../store/crmStore';
import { BOARD_STAGES, contactLabel, stageAccent } from '../../lib/crmBoard';
import { IconButton } from '../design/Buttons';
import { DataTable, StatusDot, TwoLine } from '../design/DataTable';
import { FilterChips, SegmentedControl } from '../design/Segmented';
import { ChannelIcon } from './channelIcons';
import { ProspectBoard } from './ProspectBoard';
import { ReachoutPopup } from './ReachoutPopup';
import { ErrorNote, StatusText } from './shared';
import { errorText, useLoad } from './crmHooks';
import type { CrmTabProps } from './types';

const FLAGS = [{ value: 'pending', label: 'Pending reachout' }, { value: 'approval', label: 'Awaiting approval' }, { value: 'noResponse', label: 'No response' }, { value: 'dnc', label: 'Do not contact' }, { value: 'invalid', label: 'Invalid channel' }];

function FilterSelect({ label, value, options, onChange }: { label: string; value: string | undefined; options: Array<{ value: string; label: string }>; onChange: (v: string | undefined) => void }) {
  return (
    <NativeSelect aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{label}: all</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </NativeSelect>
  );
}

function AddByHand({ projectId, onClose, onAdded }: { projectId: string; onClose: () => void; onAdded: (c: ContactDto) => void }) {
  const [form, setForm] = useState({ name: '', company: '', channel: 'email' as ChannelType, handle: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const problem = validateHandForm(form);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try { onAdded(await crmApi.createContact(projectId, { name: form.name, company: form.company, channels: [{ type: form.channel, handle: form.handle }] })); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md" aria-label="Add a contact by hand">
        <DialogHeader><DialogTitle>Add by hand</DialogTitle><DialogDescription>A quick form: one channel is enough.</DialogDescription></DialogHeader>
        <ErrorNote message={error} />
        <div className="grid gap-2 text-sm">
          <Input aria-label="Name" placeholder="Name (optional)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input aria-label="Company" placeholder="Company (optional)" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          <div className="flex gap-2">
            <NativeSelect aria-label="Channel type" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as ChannelType })}>{CHANNEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</NativeSelect>
            <Input aria-label="Handle" placeholder="Email, number or profile" value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value })} />
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>Add</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Mode = 'board' | 'list';
const MODES = [{ value: 'board', label: 'Board' }, { value: 'list', label: 'List' }] as const;
const STAGE_CHIPS = [{ value: 'all', label: 'All' }, ...BOARD_STAGES.map((s) => ({ value: s, label: s }))];

function RowMenu({ contact, onOpen }: { contact: ContactDto; onOpen: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><IconButton aria-label={`Actions for ${contactLabel(contact)}`} tone="plain"><Ellipsis /></IconButton></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuItem onSelect={onOpen}>Open contact</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Prospects: a Board (a kanban of the five stages, the default) or a server-paged List; both share the search and filters; a card or row opens the contact. */
export function ProspectsTab({ project, readOnly, onOpenContact, onOpenContactAction, onChanged }: CrmTabProps) {
  const [mode, setMode] = useState<Mode>('board');
  const [query, setQuery] = useState<ListQuery>({ ...initialQuery(), segment: 'prospect' });
  const [searchDraft, setSearchDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [popup, setPopup] = useState<FollowupDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [boardReload, setBoardReload] = useState(0);
  const view = useCrmStore((s) => s.contactsByProject[project.id]);
  const loadContacts = useCrmStore((s) => s.loadContacts);
  const batches = useLoad(() => crmApi.batches(project.id), [project.id]);
  const settings = useLoad(() => crmApi.settings(project.id), [project.id]);
  const disabled = crmControlsDisabled(readOnly);

  useEffect(() => { if (mode === 'list') void loadContacts(project.id, query); }, [mode, project.id, query, loadContacts]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery((q) => (q.search === searchDraft ? q : withFilter(q, { search: searchDraft }))), 300);
    return () => clearTimeout(timer);
  }, [searchDraft]);

  const boardQuery = useMemo(() => ({ ...query, stage: undefined, offset: 0 }), [query]);
  const page = view?.page ?? null;
  const nav = page ? pageNav(page) : null;
  const refresh = () => { onChanged(); setBoardReload((n) => n + 1); if (mode === 'list') void loadContacts(project.id, query); };
  const openPending = async (c: ContactDto) => {
    setError(null);
    try {
      const list = await crmApi.followups(project.id, { contactId: c.id, state: 'pending', limit: 50 });
      const message = list.rows.find((row) => isMessageType(row.type));
      if (message) setPopup(message); else onOpenContact(c.id);
    } catch (e) { setError(errorText(e)); }
  };

  return (
    <div className="grid gap-4" aria-label="Prospects">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl label="View" value={mode} options={MODES} onChange={setMode} />
        <div className="w-64"><Input aria-label="Search" icon={<Search />} placeholder="Search name, company or handle" value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} /></div>
        <FilterSelect label="Channel" value={query.channel} options={CHANNEL_OPTIONS} onChange={(channel) => setQuery((q) => withFilter(q, { channel }))} />
        <FilterSelect label="Batch" value={query.batch} options={(batches.data?.batches ?? []).map((b) => ({ value: String(b.id), label: b.name }))} onChange={(batch) => setQuery((q) => withFilter(q, { batch }))} />
        <FilterSelect label="Flag" value={query.flag} options={FLAGS} onChange={(flag) => setQuery((q) => withFilter(q, { flag }))} />
        <Button className="ml-auto" disabled={disabled} title={disabledTitle(readOnly)} onClick={() => setAdding(true)}><Plus />Add by hand</Button>
      </div>
      {mode === 'list' && <FilterChips label="Stage" value={query.stage ?? 'all'} options={STAGE_CHIPS} onChange={(stage) => setQuery((q) => withFilter(q, { stage: stage === 'all' ? undefined : stage }))} />}
      <ErrorNote message={error ?? (mode === 'list' ? view?.error ?? null : null)} />
      {mode === 'board' ? (
        <ProspectBoard
          projectId={project.id} query={boardQuery} readOnly={readOnly} reloadKey={boardReload} timeZone={settings.data?.timezone}
          onOpenContact={onOpenContact} onOpenPending={(c) => void openPending(c)} onZoneDrop={onOpenContactAction}
        />
      ) : (
        <>
          <DataTable
            label="Prospects list"
            rows={page?.rows ?? []}
            rowKey={(c) => c.id}
            onRowClick={(c) => onOpenContact(c.id)}
            rowMenu={(c) => <RowMenu contact={c} onOpen={() => onOpenContact(c.id)} />}
            summary={page ? pagingLabel(page) : view?.loading ? 'Loading contacts…' : undefined}
            columns={[
              { key: 'name', header: 'Name', sortValue: (c) => contactLabel(c).toLowerCase(), render: (c) => <TwoLine main={contactLabel(c)} sub={c.company ?? undefined} /> },
              { key: 'stage', header: 'Stage', sortValue: (c) => BOARD_STAGES.indexOf(c.stage ?? 'New'), render: (c) => <StatusDot accent={stageAccent(c.stage)} label={c.stage ?? '—'} /> },
              { key: 'channels', header: 'Channels', render: (c) => <span className="flex items-center gap-1.5">{[...new Set(c.channels.map((ch) => ch.type))].map((type) => <ChannelIcon key={type} type={type} />)}</span> },
              {
                key: 'status', header: 'Status',
                render: (c) => (
                  <span className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    {rowStatuses(c).map((s) => (
                      s.kind === 'pending_reachout'
                        ? <button key={s.kind} type="button" className="rounded-control bg-warning/20 px-2.5 py-0.5 text-xs font-medium text-warning-foreground hover:underline" onClick={() => void openPending(c)}>{s.label}</button>
                        : <Badge key={s.kind} variant={s.kind === 'dnc' ? 'soft-destructive' : 'warning'}><StatusText status={s} timeZone={settings.data?.timezone} /></Badge>
                    ))}
                  </span>
                ),
              },
            ]}
          />
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>page size {PAGE_SIZE_DEFAULT} (max {PAGE_SIZE_MAX})</span>
            <span className="flex gap-2">
              <Button size="sm" variant="outline" disabled={!nav?.canPrev} onClick={() => nav && setQuery((q) => withOffset(q, nav.prevOffset))}>Prev</Button>
              <Button size="sm" variant="outline" disabled={!nav?.canNext} onClick={() => nav && setQuery((q) => withOffset(q, nav.nextOffset))}>Next</Button>
            </span>
          </div>
        </>
      )}
      {adding && <AddByHand projectId={project.id} onClose={() => setAdding(false)} onAdded={(c) => { setAdding(false); refresh(); onOpenContact(c.id); }} />}
      {popup && settings.data && <ReachoutPopup projectId={project.id} item={popup} retry={settings.data.cadence} timezone={settings.data.timezone} readOnly={readOnly} onClose={() => setPopup(null)} onDone={() => { setPopup(null); refresh(); }} />}
    </div>
  );
}
