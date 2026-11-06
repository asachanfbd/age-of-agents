import { useEffect, useState } from 'react';
import { ChevronDown, Settings2, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { orderedCommands } from '../../lib/quickLook';
import { findRunningRun, useWorldStore } from '../../store/worldStore';
import type { ProjectData } from '../../types';
import { CommandIcon } from './commands/CommandIcon';
import { RunCustomCommandDialog } from './commands/CommandDialogs';
import { RunningDot } from './commands/RunningDot';

/**
 * The header's command controls: each highlighted command (Start, Build, …) as its own button, then an
 * icon-only dropdown for every other saved command, a one-off custom command, and a shortcut to manage
 * them (`onManage`, wired by `ProjectWorkspaceModal` to open Settings → Commands specifically).
 * Starting a command hands its run id to `onRun`, which opens the live log. These always run in the
 * project's own folder; a command already running anywhere (here or in a task's working copy) shows a
 * running dot and reopens that run's log.
 */
export function HeaderCommands({ project, onRun, onManage }: { project: ProjectData; onRun: (runId: string) => void; onManage: () => void }) {
  const commands = useWorldStore((s) => s.commandsByProject[project.id]);
  const commandRunsById = useWorldStore((s) => s.commandRunsById);
  const loadCommands = useWorldStore((s) => s.loadCommands);
  const loadActiveCommandRuns = useWorldStore((s) => s.loadActiveCommandRuns);
  const runCommand = useWorldStore((s) => s.runCommand);
  const runAdHocCommand = useWorldStore((s) => s.runAdHocCommand);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [runningCustom, setRunningCustom] = useState(false);

  useEffect(() => { void loadCommands(project.id); }, [project.id, loadCommands]);
  // Finds anything still running from before this popup was (re)opened, so its button shows live.
  useEffect(() => { void loadActiveCommandRuns(project.id); }, [project.id, loadActiveCommandRuns]);

  /** A command already running just reopens its log — starting it again would 409. */
  async function run(commandId: string) {
    const active = findRunningRun(commandRunsById, commandId);
    if (active) {
      onRun(active.id);
      return;
    }
    setPendingId(commandId);
    const started = await runCommand(commandId);
    setPendingId(null);
    if (started) onRun(started.id);
  }

  const { highlighted, rest } = orderedCommands(commands ?? []);

  return (
    <>
      {highlighted.map((command) => {
        const active = findRunningRun(commandRunsById, command.id);
        return (
          <Button
            key={command.id}
            type="button"
            variant="outline"
            size="sm"
            disabled={pendingId === command.id}
            title={active ? `Running — click to view (${command.command})` : command.command}
            onClick={() => void run(command.id)}
          >
            <CommandIcon name={command.name} />
            <span className="hidden sm:inline">{pendingId === command.id ? 'Running…' : command.name}</span>
            {active && <RunningDot label="Running" />}
          </Button>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="px-2" aria-label="More commands">
            <Terminal aria-hidden="true" />
            <ChevronDown className="!size-3.5 text-muted-foreground" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Run a command</DropdownMenuLabel>
          {rest.map((command) => {
            const active = findRunningRun(commandRunsById, command.id);
            return (
              <DropdownMenuItem key={command.id} disabled={pendingId === command.id} title={active ? `Running — click to view (${command.command})` : command.command} onSelect={() => void run(command.id)}>
                <CommandIcon name={command.name} />
                {command.name}
                {active && <RunningDot label="Running" />}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuItem title="Run a one-off shell command without saving it" onSelect={() => setRunningCustom(true)}>
            <Terminal /> Run custom command…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onManage}><Settings2 /> Manage commands</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {runningCustom && (
        <RunCustomCommandDialog
          onCancel={() => setRunningCustom(false)}
          onRun={async (command) => {
            const started = await runAdHocCommand(project.id, command);
            setRunningCustom(false);
            if (started) onRun(started.id);
          }}
        />
      )}
    </>
  );
}
