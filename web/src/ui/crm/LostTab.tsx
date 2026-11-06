import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { contactLabel } from '../../lib/crmBoard';
import { Section } from '../design/Header';
import { DataTable, TwoLine } from '../design/DataTable';
import { crmApi } from '../../lib/crmApi';
import { LOST_SECTIONS, REOPEN_STAGES, reopenLabel, reopenStageParam } from '../../lib/crmCustomers';
import { pageNav, pagingLabel } from '../../lib/crmProspects';
import { crmControlsDisabled, disabledTitle } from '../../lib/crmWorkspace';
import type { ContactDto, PageDto, Stage } from '../../lib/crmTypes';
import { ErrorNote } from './shared';
import { errorText, useLoad } from './crmHooks';
import { RelativeTime } from '../design/RelativeTime';
import type { CrmTabProps } from './types';

function ReopenControl({ contact, disabled, readOnly, onReopen }: { contact: ContactDto; disabled: boolean; readOnly: boolean; onReopen: (c: ContactDto, stage: string) => void }) {
  const [stage, setStage] = useState('New');
  return (
    <span className="flex items-center gap-1">
      {contact.segment === 'lost_prospect' && (
        <NativeSelect aria-label="Stage to reopen at" value={stage} disabled={disabled} onChange={(e) => setStage(e.target.value)}>
          {REOPEN_STAGES.map((s) => <option key={s}>{s}</option>)}
        </NativeSelect>
      )}
      <Button size="sm" variant="outline" disabled={disabled} title={disabledTitle(readOnly)} onClick={() => onReopen(contact, stage)}>{reopenLabel(contact.segment, stage)}</Button>
    </span>
  );
}

function LostSection({ title, page, timezone, disabled, readOnly, onReopen, onOpen, onPage }: {
  title: string; page: PageDto<ContactDto> | undefined; timezone: string | undefined; disabled: boolean; readOnly: boolean; onReopen: (c: ContactDto, stage: string) => void; onOpen: (id: number) => void; onPage: (offset: number) => void;
}) {
  const nav = page ? pageNav(page) : null;
  return (
    <Section title={<>{title} {page ? <span className="font-normal text-muted-foreground">({page.total.toLocaleString('en-US')})</span> : null}</>}>
      {page && page.rows.length === 0 && <p className="m-0 text-sm text-muted-foreground">Nothing here.</p>}
      {page && page.rows.length > 0 && (
        <DataTable
          label={title}
          rows={page.rows}
          rowKey={(c) => c.id}
          onRowClick={(c) => onOpen(c.id)}
          columns={[
            { key: 'name', header: 'Contact', sortValue: (c) => contactLabel(c).toLowerCase(), render: (c) => <TwoLine main={contactLabel(c)} sub={c.company ?? undefined} /> },
            { key: 'reason', header: 'Reason', sortValue: (c) => c.lostAt, render: (c) => <TwoLine main={c.lostReason ?? 'No reason'} sub={c.lostAt ? <RelativeTime at={c.lostAt} timeZone={timezone} /> : undefined} /> },
            { key: 'reopen', header: '', render: (c) => <span onClick={(e) => e.stopPropagation()}><ReopenControl contact={c} disabled={disabled} readOnly={readOnly} onReopen={onReopen} /></span> },
          ]}
        />
      )}
      {page && page.total > 0 && (
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>{pagingLabel(page)}</span>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!nav?.canPrev} onClick={() => nav && onPage(nav.prevOffset)}>Prev</Button>
            <Button size="sm" variant="outline" disabled={!nav?.canNext} onClick={() => nav && onPage(nav.nextOffset)}>Next</Button>
          </span>
        </div>
      )}
    </Section>
  );
}

/** Lost prospects and lost customers, each with its reason, date and Reopen. */
export function LostTab({ project, readOnly, onOpenContact, onChanged }: CrmTabProps) {
  const [offsets, setOffsets] = useState({ prospects: 0, customers: 0 });
  const prospects = useLoad(() => crmApi.lost(project.id, { limit: 50, offset: offsets.prospects }), [project.id, offsets.prospects]);
  const customers = useLoad(() => crmApi.lost(project.id, { limit: 50, offset: offsets.customers }), [project.id, offsets.customers]);
  const settings = useLoad(() => crmApi.settings(project.id), [project.id]);
  const [error, setError] = useState<string | null>(null);
  const disabled = crmControlsDisabled(readOnly);
  const reopen = async (c: ContactDto, stage: string) => { setError(null); try { await crmApi.reopen(project.id, c.id, reopenStageParam(c.segment, stage) as Stage | undefined); prospects.reload(); customers.reload(); onChanged(); } catch (e) { setError(errorText(e)); } };
  return (
    <div className="grid gap-4" aria-label="Lost">
      <ErrorNote message={error ?? prospects.error ?? customers.error} />
      <LostSection title={LOST_SECTIONS[0].title} page={prospects.data?.prospects} timezone={settings.data?.timezone} disabled={disabled} readOnly={readOnly} onReopen={(c, stage) => void reopen(c, stage)} onOpen={onOpenContact} onPage={(o) => setOffsets((s) => ({ ...s, prospects: o }))} />
      <LostSection title={LOST_SECTIONS[1].title} page={customers.data?.customers} timezone={settings.data?.timezone} disabled={disabled} readOnly={readOnly} onReopen={(c, stage) => void reopen(c, stage)} onOpen={onOpenContact} onPage={(o) => setOffsets((s) => ({ ...s, customers: o }))} />
    </div>
  );
}
