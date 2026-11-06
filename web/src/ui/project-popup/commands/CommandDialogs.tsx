import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useState } from 'react';
import { useWorldStore } from '../../../store/worldStore';
import type { ProjectCommand } from '../../../lib/serverApi';
import { FormErrorAlert } from '../../FormErrorAlert';
import { useErrorScope } from '../../useErrorScope';

/** Mirrors server/src/commands/commandService.ts's MAX_HIGHLIGHTED_COMMANDS — the server is the real enforcement (400s past it); this is only for the checkbox's proactive disable/tooltip. */
export const MAX_HIGHLIGHTED_COMMANDS = 3;

/**
 * "Create a default option to run a custom command and see the output right away." A small dialog
 * (same `.modal-overlay`/`.modal panel` shell as `TopBar.tsx`'s `CreateProjectDialog`) taking just the shell command —
 * no name, since this never becomes a ProjectCommand unless the resulting run is separately saved
 * via `CommandLogPopup`'s "Save as command" (see `SaveCommandDialog`).
 * `where` replaces the default "this project's own root directory" line, e.g. for a task's working copy.
 */
export function RunCustomCommandDialog({ onRun, onCancel, where }: { onRun: (command: string) => void; onCancel: () => void; where?: string }) {
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !running) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = command.trim();
            if (!trimmed || running) return;
            setRunning(true);
            onRun(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>Run a custom command</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Label htmlFor="adhoc-command">Command</Label>
            <Input id="adhoc-command" value={command} onChange={(e) => setCommand(e.target.value)} aria-label="Shell command" placeholder="npm test" disabled={running} autoFocus />
            <p className="text-xs text-muted-foreground">{where ?? 'Runs once from this project\'s own root directory'} and opens its live output — not saved unless you choose to afterward.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={running}>Cancel</Button>
            <Button type="submit" disabled={!command.trim() || running}>{running ? 'Running…' : 'Run'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "This will open create command popup with prefilled command, user will define a name and save."
 * Reuses `CommandForm` (initialized with the run's own command text and an empty name) so saving an
 * ad hoc run gets the exact same fields — including "Show in header" — as the ordinary "+ Add
 * command" flow in Commands tab.
 */
export function SaveCommandDialog({
  projectId,
  prefilledCommand,
  onSaved,
  onCancel,
}: {
  projectId: string;
  prefilledCommand: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const commands = useWorldStore((s) => s.commandsByProject[projectId]);
  const createCommand = useWorldStore((s) => s.createCommand);
  const lastError = useErrorScope('commands');
  const [pending, setPending] = useState(false);
  const highlightedCount = commands?.filter((c) => c.highlighted).length ?? 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save command</DialogTitle>
        </DialogHeader>
        <FormErrorAlert message={lastError} />
        <CommandForm
          initial={{ name: '', command: prefilledCommand }}
          pending={pending}
          highlightLocked={highlightedCount >= MAX_HIGHLIGHTED_COMMANDS}
          onCancel={onCancel}
          onSave={async (input) => {
            setPending(true);
            const ok = await createCommand(projectId, input);
            setPending(false);
            if (ok) onSaved();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The add/edit form shared by "+ Add command", each row's "Edit", and
 * `SaveCommandDialog` (saving an ad hoc run) — same shape as
 * AgentsSettings.tsx's ExecutorForm. The "Show in header" checkbox is this
 * form's own `highlighted` field, not a separate step: whoever's creating or
 * editing a command can opt it into the workspace header right here.
 */
export function CommandForm({
  initial,
  pending,
  highlightLocked,
  onSave,
  onCancel,
}: {
  initial?: Pick<ProjectCommand, 'name' | 'command'> & Partial<Pick<ProjectCommand, 'highlighted'>>;
  pending: boolean;
  /** True when this command isn't already highlighted and the project's already at the {@link MAX_HIGHLIGHTED_COMMANDS} cap elsewhere — locks the checkbox off rather than letting a save fail server-side. Never locks a command that's already highlighted (unchecking must always work). */
  highlightLocked?: boolean;
  onSave: (input: { name: string; command: string; highlighted: boolean }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [highlighted, setHighlighted] = useState(initial?.highlighted ?? false);
  const canSave = name.trim() !== '' && command.trim() !== '' && !pending;
  const checkboxDisabled = pending || (highlightLocked && !highlighted);

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave({ name: name.trim(), command: command.trim(), highlighted });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="command-name">Name</Label>
        <Input id="command-name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Command name" placeholder="Build" disabled={pending} autoFocus />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="command-text">Command</Label>
        <Input id="command-text" value={command} onChange={(e) => setCommand(e.target.value)} aria-label="Shell command" placeholder="npm run build" disabled={pending} />
        <p className="text-xs text-muted-foreground">Run from this project's own root directory — a plain shell command (pipes, <code>&&</code>, etc. all work).</p>
      </div>

      <label
        className="flex items-center gap-2 text-sm"
        title={checkboxDisabled && !highlighted ? `Only ${MAX_HIGHLIGHTED_COMMANDS} commands can be highlighted at once` : undefined}
      >
        <Checkbox checked={highlighted} disabled={checkboxDisabled} onCheckedChange={(checked) => setHighlighted(checked === true)} />
        Show in header
      </label>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={pending}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!canSave}>{pending ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  );
}
