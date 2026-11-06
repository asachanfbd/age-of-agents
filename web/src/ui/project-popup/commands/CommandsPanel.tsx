import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, CircleCheck, CircleX, Ellipsis, History, Pencil, Play, Plus, Square, Star, StarOff, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { formatSessionDuration } from '../../../lib/sessionTiming';
import { RelativeTime } from '../../design/RelativeTime';
import type { CommandRun, ProjectCommand } from '../../../lib/serverApi';
import { findRunningRun, useWorldStore } from '../../../store/worldStore';
import type { ProjectData } from '../../../types';
import { CommandLocationChip } from '../LocationChip';
import { CommandForm, MAX_HIGHLIGHTED_COMMANDS } from './CommandDialogs';
import { CommandIcon } from './CommandIcon';
import { RunningDot } from './RunningDot';
import { FormErrorAlert } from '../../FormErrorAlert';
import { useErrorScope } from '../../useErrorScope';

type View = 'list' | 'history';

const mono = (text: string) => <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{text}</code>;

/**
 * The Commands tab: the project's saved commands, each runnable, with a run-history view one click away.
 * Running a command (or opening a past run) shows its live log through `onOpenCommandLog`.
 */
export function CommandsPanel({ project, onOpenCommandLog }: { project: ProjectData; onOpenCommandLog: (runId: string) => void }) {
  const [view, setView] = useState<View>('list');
  const [formFor, setFormFor] = useState<ProjectCommand | 'new' | null>(null);
  const markProjectCommandFailuresRead = useWorldStore((s) => s.markProjectCommandFailuresRead);

  // Showing this tab counts as reviewing this project's failed commands — a no-op when none are
  // unread (see the store action's own doc comment).
  useEffect(() => { void markProjectCommandFailuresRead(project.id); }, [project.id, markProjectCommandFailuresRead]);

  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold tracking-tight">{view === 'list' ? 'Commands' : 'Run history'}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">{view === 'list' ? 'Saved commands you can run in this project.' : 'Past runs of this project’s commands.'}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {view === 'list' ? (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => setView('history')}><History /> View history</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setFormFor('new')}><Plus /> Add command</Button>
            </>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => setView('list')}><ArrowLeft /> Commands</Button>
          )}
        </div>
      </div>

      {view === 'list'
        ? <CommandList project={project} onOpenCommandLog={onOpenCommandLog} onEdit={setFormFor} />
        : <RunHistory project={project} onOpenCommandLog={onOpenCommandLog} />}

      {formFor && <CommandFormDialog project={project} command={formFor === 'new' ? undefined : formFor} onClose={() => setFormFor(null)} />}
    </section>
  );
}

/** One row of a command or history list — an icon tile, a title with a mono meta line, and trailing controls. */
function PanelRow({ icon, title, meta, trailing }: { icon: ReactNode; title: ReactNode; meta: ReactNode; trailing: ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{trailing}</div>
    </li>
  );
}

function RowList({ children }: { children: ReactNode }) {
  return <ul className="mt-5 divide-y overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm">{children}</ul>;
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-5 text-sm italic text-muted-foreground">{children}</p>;
}

function CommandList({ project, onOpenCommandLog, onEdit }: { project: ProjectData; onOpenCommandLog: (runId: string) => void; onEdit: (command: ProjectCommand) => void }) {
  const commands = useWorldStore((s) => s.commandsByProject[project.id]);
  const commandRunsById = useWorldStore((s) => s.commandRunsById);
  const loadCommands = useWorldStore((s) => s.loadCommands);
  const loadActiveCommandRuns = useWorldStore((s) => s.loadActiveCommandRuns);
  const runCommand = useWorldStore((s) => s.runCommand);
  const updateCommand = useWorldStore((s) => s.updateCommand);
  const deleteCommand = useWorldStore((s) => s.deleteCommand);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => { if (!commands) void loadCommands(project.id); }, [commands, project.id, loadCommands]);
  useEffect(() => { void loadActiveCommandRuns(project.id); }, [project.id, loadActiveCommandRuns]);

  if (!commands) return <Note>Loading…</Note>;
  if (commands.length === 0) return <Note>No commands defined yet.</Note>;

  const highlightedCount = commands.filter((command) => command.highlighted).length;

  async function run(commandId: string) {
    setPendingId(commandId);
    const started = await runCommand(commandId);
    setPendingId(null);
    if (started) onOpenCommandLog(started.id);
  }

  return (
    <RowList>
      {commands.map((command) => {
        const active = findRunningRun(commandRunsById, command.id);
        const canHighlight = command.highlighted || highlightedCount < MAX_HIGHLIGHTED_COMMANDS;
        return (
          <PanelRow
            key={command.id}
            icon={<CommandIcon name={command.name} className="size-4" />}
            title={<>{command.name}{command.highlighted && <Star className="ml-1.5 inline size-3 fill-current text-warning-foreground" aria-label="Shown in the header" />}</>}
            meta={mono(command.command)}
            trailing={
              <>
                {active ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => onOpenCommandLog(active.id)}>
                    <RunningDot label="Running" /> Running…
                  </Button>
                ) : (
                  <Button type="button" variant="outline" size="sm" disabled={pendingId === command.id} onClick={() => void run(command.id)}><Play /> Run</Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Options for "${command.name}"`}><Ellipsis aria-hidden="true" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={!!active} onSelect={() => onEdit(command)}><Pencil /> Edit</DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canHighlight}
                      title={canHighlight ? undefined : `Only ${MAX_HIGHLIGHTED_COMMANDS} commands can be shown in the header`}
                      onSelect={() => void updateCommand(project.id, command.id, { highlighted: !command.highlighted })}
                    >
                      {command.highlighted ? <StarOff /> : <Star />} {command.highlighted ? 'Remove from header' : 'Show in header'}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" disabled={!!active} onSelect={() => void deleteCommand(project.id, command.id)}><Trash2 /> Remove</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            }
          />
        );
      })}
    </RowList>
  );
}

const RUN_ICONS: Record<CommandRun['status'], typeof CircleCheck> = { running: Play, success: CircleCheck, failed: CircleX, stopped: Square };

function runBadge(run: CommandRun): ReactNode {
  switch (run.status) {
    case 'running': return <Badge variant="success">Running</Badge>;
    case 'success': return <Badge variant="success">Success</Badge>;
    case 'failed': return <Badge variant="soft-destructive">{run.exitCode === null ? 'Failed' : `Failed (exit ${run.exitCode})`}</Badge>;
    case 'stopped': return <Badge variant="secondary">Stopped</Badge>;
  }
}

function RunHistory({ project, onOpenCommandLog }: { project: ProjectData; onOpenCommandLog: (runId: string) => void }) {
  const runIds = useWorldStore((s) => s.commandRunIdsByProject[project.id]);
  const runsById = useWorldStore((s) => s.commandRunsById);
  const loadCommandRuns = useWorldStore((s) => s.loadCommandRuns);

  useEffect(() => { void loadCommandRuns(project.id); }, [project.id, loadCommandRuns]);

  if (runIds === undefined) return <Note>Loading…</Note>;
  if (runIds.length === 0) return <Note>No commands have been run yet.</Note>;

  return (
    <RowList>
      {runIds.map((id) => {
        const run = runsById[id];
        if (!run) return null;
        const Icon = RUN_ICONS[run.status];
        return (
          <PanelRow
            key={id}
            icon={<Icon className="size-4" aria-hidden="true" />}
            title={run.commandName}
            meta={<>{mono(run.commandText)} · started <RelativeTime at={run.startedAt} /> · {formatSessionDuration(run.startedAt, run.completedAt)}</>}
            trailing={
              <>
                {run.automatic && <Badge variant="secondary">Automatic</Badge>}
                <CommandLocationChip location={run.location} />
                {runBadge(run)}
                <Button type="button" variant="ghost" size="sm" onClick={() => onOpenCommandLog(run.id)}>View log</Button>
              </>
            }
          />
        );
      })}
    </RowList>
  );
}

/** Add a command, or edit one — the same form either way. */
function CommandFormDialog({ project, command, onClose }: { project: ProjectData; command?: ProjectCommand; onClose: () => void }) {
  const commands = useWorldStore((s) => s.commandsByProject[project.id]);
  const createCommand = useWorldStore((s) => s.createCommand);
  const updateCommand = useWorldStore((s) => s.updateCommand);
  const lastError = useErrorScope('commands');
  const [pending, setPending] = useState(false);
  const highlightedCount = commands?.filter((c) => c.highlighted).length ?? 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{command ? 'Edit command' : 'Add command'}</DialogTitle>
        </DialogHeader>
        <FormErrorAlert message={lastError} />
        <CommandForm
          initial={command}
          pending={pending}
          highlightLocked={!command?.highlighted && highlightedCount >= MAX_HIGHLIGHTED_COMMANDS}
          onCancel={onClose}
          onSave={async (input) => {
            setPending(true);
            const ok = command ? await updateCommand(project.id, command.id, input) : await createCommand(project.id, input);
            setPending(false);
            if (ok) onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
