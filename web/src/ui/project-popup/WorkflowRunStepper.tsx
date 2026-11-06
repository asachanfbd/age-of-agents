import { StickyNote } from 'lucide-react';
import { useNow } from '../../lib/useNow';
import { runStatusBadge, stageRoundBadge, stageStates, stageTimeLabel, stepRoundOffset } from '../../lib/workflowRunView';
import type { RunStage, RunStatusVariant } from '../../lib/workflowRunView';
import type { WorkflowRunRecord } from '../../lib/serverApi';

/** A `done`/`pending`/`skipped` stage's fixed tint; a `current` stage is tinted by the run's own status instead (see `VARIANT_CLASSES`). */
const STATE_CLASSES: Record<'done' | 'pending' | 'skipped', string> = {
  done: 'border-success/40 bg-success/10 text-success-foreground',
  pending: 'border-border bg-background text-muted-foreground',
  skipped: 'border-dashed border-muted-foreground/50 bg-transparent text-muted-foreground',
};

const VARIANT_CLASSES: Record<RunStatusVariant, string> = {
  secondary: 'border-muted-foreground/40 bg-muted text-foreground',
  success: 'border-success/60 bg-success/15 text-success-foreground',
  warning: 'border-warning/60 bg-warning/15 text-warning-foreground',
  'soft-destructive': 'border-destructive/60 bg-destructive/15 text-destructive',
};

/** How often the current step's chip ticks (task 5.003) — much faster than other panels' staleness labels, since this is the one place showing a genuinely live, second-by-second timer. */
const LIVE_TIMER_TICK_MS = 1_000;

/**
 * The run detail view's full Stepper — every stage in order (each configured WorkflowStep, then
 * Complete), each clickable to select it below, with its round counts, its time spent once done, and
 * the current stage's own live, ticking timer (task 5.003).
 */
export function WorkflowRunStepper({
  stages,
  run,
  selectedStageId,
  onSelect,
  notedStepIds = [],
}: {
  stages: RunStage[];
  run: Pick<WorkflowRunRecord, 'currentStepId' | 'status' | 'updatedAt' | 'regression'>;
  selectedStageId: string;
  onSelect: (stageId: string) => void;
  /** Steps that have a note waiting; each shows a small note marker. */
  notedStepIds?: string[];
}) {
  const states = stageStates(stages, run);
  const currentVariant = runStatusBadge(run.status).variant;
  const now = useNow(LIVE_TIMER_TICK_MS);

  return (
    <ol className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-3 sm:px-6" aria-label="Workflow stages">
      {stages.map((stage, index) => {
        const state = states[index];
        const active = stage.id === selectedStageId;
        const roundBadge = stageRoundBadge(stage.rounds, stepRoundOffset(run, stage.id));
        const timeLabel = stageTimeLabel(stage, state, run, now);
        const toneClasses = state === 'current' ? VARIANT_CLASSES[currentVariant] : STATE_CLASSES[state];
        return (
          <li key={stage.id}>
            <button
              type="button"
              onClick={() => onSelect(stage.id)}
              aria-current={active ? 'step' : undefined}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${toneClasses} ${active ? 'ring-2 ring-primary/50 ring-offset-1 ring-offset-background' : ''}`}
            >
              <span>{stage.name}</span>
              {notedStepIds.includes(stage.id) && <StickyNote className="size-3" aria-label="Has a note" />}
              {roundBadge && <span className="text-[10px] opacity-75">{roundBadge}</span>}
              {state === 'skipped' && <span className="text-[10px] font-normal opacity-75">Skipped</span>}
              {timeLabel && <span className="text-[10px] opacity-75">• {timeLabel}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
