import { Bug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { BUG_BADGE_LABEL } from '../../lib/bugs';
import type { BugCardInfo, RelatedLink } from '../../lib/bugs';

/** A bug card's badge row: the Bug badge always (in text, not colour alone), then severity and "Needs more info" when they apply. */
export function BugBadges({ bug }: { bug: BugCardInfo }) {
  return (
    <span className="mb-1 flex flex-wrap items-center gap-1">
      <Badge variant="soft-destructive"><Bug aria-hidden="true" /> {BUG_BADGE_LABEL}</Badge>
      {bug.severityLabel && <Badge variant="outline">{bug.severityLabel}</Badge>}
      {bug.needsMoreInfo && <Badge variant="warning">Needs more info</Badge>}
      {bug.regressedLabel && <Badge variant="warning">{bug.regressedLabel}</Badge>}
    </span>
  );
}

/** "Introduced by 4.002: Add login" under a bug card: a link to that task while it exists, plain text once it was removed. */
export function IntroducedByLine({ link, onOpenTask }: { link: NonNullable<BugCardInfo['introducedBy']>; onOpenTask?: (taskId: string) => void }) {
  const taskId = link.taskId;
  return (
    <p className="truncate px-3 pb-2 text-xs text-muted-foreground">
      Introduced by{' '}
      {taskId && onOpenTask ? (
        <button type="button" className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={() => onOpenTask(taskId)}>
          {link.text}
        </button>
      ) : (
        <span>{link.text}</span>
      )}
    </p>
  );
}

/** "Related to 10.010.003: title" under a task, "Related task: title" under a bug: a link while the other item exists, struck-through text once it is gone. */
export function RelatedLine({ link, onOpenItem }: { link: RelatedLink; onOpenItem?: (itemId: string) => void }) {
  const itemId = link.itemId;
  return (
    <p className="truncate px-3 pb-2 text-xs text-muted-foreground" title={`${link.prefix} ${link.text}`}>
      {link.prefix}{' '}
      {itemId && onOpenItem ? (
        <button type="button" className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={() => onOpenItem(itemId)}>
          {link.text}
        </button>
      ) : (
        <span className={itemId ? '' : 'line-through'}>{link.text}</span>
      )}
    </p>
  );
}
