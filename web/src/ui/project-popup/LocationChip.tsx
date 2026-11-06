import { Folder, GitBranch, House } from 'lucide-react';
import { commandLocationLabel } from '../../lib/quickLook';
import type { CommandRunLocation } from '../../lib/serverApi';

const ICONS = { task: GitBranch, main: House, folder: Folder } as const;

/** A small rounded chip naming where something is: a task's working copy (`task`), the main checkout (`main`) or the project folder (`folder`). */
export function LocationChip({ kind, label }: { kind: keyof typeof ICONS; label: string }) {
  const Icon = ICONS[kind];
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px] text-foreground" title={label}>
      <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Where a command run ran; runs recorded before locations existed read as the main checkout. */
export function CommandLocationChip({ location }: { location: CommandRunLocation | undefined }) {
  return <LocationChip kind={location?.kind === 'task' ? 'task' : 'main'} label={commandLocationLabel(location)} />;
}
