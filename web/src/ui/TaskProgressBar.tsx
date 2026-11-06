import { cn } from '@/lib/utils';
import { taskProgressLabel } from '../lib/projectTasks';
import type { TaskProgress } from '../lib/projectTasks';

/** Segment order and colour. */
const PROGRESS_SEGMENTS = [
  { key: 'done', color: 'bg-success' },
  { key: 'inProgress', color: 'bg-info' },
  { key: 'pending', color: 'bg-muted-foreground' },
] as const;

/**
 * A thin three-colour bar: done, in progress and pending tasks, each segment sized by its share of
 * the total. Renders an empty track when the project has no tasks.
 */
export function TaskProgressBar({ progress, className }: { progress: TaskProgress; className?: string }) {
  const label = taskProgressLabel(progress);
  return (
    <div role="img" aria-label={label} title={label} className={cn('flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted-foreground/25', className)}>
      {PROGRESS_SEGMENTS.map(({ key, color }) =>
        progress[key] > 0 ? <span key={key} className={cn('h-full transition-all', color)} style={{ flexGrow: progress[key] }} /> : null,
      )}
    </div>
  );
}
