import { createContext, useContext, useId, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { bugSlotWorkflowId } from '../../lib/bugs';
import { saveUiWaits, startWorkflowSteps, UI_WAITS_HELP_OFF, UI_WAITS_HELP_ON, UI_WAITS_LABEL, uiWaitsSwitch } from '../../lib/earlyUiPlanning';
import { useWorldStore } from '../../store/worldStore';
import type { PlanItemData } from '../../types';

/** The Building Type's "Fix a bug" workflow, which a bug's start runs; the Tasks board provides the one it loaded. */
export const BugWorkflowIdContext = createContext(bugSlotWorkflowId(undefined));

/**
 * "UI planning waits for parent" on a card or in the details. Its workflow is resolved the way the Start task dialog
 * does, so a task whose workflow has no UI Planning step (a bug on Bug Fix, say) shows no switch on the card. The change shows at once and flips back,
 * with an inline alert, when the daemon refuses it. On a card it sits outside the card's click area, so
 * toggling it never opens the card.
 */
export function UiPlanningWaitsSwitch({ item, surface }: { item: PlanItemData; surface: 'card' | 'detail' }) {
  const setUiPlanningWaits = useWorldStore((s) => s.setUiPlanningWaits);
  const bugWorkflowId = useContext(BugWorkflowIdContext);
  const workflowSteps = useWorldStore((s) => startWorkflowSteps(item, { workflows: s.catalogWorkflows, project: s.projects.find((entry) => entry.id === item.projectId), bugWorkflowId }));
  const view = uiWaitsSwitch({ item, surface, workflowSteps });
  const [shown, setShown] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  if (!view.shown) return null;
  const checked = shown ?? view.checked;

  async function change(next: boolean) {
    setShown(next);
    setError(null);
    setSaving(true);
    const outcome = await saveUiWaits(checked, next, (value) => setUiPlanningWaits(item.projectId, item.id, value));
    setSaving(false);
    setError(outcome.error);
    // Once saved, the stored item is the source of truth again.
    setShown(outcome.error ? outcome.value : null);
  }

  const describedBy = surface === 'detail' ? `${id}-help` : undefined;
  return (
    <div className={surface === 'card' ? 'grid gap-1 px-3 pb-2' : 'grid gap-1'} data-ui-waits={surface}>
      <div className="flex items-start gap-2">
        <Switch id={id} className="mt-0.5 shrink-0" checked={checked} disabled={view.disabled || saving} aria-describedby={describedBy} onCheckedChange={(next) => void change(next)} />
        <Label htmlFor={id} className="min-w-0 cursor-pointer text-xs leading-5 font-normal">{UI_WAITS_LABEL}</Label>
      </div>
      {surface === 'detail' && <p id={`${id}-help`} className="pl-10 text-xs text-muted-foreground">{view.note ?? (checked ? UI_WAITS_HELP_ON : UI_WAITS_HELP_OFF)}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
