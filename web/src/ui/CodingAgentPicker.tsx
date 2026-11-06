import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { executorOptions } from '../lib/executorAvailability';
import type { ExecutorProfile } from '../lib/serverApi';
import { ExecutorLimitStatus } from './ExecutorLimitStatus';
import { useNow } from './useNow';

function AgentName({ executor, isDefault }: { executor: ExecutorProfile; isDefault: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate text-sm font-medium">{executor.label}</span>
      <span className="text-xs font-normal text-muted-foreground">{executor.kind}</span>
      {isDefault && <span className="rounded border border-border px-1.5 text-[10px] font-medium uppercase text-muted-foreground">Default</span>}
    </span>
  );
}

/**
 * The one dropdown for choosing a coding agent, shared by every surface that starts agent work.
 * `inherit` adds a leading entry that follows another picker (the bulk start's "Same as all");
 * `compact` keeps `label` for screen readers only, for a picker inside a list row.
 */
export function CodingAgentPicker({
  executors,
  value,
  onChange,
  id = 'coding-agent',
  label = 'Coding agent',
  inherit,
  compact = false,
  disabled = false,
  overridden = false,
}: {
  executors: ExecutorProfile[];
  value: string;
  onChange: (executorId: string) => void;
  id?: string;
  label?: string;
  inherit?: { value: string; label: string };
  compact?: boolean;
  disabled?: boolean;
  /** The row chose its own agent: shown with a stronger border and a bold name. */
  overridden?: boolean;
}) {
  const now = useNow();
  if (executors.length === 0) return <p className="text-sm text-muted-foreground">No coding agent is configured</p>;
  const options = executorOptions(executors, now);
  const selected = options.find((option) => option.executor.id === value);
  return (
    <div className={compact ? 'grid' : 'grid gap-2'}>
      <Label htmlFor={id} className={compact ? 'sr-only' : undefined}>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} data-overridden={overridden || undefined} className={`w-full data-[overridden=true]:border-foreground/60 data-[overridden=true]:font-semibold ${compact ? 'h-8 py-1 text-xs' : 'h-auto min-h-9 py-1.5'}`}>
          <SelectValue placeholder="No coding agent available">
            {selected ? <AgentName executor={selected.executor} isDefault={selected.isDefault} /> : inherit && value === inherit.value && <span className="truncate">{inherit.label}</span>}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {inherit && <SelectItem value={inherit.value}>{inherit.label}</SelectItem>}
          {options.map(({ executor, isDefault, disabled, reason }) => (
            <SelectItem key={executor.id} value={executor.id} disabled={disabled}>
              <span className="flex w-full items-center justify-between gap-4">
                <span className="grid min-w-0 gap-0.5">
                  <AgentName executor={executor} isDefault={isDefault} />
                  {reason && <span className="text-xs text-destructive">{reason}</span>}
                </span>
                <span className="shrink-0 text-right font-normal"><ExecutorLimitStatus executor={executor} /></span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
