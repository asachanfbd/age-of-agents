import type { ReactNode } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WORKING_COPY_REMOVED_TITLE, workingCopyRemovedDetail } from '../../../lib/quickLook';

/**
 * The quiet strip above a Quick look: where it reads from (`children`), a live note and Refresh.
 * Its right side is kept clear for the floating view switch.
 */
export function SourceStrip({ children, note, onRefresh }: { children: ReactNode; note: ReactNode; onRefresh: () => void }) {
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/30 py-1.5 pr-4 pl-4 text-xs text-muted-foreground sm:pr-72 sm:pl-6">
      {children}
      <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-success" aria-hidden="true" />{note}</span>
      <Button type="button" variant="outline" size="icon-sm" className="size-6" aria-label="Refresh" title="Refresh" onClick={onRefresh}>
        <RefreshCw className="!size-3" aria-hidden="true" />
      </Button>
    </div>
  );
}

/** The removed-working-copy state, shared by Code, Docs and a Diff whose branch can't be read either. */
export function WorkingCopyRemoved({ branch, detail }: { branch: string | null; detail?: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 pt-12 text-center">
      <div className="max-w-sm space-y-1">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full border bg-muted text-muted-foreground">
          <GitBranch className="size-4" aria-hidden="true" />
        </div>
        <p className="text-sm font-medium">{WORKING_COPY_REMOVED_TITLE}</p>
        <p className="text-sm text-muted-foreground">{detail ?? workingCopyRemovedDetail(branch)}</p>
      </div>
    </div>
  );
}
