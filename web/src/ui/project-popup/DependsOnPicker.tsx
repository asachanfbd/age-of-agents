import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { NO_REPOSITORY_REASON, linkCandidates } from '../../lib/dependencies';
import { KindTag, ParentOptionGroups, StateBadge } from './ParentOptionGroups';
import { useWorldStore } from '../../store/worldStore';
import type { PlanItemData } from '../../types';

const EMPTY_ITEMS: PlanItemData[] = [];

/** The card's "Depends on…" button: a searchable list of the project's ready tasks, then its started ones (with their state); choosing one makes it a parent of this task. */
export function DependsOnPicker({ projectId, itemId }: { projectId: string; itemId: string }) {
  const [open, setOpen] = useState(false);
  const items = useWorldStore((s) => s.planByProject[projectId]?.items ?? EMPTY_ITEMS);
  const repositoryUrl = useWorldStore((s) => s.projects.find((project) => project.id === projectId)?.repositoryUrl);
  const setDependencies = useWorldStore((s) => s.setDependencies);
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return null;

  const current = item.dependsOn ?? [];
  const options = linkCandidates(item, items);

  function choose(parentId: string) {
    setOpen(false);
    void setDependencies(projectId, itemId, [...current, parentId]);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="mx-2 mb-1.5 h-6 px-2 text-xs">Depends on…</Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0" aria-label="Choose a parent task">
        {repositoryUrl ? (
          <Command>
            <CommandInput placeholder="Search tasks and bugs…" />
            <CommandList>
              <CommandEmpty>No tasks or bugs to depend on.</CommandEmpty>
              <ParentOptionGroups options={options} renderOption={(option) => (
                <CommandItem key={option.id} value={`${option.id} ${option.title}`} onSelect={() => choose(option.id)}>
                  <span className="min-w-0 flex-1 truncate" title={option.title}>{option.title}</span>
                  <KindTag kind={option.kind} />
                  <StateBadge state={option.state} />
                </CommandItem>
              )} />
            </CommandList>
          </Command>
        ) : <p className="p-3 text-xs text-muted-foreground">{NO_REPOSITORY_REASON}</p>}
      </PopoverContent>
    </Popover>
  );
}
