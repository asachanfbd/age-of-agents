import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { describeActivity } from '../../lib/agentActivity';
import type { TaskTurn } from '../../lib/serverApi';
import { MarkdownDocument } from '../MarkdownDocument';
import { formatClockTime } from './formatClockTime';

/**
 * Collapsible "what the agent is doing" card for one run of consecutive tool/status events —
 * replaces `AgentEvents`, styled like assistant-ui's tool-call disclosure blocks instead of a
 * native `<details>`. Collapsed by default; expanding shows each event's human-readable activity
 * (`describeActivity`) plus a nested "Raw event" escape hatch with the untouched JSON.
 */
export function ToolActivityCard({ events }: { events: TaskTurn[] }) {
  const [expanded, setExpanded] = useState(false);
  const activity = useMemo(() => {
    const toolNames = new Map<string, string>();
    return events.map((event) => describeActivity(event.content, toolNames));
  }, [events]);
  if (events.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/40">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <Wrench className="size-3.5 shrink-0" />
        <span>{events.length} tool/status {events.length === 1 ? 'event' : 'events'}</span>
      </button>
      {expanded && (
        <ol className="flex flex-col gap-3 border-t border-border px-3 py-3">
          {events.map((event, index) => {
            const time = formatClockTime(event.at, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            return (
              <li key={index} className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                  <strong className="font-medium text-foreground">Activity {index + 1}</strong>
                  <time dateTime={event.at} title={event.at}>{time}</time>
                </div>
                {activity[index].map((part, partIndex) => (
                  <section key={partIndex} className="flex flex-col gap-1.5">
                    <h4 className="text-xs font-semibold text-foreground">{part.title}</h4>
                    {part.code
                      ? <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-background/60 p-3 font-mono text-xs">{part.text}</pre>
                      : <MarkdownDocument content={part.text} />}
                  </section>
                ))}
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none">Raw event</summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-background/60 p-3 font-mono text-xs">{event.content}</pre>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
