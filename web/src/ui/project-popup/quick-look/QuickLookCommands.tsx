import { useEffect, useState } from 'react';
import { ChevronDown, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { commandMenuState, commandsWhereLabel, minimizedTaskRuns, orderedCommands, WORKING_COPY_REMOVED_TITLE } from '../../../lib/quickLook';
import { serverApi } from '../../../lib/serverApi';
import type { ProjectCommand, RunLocation, WorkflowRunRecord } from '../../../lib/serverApi';
import { findRunningRun, useWorldStore } from '../../../store/worldStore';
import { CommandIcon } from '../commands/CommandIcon';
import { CommandLogPopup } from '../commands/CommandLogPopup';
import { RunCustomCommandDialog } from '../commands/CommandDialogs';
import { RunningDot } from '../commands/RunningDot';
import { useErrorScope } from '../../useErrorScope';

/**
 * A Commands step's Quick look (task 5.008): one grouped "Commands ▾" control beside the step's
 * view switch, listing the project's saved commands (header ones first) and "Run custom command…".
 * Everything started here runs in this WorkflowRun's working copy and opens the shared log popup.
 * A saved command runs one instance at a time wherever it runs, so one already running elsewhere
 * opens that run's log instead. A run here whose log is closed gets a blue dot in the menu and a
 * button beside the group to reopen it. Disabled once the working copy has been removed.
 */
export function QuickLookCommands({ run, compact }: { run: WorkflowRunRecord; compact: boolean }) {
  useErrorScope('quickLook');
  const commands = useWorldStore((s) => s.commandsByProject[run.projectId]);
  const commandRunsById = useWorldStore((s) => s.commandRunsById);
  const loadCommands = useWorldStore((s) => s.loadCommands);
  const loadActiveCommandRuns = useWorldStore((s) => s.loadActiveCommandRuns);
  const runCommand = useWorldStore((s) => s.runCommand);
  const runAdHocCommand = useWorldStore((s) => s.runAdHocCommand);
  const [location, setLocation] = useState<RunLocation | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [runningCustom, setRunningCustom] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { void loadCommands(run.projectId); }, [run.projectId, loadCommands]);
  useEffect(() => { void loadActiveCommandRuns(run.projectId); }, [run.projectId, loadActiveCommandRuns]);
  useEffect(() => {
    let active = true;
    serverApi.getQuickLookLocation(run.id).then((next) => { if (active) setLocation(next); }).catch(() => { if (active) setLocation(null); });
    return () => { active = false; };
  }, [run.id, run.status]);

  const removed = location?.kind === 'removed';
  const where = commandsWhereLabel(location);

  /** Opens the command's running log if it's running anywhere; otherwise starts it here. A start refused by a run begun elsewhere in the meantime opens that run instead. */
  async function startOrOpen(command: ProjectCommand) {
    setError('');
    const state = commandMenuState(findRunningRun(commandRunsById, command.id), run.id);
    if (state.kind !== 'idle') {
      setOpenRunId(state.runId);
      return;
    }
    setPendingId(command.id);
    const started = await runCommand(command.id, run.id);
    setPendingId(null);
    if (started) {
      setOpenRunId(started.id);
      return;
    }
    await loadActiveCommandRuns(run.projectId);
    const raced = findRunningRun(useWorldStore.getState().commandRunsById, command.id);
    if (raced) setOpenRunId(raced.id);
    else setError(useWorldStore.getState().formErrors.quickLook ?? 'The command could not be started');
  }

  const { highlighted, rest } = orderedCommands(commands ?? []);
  const minimized = minimizedTaskRuns(commandRunsById, run.id, openRunId);

  function item(command: ProjectCommand) {
    const state = commandMenuState(findRunningRun(commandRunsById, command.id), run.id);
    return (
      <DropdownMenuItem key={command.id} disabled={pendingId === command.id} title={command.command} onSelect={() => void startOrOpen(command)}>
        <span className="flex w-2 justify-center">
          {state.kind === 'minimized' && <RunningDot tone="minimized" label="Running here, log minimized" />}
          {state.kind === 'running-elsewhere' && <RunningDot label="Running" />}
        </span>
        <CommandIcon name={command.name} />
        <span className="flex-1">{command.name}</span>
        {state.kind === 'minimized' && <span className="text-[11px] text-muted-foreground">minimized</span>}
        {state.kind === 'running-elsewhere' && <span className="text-[11px] text-muted-foreground">running in {state.where}</span>}
      </DropdownMenuItem>
    );
  }

  return (
    <>
      {minimized.map((minimizedRun) => (
        <Button
          key={minimizedRun.id}
          type="button"
          variant="outline"
          size="sm"
          className="h-7 border-info/40 shadow-sm"
          title={`${minimizedRun.commandName}: running, minimized. Click to reopen`}
          onClick={() => setOpenRunId(minimizedRun.id)}
        >
          <RunningDot tone="minimized" label="Running, log minimized" />
          <span className="max-w-28 truncate">{minimizedRun.commandName}</span>
        </Button>
      ))}
      <span className="relative inline-flex">
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={removed}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-0 p-0 shadow-sm"
              aria-label={removed ? `Commands: ${WORKING_COPY_REMOVED_TITLE}` : 'Commands for this task\'s working copy'}
              title={removed ? WORKING_COPY_REMOVED_TITLE : where}
            >
              <span className="flex items-center gap-1.5 px-2.5"><Terminal aria-hidden="true" />{!compact && 'Commands'}</span>
              <span className="flex h-full items-center border-l px-1.5"><ChevronDown className="!size-3.5 text-muted-foreground" aria-hidden="true" /></span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{where}</DropdownMenuLabel>
            {highlighted.map(item)}
            {highlighted.length > 0 && rest.length > 0 && <DropdownMenuSeparator />}
            {rest.map(item)}
            {(highlighted.length > 0 || rest.length > 0) && <DropdownMenuSeparator />}
            <DropdownMenuItem title="Run a one-off shell command without saving it" onSelect={() => setRunningCustom(true)}>
              <span className="w-2" /><Terminal /> Run custom command…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {error && <p role="alert" className="absolute top-full right-0 mt-1 w-64 rounded-md border bg-background p-2 text-xs text-destructive shadow-sm">{error}</p>}
      </span>
      {runningCustom && (
        <RunCustomCommandDialog
          where={where}
          onCancel={() => setRunningCustom(false)}
          onRun={async (command) => {
            const started = await runAdHocCommand(run.projectId, command, run.id);
            setRunningCustom(false);
            if (started) setOpenRunId(started.id);
            else setError(useWorldStore.getState().formErrors.quickLook ?? 'The command could not be started');
          }}
        />
      )}
      {openRunId && <CommandLogPopup key={openRunId} runId={openRunId} onClose={() => setOpenRunId(null)} onRerun={setOpenRunId} />}
    </>
  );
}
