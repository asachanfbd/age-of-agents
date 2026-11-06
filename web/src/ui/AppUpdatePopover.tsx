import { useState } from 'react';
import { RefreshCw, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '../store/worldStore';
import { appUpdateActions, describeAppUpdatePopover } from '../lib/appUpdate';
import type { AppUpdateAction } from '../lib/appUpdate';
import type { AppUpdateStatus } from '../lib/serverApi';
import { useNow } from '../lib/useNow';

const ACTION_LABEL: Record<AppUpdateAction, string> = {
  check: 'Check now',
  update: 'Update',
  updateWhenIdle: 'Update when idle',
  cancel: 'Cancel',
  retry: 'Retry',
};

/** 'update'/'updateWhenIdle'/'retry' are the primary call to action when there is one; 'check'/'cancel' are secondary. */
function isPrimaryAction(action: AppUpdateAction): boolean {
  return action === 'update' || action === 'updateWhenIdle' || action === 'retry';
}

function BlockingGrid({ blocking }: { blocking: ReturnType<typeof describeAppUpdatePopover>['blocking'] }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {blocking.map((row) => (
        <div key={row.key} className="flex flex-col gap-0.5 rounded-md border border-border px-2 py-1.5">
          <span className={`text-sm font-semibold tabular-nums ${row.count === 0 ? 'text-success-foreground' : 'text-foreground'}`}>{row.count}</span>
          <span className="text-[10px] text-muted-foreground">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

function BlockingFilesPanel({ view }: { view: NonNullable<ReturnType<typeof describeAppUpdatePopover>['blockingFiles']> }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(view.copyText);
      setCopied(true);
    } catch { /* Clipboard access can be denied; the list is still on screen. */ }
  }
  return (
    <div role="group" aria-labelledby="app-update-blocking-title" className="flex flex-col gap-1.5 rounded-md border border-destructive/35 bg-destructive/10 p-2 text-[11px] text-foreground">
      <p id="app-update-blocking-title" className="font-semibold">{view.title}</p>
      <ul role="list" className="flex flex-col gap-0.5">
        {view.files.map((file) => (
          <li key={file.path} className="flex items-baseline gap-1.5">
            <code className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</code>
            <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">{file.kindLabel}</span>
          </li>
        ))}
        {view.moreCount > 0 && <li className="italic text-muted-foreground">+{view.moreCount} more</li>}
      </ul>
      <p className="text-muted-foreground">{view.explanation}</p>
      <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy file list'}</Button>
    </div>
  );
}

/**
 * The app-update footer item's popover content — everything read from `describeAppUpdatePopover`
 * (never re-derived here) plus the action buttons `appUpdateActions` says apply to this state. Lives
 * inside `FooterCountPopover`'s shell (see `StatusFooter.tsx`'s `AppUpdateSection`), so hover/pin/Esc/
 * outside-click are that shared component's job, not this one's.
 */
export function AppUpdatePopover({ status }: { status: AppUpdateStatus }) {
  const checkAppUpdateNow = useWorldStore((s) => s.checkAppUpdateNow);
  const applyAppUpdate = useWorldStore((s) => s.applyAppUpdate);
  const cancelAppUpdate = useWorldStore((s) => s.cancelAppUpdate);
  const [pending, setPending] = useState(false);
  const now = useNow(60_000);
  const content = describeAppUpdatePopover(status, now);
  const actions = appUpdateActions(status);

  const HANDLERS: Record<AppUpdateAction, () => Promise<void>> = {
    check: checkAppUpdateNow,
    update: applyAppUpdate,
    updateWhenIdle: applyAppUpdate,
    retry: applyAppUpdate,
    cancel: cancelAppUpdate,
  };

  async function run(action: AppUpdateAction) {
    setPending(true);
    await HANDLERS[action]();
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div>
        <p className="text-sm font-semibold text-foreground">App update</p>
        <p className="text-[11px] text-muted-foreground">{content.behindByText || `branch ${content.branch}`}</p>
      </div>

      {content.classificationLabel && (
        <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-medium text-foreground">
          <Server className="size-3" aria-hidden="true" />{content.classificationLabel}
        </span>
      )}

      {content.commits.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-border bg-muted p-2">
          {content.commits.map((commit) => (
            <li key={commit.sha} className="flex gap-1.5 text-[11px] text-foreground">
              <span className="shrink-0 font-mono text-muted-foreground">{commit.sha}</span>
              <span className="truncate" title={commit.subject}>{commit.subject}</span>
            </li>
          ))}
          {content.commitsTruncatedCount > 0 && (
            <li className="text-[11px] italic text-muted-foreground">+{content.commitsTruncatedCount} more commit{content.commitsTruncatedCount === 1 ? '' : 's'}</li>
          )}
        </ul>
      )}

      {status.phase === 'held' && (
        <>
          <p className="text-[11px] text-muted-foreground">Will run automatically once everything below reaches zero. No timeout.</p>
          <BlockingGrid blocking={content.blocking} />
        </>
      )}

      {status.phase === 'updating' && (
        <p role="status" className="text-[11px] text-muted-foreground">
          Running the update now — this can take a few minutes. The daemon will restart automatically and this page will reconnect on its own.
        </p>
      )}

      {status.phase === 'updated' && (
        <p className="text-[11px] text-muted-foreground">
          Now running <strong className="font-mono text-foreground">{content.updatedToCommit}</strong>. This resolves automatically and the indicator returns to "Up to date".
        </p>
      )}

      {status.phase === 'failed' && content.failureMessage && (
        <div className="rounded-md border border-destructive/35 bg-destructive/10 p-2 text-[11px] text-foreground">
          {content.failureMessage}
          {content.failureLogPath && <p className="mt-1 text-muted-foreground">Log: <code>{content.failureLogPath}</code></p>}
        </div>
      )}

      {content.checkErrorText && (
        <div className="rounded-md border border-destructive/35 bg-destructive/10 p-2 text-[11px] text-foreground">
          {content.checkErrorText}
          {content.showingStaleResult && <p className="mt-1 text-muted-foreground">Showing the last known result.</p>}
        </div>
      )}

      {content.blockingFiles && <BlockingFilesPanel view={content.blockingFiles} />}

      {content.cantUpdateReasonText && !content.blockingFiles && (
        <div className="rounded-md border border-destructive/35 bg-destructive/10 p-2 text-[11px] text-foreground">
          <strong>Can't update automatically:</strong> {content.cantUpdateReasonText}
        </div>
      )}

      {status.mode === 'dev' && content.applyBlockedReasonText && (
        <p className="text-[11px] text-muted-foreground">{content.applyBlockedReasonText}</p>
      )}

      <p className="text-[11px] text-muted-foreground">{content.lastCheckedText}</p>

      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              type="button"
              size="sm"
              variant={isPrimaryAction(action) ? 'default' : 'outline'}
              disabled={pending}
              onClick={() => void run(action)}
            >
              {action === 'check' && <RefreshCw className="size-3" aria-hidden="true" />}
              {ACTION_LABEL[action]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
