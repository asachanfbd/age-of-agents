import type { ReactNode } from 'react';
import { CommandGroup } from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import type { ParentState, PickerOption } from '../../lib/dependencies';

/** A started task's state next to its label, so it reads differently from a ready one. */
export function StateBadge({ state }: { state: ParentState }) {
  return state === 'Ready' ? null : <Badge variant="warning" className="shrink-0">{state}</Badge>;
}

/** Whether a picker row is a task or a bug, so the two can be told apart in one list. */
export function KindTag({ kind }: { kind: PickerOption['kind'] }) {
  return <Badge variant="outline" className="shrink-0">{kind}</Badge>;
}

/** The picker's list: ready tasks first, then a "Started" group that explains the wait. */
export function ParentOptionGroups({ options, renderOption }: { options: PickerOption[]; renderOption: (option: PickerOption) => ReactNode }) {
  const ready = options.filter((option) => option.state === 'Ready');
  const started = options.filter((option) => option.state !== 'Ready');
  return (
    <>
      {ready.length > 0 && <CommandGroup heading="Ready">{ready.map(renderOption)}</CommandGroup>}
      {started.length > 0 && (
        <CommandGroup heading="Started">
          <p className="px-2 pb-1 text-xs text-muted-foreground">Your item waits until their PR is merged.</p>
          {started.map(renderOption)}
        </CommandGroup>
      )}
    </>
  );
}
