import { Fragment, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Bot, ChevronDown, CircleHelp, CircleX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { Attention } from '../../lib/projectTasks';

/**
 * A reusable compact session row. Collapsed, it shows a
 * title and a faded one-line `summary`; on hover or keyboard focus the summary gives way to the
 * `description` and full `tags`. Both layers stay mounted and cross-fade so the row grows smoothly.
 * The description shows one line until its chevron is clicked; expanded, it wraps in full and keeps
 * the details open even after the pointer leaves, until collapsed again.
 */
export function TaskRow({
  lead,
  title,
  summary,
  description,
  tags,
  actions,
  attention,
}: {
  lead: ReactNode;
  title: string;
  /** Already-formatted parts, joined with " • ". */
  summary: string[];
  description: string;
  tags: ReactNode;
  actions: ReactNode;
  /** When set, a badge beside the title and a tinted border make the row stand out even while collapsed. */
  attention?: Attention;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li
      data-expanded={expanded}
      data-attention={attention ?? undefined}
      className="group relative flex items-start gap-3 rounded-lg border bg-card p-3 text-card-foreground transition-colors hover:bg-accent/40 data-[attention=failed]:border-destructive/50 data-[attention=input]:border-warning/60"
    >
      {lead}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm leading-6 font-medium" title={title}>{title}</p>
          {attention && <AttentionTag attention={attention} />}
        </div>
        <div className="grid grid-rows-[1fr] transition-[grid-template-rows,opacity] duration-200 group-data-[expanded=true]:grid-rows-[0fr] group-data-[expanded=true]:opacity-0 group-focus-within:grid-rows-[0fr] group-focus-within:opacity-0 group-hover:grid-rows-[0fr] group-hover:opacity-0">
          <div className="min-h-0 overflow-hidden">
            <p className="truncate text-xs text-muted-foreground"><SummaryLine parts={summary} /></p>
          </div>
        </div>
        <div className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-200 group-data-[expanded=true]:grid-rows-[1fr] group-data-[expanded=true]:opacity-100 group-focus-within:grid-rows-[1fr] group-focus-within:opacity-100 group-hover:grid-rows-[1fr] group-hover:opacity-100">
          <div className="min-h-0 overflow-hidden">
            {description && <TaskDescription text={description} expanded={expanded} onToggle={() => setExpanded((open) => !open)} />}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">{tags}</div>
          </div>
        </div>
      </div>
      <div className="-my-1 -mr-1 flex shrink-0 items-center gap-1">{actions}</div>
    </li>
  );
}

/** The row's description: one truncated line, or the full wrapped text once its chevron is toggled open. */
function TaskDescription({ text, expanded, onToggle }: { text: string; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="mt-0.5 flex min-w-0 items-start gap-1">
      <p className={`min-w-0 flex-1 text-sm text-muted-foreground ${expanded ? 'break-words whitespace-pre-wrap' : 'truncate'}`}>{text}</p>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse description' : 'Expand description'}
        title={expanded ? 'Collapse description' : 'Expand description'}
        onClick={onToggle}
        className="mt-0.5 shrink-0 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronDown className={`size-4 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
      </button>
    </div>
  );
}

function SummaryLine({ parts }: { parts: string[] }) {
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="mx-1.5" aria-hidden="true">•</span>}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/** A quiet outlined tag with a small leading icon — worker, tokens, started, time spent. */
export function MetaTag({ icon: Icon, children }: { icon: ComponentType; children: ReactNode }) {
  return (
    <Badge variant="outline" className="text-muted-foreground">
      <Icon />
      {children}
    </Badge>
  );
}

export function WorkerTag({ label }: { label: string }) {
  return <MetaTag icon={Bot}>{label}</MetaTag>;
}

/** The badge that makes each attention reason visible on a collapsed row. */
const ATTENTION_TAGS: Record<NonNullable<Attention>, { label: string; variant: 'warning' | 'soft-destructive'; icon: ComponentType }> = {
  input: { label: 'Waiting for input', variant: 'warning', icon: CircleHelp },
  failed: { label: 'Failed', variant: 'soft-destructive', icon: CircleX },
};

function AttentionTag({ attention }: { attention: NonNullable<Attention> }) {
  const { label, variant, icon: Icon } = ATTENTION_TAGS[attention];
  return (
    <Badge variant={variant}>
      <Icon />
      {label}
    </Badge>
  );
}
