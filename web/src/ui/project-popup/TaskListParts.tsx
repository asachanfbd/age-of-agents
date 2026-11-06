import { X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { ConflictRow, TaskConflict } from '../../lib/taskConflicts';
import { TaskConflictAlert } from './TaskConflictAlert';
/** Shared task-board action alerts and empty states. */

/** `useTaskActions`' failure and success messages, above the list. */
export function ActionAlerts({ error, conflict = null, notice, onDismissNotice, onOpenTask }: {
  error: string;
  conflict?: TaskConflict | null;
  notice: string;
  onDismissNotice: () => void;
  onOpenTask?: (target: ConflictRow['target']) => void;
}) {
  return (
    <>
      {conflict && <TaskConflictAlert conflict={conflict} onOpen={onOpenTask} className="mx-4 mb-2 w-auto max-w-[calc(100%-2rem)] sm:mx-6 sm:max-w-[calc(100%-3rem)]" />}
      {error && (
        <Alert variant="destructive" role="alert" className="mx-4 mb-2 w-auto sm:mx-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert role="status" className="mx-4 mb-2 flex w-auto items-center justify-between gap-3 pr-3 sm:mx-6">
          <AlertDescription>{notice}</AlertDescription>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onDismissNotice} aria-label="Dismiss" title="Dismiss">
            <X aria-hidden="true" />
          </Button>
        </Alert>
      )}
    </>
  );
}

/** Loading or empty content for a board column's div container. */
export function EmptyState({ subtitle, loading }: { subtitle: string; loading: boolean }) {
  if (loading) return <div className="py-10 text-center text-sm italic text-muted-foreground">Loading…</div>;
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-center">
      <p className="text-sm font-medium">Nothing here yet</p>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}
