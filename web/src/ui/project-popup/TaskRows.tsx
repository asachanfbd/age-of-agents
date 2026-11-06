import { Archive, ArchiveRestore, Clock, ExternalLink, Play, Timer, Trash2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PLANNING_LIVE_DOT, PLANNING_LIVE_TITLE, spentLabel } from '../../lib/projectTasks';
import type { PlanningRow } from '../../lib/projectTasks';
import { formatRelativeTime, formatTokenCount } from '../../lib/sessionTiming';
import { MetaTag, TaskRow, WorkerTag } from './TaskRow';
import { RelativeTime } from '../design/RelativeTime';

/** A quiet icon-only button — a planning row's archive and delete controls. */
function IconAction({ icon: Icon, label, onClick, disabled, className }: { icon: typeof Play; label: string; onClick?: () => void; disabled?: boolean; className?: string }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" className={className} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <Icon aria-hidden="true" />
    </Button>
  );
}

/** Planning sessions are ongoing conversations: open, archive/restore, or delete (asked first by the panel) — archiving and deleting only once idle. */
export function PlanningRowView({
  row,
  workerLabel,
  archivedView,
  now,
  onOpen,
  onArchive,
  onDelete,
}: {
  row: PlanningRow;
  workerLabel: string;
  archivedView: boolean;
  now: Date;
  onOpen: (taskId: string) => void;
  onArchive: (taskId: string) => void;
  onDelete: (taskId: string) => void;
}) {
  const liveDot = PLANNING_LIVE_DOT[row.live];
  const liveTitle = PLANNING_LIVE_TITLE[row.live];
  return (
    <TaskRow
      attention={row.attention}
      lead={
        <span className="mt-1 flex size-4 shrink-0 items-center justify-center" title={liveTitle}>
          <span className={`size-2 rounded-full ${liveDot}`} />
        </span>
      }
      title={row.title}
      summary={[workerLabel, `${formatTokenCount(row.metrics.tokens)} tokens`, `Started ${formatRelativeTime(row.metrics.startedAt, now)}`, spentLabel(row.metrics)]}
      description={row.description}
      tags={
        <>
          <WorkerTag label={workerLabel} />
          <MetaTag icon={Zap}>{formatTokenCount(row.metrics.tokens)} tokens</MetaTag>
          <MetaTag icon={Clock}>Started <RelativeTime at={row.metrics.startedAt} now={now.getTime()} /></MetaTag>
          <MetaTag icon={Timer}>{spentLabel(row.metrics)}</MetaTag>
        </>
      }
      actions={
        <>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpen(row.id)}><ExternalLink /> Open</Button>
          <IconAction icon={archivedView ? ArchiveRestore : Archive} label={archivedView ? 'Restore' : 'Archive'} disabled={!row.canArchive} onClick={() => onArchive(row.id)} />
          <IconAction icon={Trash2} label="Delete" disabled={!row.canArchive} onClick={() => onDelete(row.id)} className="hover:text-destructive" />
        </>
      }
    />
  );
}
