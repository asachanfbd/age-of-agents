import { useMemo, useState } from 'react';
import { Ellipsis, Mail, Phone, Search, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { crmApi } from '../../lib/crmApi';
import { attachedRowState, emailHref, filterCustomers, GRID_VIEWS, phoneHref, profileCompleteness, roleLine, SEGMENT_CHIPS, sinceAt } from '../../lib/crmCustomers';
import type { CustomerView, SegmentChip } from '../../lib/crmCustomers';
import { contactLabel } from '../../lib/crmBoard';
import { initials } from '../../lib/people';
import { IconButton } from '../design/Buttons';
import { ScoreBar } from '../design/Cards';
import { DataTable, TwoLine } from '../design/DataTable';
import { FilterChips, SegmentedControl } from '../design/Segmented';
import { pageNav, pagingLabel } from '../../lib/crmProspects';
import { crmControlsDisabled, disabledTitle } from '../../lib/crmWorkspace';
import type { CustomerDto } from '../../lib/crmTypes';
import { ErrorNote } from './shared';
import { WorkLog } from './WorkLog';
import { RelativeTime } from '../design/RelativeTime';
import { ATTACH_HINT } from '../../lib/crmWork';
import { errorText, useLoad } from './crmHooks';
import type { CrmTabProps } from './types';

export function AttachedRow({ projectId, customer, disabled, readOnly, onChanged, onError }: { projectId: string; customer: CustomerDto; disabled: boolean; readOnly: boolean; onChanged: () => void; onError: (m: string) => void }) {
  const options = useLoad(() => crmApi.buildings(projectId), [projectId]);
  const settings = useLoad(() => crmApi.settings(projectId), [projectId]);
  const [pick, setPick] = useState('');
  const attachable = (options.data?.buildings ?? []).filter((b) => !customer.buildings.some((a) => a.buildingId === b.id));
  const act = async (work: () => Promise<unknown>) => { try { await work(); onChanged(); } catch (e) { onError(errorText(e)); } };
  return (
    <div className="grid gap-1 text-sm">
      {customer.buildings.length === 0 && <span className="text-muted-foreground">No Buildings attached</span>}
      {customer.buildings.map((b) => {
        const row = attachedRowState(b.peek);
        return (
          <div key={b.buildingId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted p-2">
            <span className="min-w-0 truncate">{row.line}</span>
            <span className="flex items-center gap-1">
              {row.state === 'unavailable' && <Badge variant="warning">Unavailable</Badge>}
              {row.retry && <Button size="sm" variant="outline" onClick={onChanged}>Retry</Button>}
              <Button size="sm" variant="ghost" disabled={disabled} title={disabledTitle(readOnly)} onClick={() => void act(() => crmApi.detachBuilding(projectId, customer.id, b.buildingId))}>Detach</Button>
            </span>
            <WorkLog building={b} timeZone={settings.data?.timezone} />
          </div>
        );
      })}
      <div className="flex gap-2">
        <NativeSelect aria-label="Attach a Building" value={pick} disabled={disabled} onChange={(e) => setPick(e.target.value)}>
          <option value="">Attach a Building…</option>
          {attachable.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.typeId})</option>)}
        </NativeSelect>
        <Button size="sm" disabled={disabled || !pick} onClick={() => void act(async () => { await crmApi.attachBuilding(projectId, customer.id, pick); setPick(''); })}>Attach</Button>
      </div>
      <p className="m-0 text-xs text-muted-foreground">{ATTACH_HINT}</p>
    </div>
  );
}

function CustomerSince({ customer, timeZone }: { customer: CustomerDto; timeZone?: string }) {
  const at = sinceAt(customer);
  return at === null ? <>No date</> : <RelativeTime at={at} timeZone={timeZone} />;
}

function ContactButtons({ customer }: { customer: CustomerDto }) {
  const email = emailHref(customer);
  const phone = phoneHref(customer);
  return (
    <span className="flex gap-2">
      <IconButton aria-label={`Email ${contactLabel(customer)}`} disabled={!email} onClick={() => { if (email) window.location.href = email; }}><Mail /></IconButton>
      <IconButton aria-label={`Call ${contactLabel(customer)}`} disabled={!phone} onClick={() => { if (phone) window.location.href = phone; }}><Phone /></IconButton>
    </span>
  );
}

export function PersonCard({ customer, projectId, timeZone, disabled, readOnly, starred, onStar, onOpen, onChanged, onError }: {
  customer: CustomerDto; projectId: string; timeZone?: string; disabled: boolean; readOnly: boolean; starred: boolean; onStar: () => void; onOpen: () => void; onChanged: () => void; onError: (m: string) => void;
}) {
  const name = contactLabel(customer);
  return (
    <article className="grid gap-4 rounded-card bg-card p-5 shadow-soft" aria-label={`Customer ${name}`}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-full bg-stage-green text-lg font-semibold text-stage-green-foreground">{initials(customer.name ?? name)}</span>
        <div className="min-w-0 flex-1">
          <button type="button" className="m-0 block max-w-full truncate bg-transparent p-0 text-left text-base font-semibold hover:underline" onClick={onOpen}>{name}</button>
          <p className="m-0 truncate text-sm text-muted-foreground">{roleLine(customer)}</p>
        </div>
        <IconButton aria-label={starred ? `Unstar ${name}` : `Star ${name}`} aria-pressed={starred} tone="plain" onClick={onStar}><Star className={starred ? 'fill-current' : ''} /></IconButton>
      </div>
      <dl className="m-0 grid grid-cols-2 gap-3 rounded-2xl bg-muted p-3 text-sm">
        <div><dt className="text-xs text-muted-foreground">Buildings</dt><dd className="m-0 font-semibold tabular-nums">{customer.buildings.length}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Customer since</dt><dd className="m-0 font-semibold"><CustomerSince customer={customer} timeZone={timeZone} /></dd></div>
      </dl>
      <div className="grid gap-1"><span className="text-xs text-muted-foreground">Profile completeness</span><ScoreBar value={profileCompleteness(customer)} label={`Profile completeness of ${name}`} /></div>
      <div className="flex items-center justify-between gap-2">
        <Badge variant="success">Customer</Badge>
        <ContactButtons customer={customer} />
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer rounded-control text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">Buildings ({customer.buildings.length})</summary>
        <div className="mt-2"><AttachedRow projectId={projectId} customer={customer} disabled={disabled} readOnly={readOnly} onChanged={onChanged} onError={onError} /></div>
      </details>
    </article>
  );
}

/** Customers as a directory of person cards (or a table), with the other Buildings each uses; an unavailable or unreadable Building never hides the rest. */
export function CustomersTab({ project, readOnly, onOpenContact, onChanged }: CrmTabProps) {
  const [offset, setOffset] = useState(0);
  const list = useLoad(() => crmApi.customers(project.id, { limit: 50, offset }), [project.id, offset]);
  const settings = useLoad(() => crmApi.settings(project.id), [project.id]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<CustomerView>('grid');
  const [chip, setChip] = useState<SegmentChip>('all');
  const [search, setSearch] = useState('');
  const [starred, setStarred] = useState<ReadonlySet<number>>(new Set());
  const disabled = crmControlsDisabled(readOnly);
  const page = list.data;
  const nav = page ? pageNav(page) : null;
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return filterCustomers(page?.rows ?? [], chip).filter((c) => !needle || `${contactLabel(c)} ${c.company ?? ''}`.toLowerCase().includes(needle));
  }, [page, chip, search]);
  const toggleStar = (id: number) => setStarred((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <div className="grid gap-4" aria-label="Customers">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl label="Layout" value={view} options={GRID_VIEWS} onChange={setView} />
        <div className="w-64"><Input aria-label="Search customers" icon={<Search />} placeholder="Search name or company" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <FilterChips label="Segment" value={chip} options={SEGMENT_CHIPS} onChange={setChip} />
      </div>
      <ErrorNote message={error ?? list.error} />
      {list.loading && !page && <p className="m-0 text-sm text-muted-foreground">Loading customers…</p>}
      {page && page.rows.length === 0 && <p className="m-0 text-sm text-muted-foreground">No customers yet. Mark a prospect as a customer to see it here.</p>}
      {page && page.rows.length > 0 && rows.length === 0 && <p className="m-0 text-sm text-muted-foreground">No customers match.</p>}
      {view === 'grid' ? (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((c) => (
            <PersonCard key={c.id} customer={c} projectId={project.id} disabled={disabled} readOnly={readOnly} starred={starred.has(c.id)} onStar={() => toggleStar(c.id)} onOpen={() => onOpenContact(c.id)} timeZone={settings.data?.timezone} onChanged={() => { list.reload(); onChanged(); }} onError={setError} />
          ))}
        </div>
      ) : (
        <DataTable
          label="Customers table"
          rows={rows}
          rowKey={(c) => c.id}
          onRowClick={(c) => onOpenContact(c.id)}
          rowMenu={(c) => (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><IconButton aria-label={`Actions for ${contactLabel(c)}`} tone="plain"><Ellipsis /></IconButton></DropdownMenuTrigger>
              <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => onOpenContact(c.id)}>Open contact</DropdownMenuItem></DropdownMenuContent>
            </DropdownMenu>
          )}
          columns={[
            { key: 'name', header: 'Name', sortValue: (c) => contactLabel(c).toLowerCase(), render: (c) => <TwoLine main={contactLabel(c)} sub={roleLine(c)} /> },
            { key: 'buildings', header: 'Buildings', sortValue: (c) => c.buildings.length, render: (c) => <span className="tabular-nums">{c.buildings.length}</span> },
            { key: 'since', header: 'Customer since', sortValue: (c) => c.customerAt ?? c.createdAt, render: (c) => <CustomerSince customer={c} timeZone={settings.data?.timezone} /> },
          ]}
        />
      )}
      {page && page.total > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{pagingLabel(page)}</span>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!nav?.canPrev} onClick={() => nav && setOffset(nav.prevOffset)}>Prev</Button>
            <Button size="sm" variant="outline" disabled={!nav?.canNext} onClick={() => nav && setOffset(nav.nextOffset)}>Next</Button>
          </span>
        </div>
      )}
    </div>
  );
}
