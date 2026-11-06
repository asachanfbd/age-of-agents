import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { conflictView, type ConflictRow, type TaskConflict } from '../../lib/taskConflicts';
import { useWorldStore } from '../../store/worldStore';

/**
 * A refused start or session action, in place: what the limit is, what is using it, and a way to open
 * each task. Announced when it appears (`role="alert"`); the list follows the live tasks, so a task
 * that finishes drops out and the person can retry.
 */
export function TaskConflictAlert({ conflict, onOpen, className }: { conflict: TaskConflict; onOpen?: (target: ConflictRow['target']) => void; className?: string }) {
  const tasksById = useWorldStore((s) => s.tasksById);
  const view = conflictView(conflict, tasksById);
  return (
    <Alert variant="destructive" role="alert" className={cn('min-w-0', className)}>
      <AlertTitle>{view.title}</AlertTitle>
      <AlertDescription className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-2 text-foreground">
        <p className="break-words">{view.body}</p>
        {view.retryable && <p className="font-medium">A slot is free now. You can start again.</p>}
        {view.rows.length > 0 && (
          <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1" aria-label="Tasks using the limit">
            {view.rows.map((row) => (
              <li key={row.key} className="flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0 truncate" title={`${row.label} · ${row.stateLabel}`}>{row.label} <span className="text-muted-foreground">· {row.stateLabel}</span></span>
                {onOpen && <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => onOpen(row.target)} aria-label={`Open ${row.label}`}>Open</Button>}
              </li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}
