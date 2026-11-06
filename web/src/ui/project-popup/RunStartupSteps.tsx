import { startupGlyph, startupView } from '../../lib/runStartup';
import type { WorkflowRunRecord } from '../../lib/serverApi';

const STATE_TEXT = { done: 'text-muted-foreground', running: 'font-medium text-foreground', failed: 'font-medium text-destructive', pending: 'text-muted-foreground/70' } as const;

/**
 * The run detail's start-up steps while the run is setting up (or when the setup failed): every step
 * with a static glyph, so a reload shows the same list. Nothing here animates — the glyph and the
 * word carry the state. Renders nothing for a run with no unfinished start-up.
 */
export function RunStartupSteps({ run }: { run: Pick<WorkflowRunRecord, 'status' | 'startup'> }) {
  const view = startupView(run);
  if (!view) return null;
  return (
    <section aria-label="Starting steps" className="shrink-0 border-b bg-muted/20 px-4 py-3 sm:px-6">
      <p className="text-xs font-medium text-muted-foreground">
        {view.failure ? 'Start failed' : run.status === 'starting' ? `Starting · ${view.done}/${view.total}` : 'Stopped before the start finished'}
      </p>
      <ol className="mt-1.5 space-y-0.5">
        {view.steps.map((step) => (
          <li key={step.id} className={`flex items-baseline gap-2 text-sm ${STATE_TEXT[step.state]}`} aria-current={step.state === 'running' ? 'step' : undefined}>
            <span aria-hidden="true" className="w-4 shrink-0 text-center">{startupGlyph(step)}</span>
            <span>{step.name}</span>
            <span className="sr-only">{step.state}</span>
            {step.state === 'failed' && step.reason && <span role="alert" className="min-w-0 break-words text-xs font-normal">— {step.reason}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
