import { useState } from 'react';
import { ChevronDown, Download, MailCheck, Send, UserCheck, UserPlus } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';
import { crmApi } from '../../lib/crmApi';
import { deltaBadge } from '../../lib/kpi';
import { beforeFirstText, BREAKDOWN_SERIES, breakdownGroups, compare, EXPORT_TABLES, METRIC_ROWS, metricText, NO_DATA, PERIOD_OPTIONS, periodGroups, periodHeading, periodSeries } from '../../lib/crmReports';
import type { BreakdownRowDto } from '../../lib/crmTypes';
import { BarChart, LineChart } from '../design/Charts';
import { DataTable } from '../design/DataTable';
import { KpiStat, Section } from '../design/Header';
import { SegmentedControl } from '../design/Segmented';
import { ErrorNote } from './shared';
import { useLoad } from './crmHooks';
import type { CrmTabProps } from './types';

function Breakdown({ title, rows }: { title: string; rows: BreakdownRowDto[] }) {
  return (
    <Section title={title}>
      {rows.length === 0 ? <p className="m-0 text-sm text-muted-foreground">{NO_DATA}</p> : <BarChart label={title} groups={breakdownGroups(rows)} series={BREAKDOWN_SERIES} />}
    </Section>
  );
}

const TILES = [
  { key: 'prospectsAdded', label: 'Prospects added', icon: <UserPlus /> }, { key: 'reachoutsSent', label: 'Reachouts sent', icon: <Send /> },
  { key: 'followupsSent', label: 'Followups sent', icon: <MailCheck /> }, { key: 'newCustomers', label: 'New customers', icon: <UserCheck /> },
] as const;

/** Day, week or month in the Building's timezone against the previous period; a metric with no events reads "no data", never 0. */
export function ReportsTab({ project }: CrmTabProps) {
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('week');
  const [date, setDate] = useState('');
  const [batch, setBatch] = useState('');
  const report = useLoad(() => crmApi.report(project.id, { period, date: date || undefined, batch: batch || undefined }), [project.id, period, date, batch]);
  const batches = useLoad(() => crmApi.batches(project.id), [project.id]);
  const r = report.data;
  const exportHref = (table: string) => crmApi.reportExportUrl(project.id, { period, date: date || undefined, batch: batch || undefined, table });
  const note = r ? beforeFirstText(r) : null;

  return (
    <div className="grid gap-4" aria-label="Reports">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl label="Period" value={period} options={PERIOD_OPTIONS} onChange={setPeriod} />
        <Input aria-label="Date in the period" type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />
        <NativeSelect aria-label="Batch" value={batch} onChange={(e) => setBatch(e.target.value)}>
          <option value="">All batches</option>{(batches.data?.batches ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </NativeSelect>
        <DropdownMenu>
          <DropdownMenuTrigger className={cn(buttonVariants(), 'ml-auto')}><Download />Export CSV<ChevronDown /></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {EXPORT_TABLES.map((t) => <DropdownMenuItem key={t.value} asChild><a href={exportHref(t.value)} download>Export CSV: {t.label}</a></DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ErrorNote message={report.error} />
      {note && <p className="m-0 text-sm text-warning-foreground" role="status">{note}</p>}
      {r && (
        <>
          <div className="flex flex-wrap gap-x-8 gap-y-3 rounded-card bg-card p-6 shadow-soft" aria-label="Period figures">
            {TILES.map((tile) => (
              <KpiStat key={tile.key} icon={tile.icon} label={tile.label} value={metricText(r.period.metrics[tile.key])} delta={deltaBadge(r.period.metrics[tile.key], r.previous.metrics[tile.key])} />
            ))}
          </div>
          <Section title={periodHeading(r.period, r.previous)}>
            <LineChart label={`${r.period.label} compared with ${r.previous.label}`} groups={periodGroups(r)} series={periodSeries(r)} />
          </Section>
          <Section title="Comparison table">
            <DataTable
              label="Comparison table"
              rows={METRIC_ROWS}
              rowKey={(row) => row.key}
              columns={[
                { key: 'metric', header: 'Metric', render: (row) => row.label },
                { key: 'current', header: r.period.label, render: (row) => <span className={compare(r.period.metrics[row.key], r.previous.metrics[row.key]).current === NO_DATA ? 'text-muted-foreground' : 'tabular-nums'}>{compare(r.period.metrics[row.key], r.previous.metrics[row.key]).current}</span> },
                { key: 'previous', header: r.previous.label, render: (row) => <span className={compare(r.period.metrics[row.key], r.previous.metrics[row.key]).previous === NO_DATA ? 'text-muted-foreground' : 'tabular-nums'}>{compare(r.period.metrics[row.key], r.previous.metrics[row.key]).previous}</span> },
                { key: 'change', header: 'Change', render: (row) => compare(r.period.metrics[row.key], r.previous.metrics[row.key]).change ?? '—' },
              ]}
            />
          </Section>
          <div className="grid gap-4 lg:grid-cols-2"><Breakdown title="By channel" rows={r.byChannel} /><Breakdown title="By batch or source" rows={r.bySource} /></div>
        </>
      )}
    </div>
  );
}
