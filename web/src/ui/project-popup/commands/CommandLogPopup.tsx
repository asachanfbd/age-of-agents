import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseAnsi } from '../../../lib/ansi';
import { canRerunCommandRun } from '../../../lib/quickLook';
import { watchRun } from '../../../lib/serverApi';
import type { CommandRun } from '../../../lib/serverApi';
import { useWorldStore } from '../../../store/worldStore';
import { CommandLocationChip } from '../LocationChip';
import { SaveCommandDialog } from './CommandDialogs';

/** CommandLogPopup's footer message per status — a plain lookup (same convention as CHAT_LABEL above) so adding a status can't silently fall through to the wrong text. Color is applied via the matching `.command-log__status--*` CSS class, not here. */
const COMMAND_STATUS_MESSAGE: Record<CommandRun['status'], (exitCode: number | null) => string> = {
  running: () => 'Running…',
  success: (exitCode) => `✓ Command completed successfully${exitCode !== null ? ` (exit ${exitCode})` : ''}`,
  failed: (exitCode) => `✗ Command failed${exitCode !== null ? ` (exit ${exitCode})` : ''}`,
  stopped: () => '■ Command stopped',
};

/**
 * "When I click a command button it should open a small popup with showing command logs with an
 * option to close it." A small dialog (same `.modal-overlay`/`.modal panel` shell as
 * `RunCustomCommandDialog`) showing a run's live-streaming output — kept current via WS through
 * `commandRunsById` (see `mergeWorkerEvent`'s 'commandRun'/'commandRunLog' cases in worldStore.ts),
 * so no polling here. Every caller that can open this popup (`ProjectCommandBar`, `CommandsManager`'s
 * "Run", `CommandsHistory`'s "View log") has already loaded the run into `commandRunsById` by the
 * time it does, so this reads it straight from the store rather than re-fetching. Close never stops
 * the run — it keeps going in the background exactly like a Task does (see
 * docs/architecture.md#background-daemon-not-session-bound). The header names where the run ran;
 * a run from a task's working copy offers no Re-run (see `canRerunCommandRun`).
 */
export function CommandLogPopup({ runId, onClose, onRerun }: { runId: string; onClose: () => void; onRerun: (newRunId: string) => void }) {
  const run = useWorldStore((s) => s.commandRunsById[runId]);
  const stopCommandRun = useWorldStore((s) => s.stopCommandRun);
  const runCommand = useWorldStore((s) => s.runCommand);
  const runAdHocCommand = useWorldStore((s) => s.runAdHocCommand);
  const syncProjectBranch = useWorldStore((s) => s.syncProjectBranch);
  const markCommandRunOpened = useWorldStore((s) => s.markCommandRunOpened);
  const [stopping, setStopping] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  // "Give option to save the command for later use" — only offered for an ad hoc run (see
  // CommandRunOrigin's doc comment: a 'saved' run already is one, a 'sync' run is a fixed system
  // action, neither worth "saving" again).
  const [saving, setSaving] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  useEffect(() => watchRun('command', runId), [runId]);
  // Showing a failed run's log counts as opening it, wherever this popup was opened from: its red machine in the village clears.
  const failureUnopened = !!run?.failureUnopened;
  useEffect(() => { if (failureUnopened) void markCommandRunOpened(runId); }, [failureUnopened, runId, markCommandRunOpened]);

  // Most CLIs (webpack, npm, ...) color their own output with ANSI escape codes whenever they
  // think they're writing to a color-capable terminal — spawn's pipes often fool that detection.
  // Re-parsed off the full accumulated output rather than per streamed chunk (see parseAnsi's own
  // doc comment for why), and memoized so an unrelated re-render doesn't re-parse a large log.
  const segments = useMemo(() => parseAnsi(run?.output ?? ''), [run?.output]);

  // Auto-scrolls to the newest output as it streams in, but only when already scrolled to the
  // bottom — so someone scrolling up to read earlier output isn't yanked back down on every chunk.
  useLayoutEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [run?.output]);

  const statusColor = run?.status === 'running' ? 'text-warning-foreground' : run?.status === 'success' ? 'text-success-foreground' : run?.status === 'failed' ? 'text-destructive' : 'text-muted-foreground';

  // Retriggers this run's underlying command per its origin, then points the popup at the freshly
  // started run (via onRerun -> the parent's openCommandRunId, remounting this component so its
  // local state resets — see the render site's key={openCommandRunId} comment).
  const handleRerun = async () => {
    if (!run) return;
    setRerunning(true);
    const started = run.origin === 'sync'
      ? await syncProjectBranch(run.projectId)
      : run.origin === 'adhoc'
        ? await runAdHocCommand(run.projectId, run.commandText)
        : await runCommand(run.commandId);
    setRerunning(false);
    if (started) onRerun(started.id);
  };

  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="flex max-h-[min(85vh,var(--popup-max-height))] flex-col gap-4 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{run?.commandName ?? 'Command'}</DialogTitle>
          </DialogHeader>
          {run?.commandText && (
            <div className="flex items-center justify-between gap-3">
              <p className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground"><code>{run.commandText}</code><CommandLocationChip location={run.location} /></p>
              {run.origin === 'adhoc' && (
                <Button type="button" variant="outline" size="sm" onClick={() => setSaving(true)}>Save as command</Button>
              )}
            </div>
          )}
          <pre ref={outputRef} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/60 p-3 font-mono text-xs leading-relaxed">
            {!run ? 'Loading…' : !run.output ? 'No output yet…' : segments.map((segment, index) => (
              <span key={index} style={segment.style}>{segment.text}</span>
            ))}
          </pre>
          {/* Running status + Stop while it's going; the color-coded outcome message and a Close
              button (in Stop's place) once it's settled — all live at the popup's footer. */}
          {run && (
            <footer className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <p className={`text-sm font-semibold ${statusColor}`}>{COMMAND_STATUS_MESSAGE[run.status](run.exitCode)}</p>
              {run.status === 'running' ? (
                // Minimize just hides this popup — the run (e.g. a long-lived `npm run dev`) keeps
                // going in the background exactly like Close already does once settled; it stays
                // reachable via the header button's/row's glowing dot or Commands → History.
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={onClose}>Minimize</Button>
                  <Button type="button" variant="destructive" size="sm" disabled={stopping} onClick={async () => { setStopping(true); await stopCommandRun(runId); setStopping(false); }}>
                    {stopping ? 'Stopping…' : 'Stop'}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {canRerunCommandRun(run) && (
                    <Button type="button" variant="outline" size="sm" disabled={rerunning} onClick={handleRerun}>
                      {rerunning ? 'Re-running…' : 'Re-run'}
                    </Button>
                  )}
                  {/* Orange — a signal that the run is done and it's safe/time to close this popup. */}
                  <Button type="button" variant="outline" size="sm" className="border-warning/60 bg-warning/20 text-warning-foreground hover:bg-warning/30" onClick={onClose}>Close</Button>
                </div>
              )}
            </footer>
          )}
        </DialogContent>
      </Dialog>
      {saving && run && (
        <SaveCommandDialog projectId={run.projectId} prefilledCommand={run.commandText} onCancel={() => setSaving(false)} onSaved={() => setSaving(false)} />
      )}
    </>
  );
}
