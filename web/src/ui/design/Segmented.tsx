import { cn } from '@/lib/utils';

export interface Option<T extends string> { value: T; label: string; icon?: React.ReactNode }

/** A segmented control on a light-grey track; the selected segment is white. Each segment is a toggle button with `aria-pressed`. */
export function SegmentedControl<T extends string>({ value, options, onChange, label, className }: { value: T; options: readonly Option<T>[]; onChange: (next: T) => void; label: string; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex rounded-control bg-secondary p-[3px]', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-control px-3.5 py-1 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4',
            option.value === value ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.icon}{option.label}
        </button>
      ))}
    </div>
  );
}

/** Filter chips (All / Enterprise / ...): the active chip is charcoal. `value` of undefined means no chip is active. */
export function FilterChips<T extends string>({ value, options, onChange, label }: { value: T | undefined; options: readonly Option<T>[]; onChange: (next: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-control px-3.5 py-1 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
            option.value === value ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
