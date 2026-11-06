import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useWorldStore } from '../store/worldStore';
import { serverApi } from '../lib/serverApi';
import { selectableTypes } from '../lib/buildingTypes';
import type { ServerBuildingType } from '../lib/buildingTypes';
import {
  APPLIES_TO_NEW_RUNS,
  allStepsTo,
  changedSlots,
  fallbackNotice,
  isDirty,
  slotBadge,
  stepAgentNotice,
  workflowChangeWarning,
} from '../lib/typeConfig';
import type { ConfigSlot, SlotEdit } from '../lib/typeConfig';
import {
  HOW_IT_WORKS,
  NO_REPOSITORY_NOTE,
  agentNameOf,
  draftSteps,
  draftWorkflowId,
  draftWorkflowInfo,
  enabledOptions,
  pickStepAgent,
  pickWorkflow,
  slotPayload,
  withoutSlots,
  workflowNameOf,
} from '../lib/typeConfigView';
import { FormErrorAlert } from './FormErrorAlert';

const DEV_TYPES = import.meta.env.DEV;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Catalog's "Building Types" section: per Building type, which workflow fills each slot and which agent runs each
 * step. Edits stay in local state until the person saves; the choices apply to every Building of the type.
 */
export function BuildingTypesSettings() {
  const catalogAgents = useWorldStore((s) => s.catalogAgents);
  const catalogWorkflows = useWorldStore((s) => s.catalogWorkflows);

  const [types, setTypes] = useState<ServerBuildingType[]>([]);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [slots, setSlots] = useState<ConfigSlot[]>([]);
  const [editsByType, setEditsByType] = useState<Record<string, Record<string, SlotEdit>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const type = types.find((t) => t.id === typeId);
  const edits = (typeId && editsByType[typeId]) || {};
  const setEdits = (next: Record<string, SlotEdit>) => { if (typeId) setEditsByType((all) => ({ ...all, [typeId]: next })); };

  useEffect(() => {
    let cancelled = false;
    serverApi.listBuildingTypes()
      .then((loaded) => {
        if (cancelled) return;
        const offered = selectableTypes(loaded, DEV_TYPES);
        setTypes(offered);
        setTypeId((current) => current ?? offered[0]?.id ?? null);
      })
      .catch((e) => { if (!cancelled) setError(messageOf(e)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!typeId) return;
    let cancelled = false;
    serverApi.getBuildingTypeConfig(typeId)
      .then((config) => { if (!cancelled) { setSlots(config.slots); setError(null); } })
      .catch((e) => { if (!cancelled) { setSlots([]); setError(messageOf(e)); } });
    return () => { cancelled = true; };
  }, [typeId]);

  const save = async () => {
    if (!typeId) return;
    setBusy(true);
    setError(null);
    const saved: string[] = [];
    try {
      for (const [slotId, edit] of changedSlots(edits)) {
        const result = await serverApi.setSlotConfig(typeId, slotId, slotPayload(edit));
        setSlots(result.slots);
        saved.push(slotId);
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setEdits(withoutSlots(edits, saved));
      setBusy(false);
    }
  };

  const resetSlot = async (slotId: string) => {
    if (!typeId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await serverApi.resetSlotConfig(typeId, slotId);
      setSlots(result.slots);
      setEdits(withoutSlots(edits, [slotId]));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-semibold">Building Types</h3>
        <p className="mt-1 text-xs text-muted-foreground">Choose which workflow runs in each situation of a Building type, and which agent does each step.</p>
      </div>

      <details className="rounded-lg border border-border p-3 text-sm">
        <summary className="cursor-pointer font-semibold">How this works</summary>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
          {HOW_IT_WORKS.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </details>

      <div role="tablist" aria-label="Building type" className="flex flex-wrap gap-2">
        {types.map((t) => (
          <Button key={t.id} type="button" role="tab" aria-selected={t.id === typeId} variant={t.id === typeId ? 'default' : 'outline'} size="sm" onClick={() => setTypeId(t.id)}>
            {t.name}
          </Button>
        ))}
      </div>

      <FormErrorAlert message={error} />

      {type && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">{type.description}</p>
          <p className="text-xs text-muted-foreground">{APPLIES_TO_NEW_RUNS}</p>
          {!type.repository && (
            <Alert><AlertDescription>{NO_REPOSITORY_NOTE}</AlertDescription></Alert>
          )}
        </div>
      )}

      {slots.map((slot) => (
        <SlotCard
          key={slot.slot.id}
          slot={slot}
          edit={edits[slot.slot.id]}
          busy={busy}
          onEdits={setEdits}
          edits={edits}
          onReset={() => void resetSlot(slot.slot.id)}
          agents={catalogAgents}
          workflows={catalogWorkflows}
        />
      ))}

      {isDirty(edits) && (
        <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3">
          <span className="text-sm text-muted-foreground">You have unsaved changes.</span>
          <span className="flex gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setEdits({})}>Discard</Button>
            <Button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</Button>
          </span>
        </div>
      )}
    </div>
  );
}

type Agents = ReturnType<typeof useWorldStore.getState>['catalogAgents'];
type Workflows = ReturnType<typeof useWorldStore.getState>['catalogWorkflows'];

function SlotCard({ slot, edit, edits, busy, agents, workflows, onEdits, onReset }: {
  slot: ConfigSlot;
  edit: SlotEdit | undefined;
  edits: Record<string, SlotEdit>;
  busy: boolean;
  agents: Agents;
  workflows: Workflows;
  onEdits: (next: Record<string, SlotEdit>) => void;
  onReset: () => void;
}) {
  const slotId = slot.slot.id;
  const workflowId = draftWorkflowId(slot, edit);
  const info = draftWorkflowInfo(slot, edit, workflows);
  const steps = draftSteps(slot, edit, workflows);
  const savedSteps = new Map(slot.steps.map((s) => [s.id, s]));
  const workflowChanged = workflowId !== slot.effectiveWorkflowId;
  const fallback = fallbackNotice(slot, (id) => workflowNameOf(workflows, id));
  const warning = workflowChangeWarning(slot, edit?.workflowId !== undefined ? edit.workflowId : null);
  const workflowOptions = enabledOptions(workflows, workflowId);
  const agentLabel = (id: string, defaultId: string) => `${agentNameOf(agents, id)}${id === defaultId ? ' (step default)' : ''}`;
  const canReset = slot.customised || edit !== undefined;

  return (
    <section className={`rounded-lg border bg-card p-4 ${edit ? 'border-primary' : 'border-border'}`} aria-label={slot.slot.label}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">{slot.slot.label}</h4>
        <span className="flex items-center gap-2">
          <Badge variant={slot.customised ? 'default' : 'outline'}>{slotBadge(slot)}</Badge>
          {canReset && <Button type="button" variant="link" size="sm" disabled={busy} onClick={onReset}>Reset to default</Button>}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">Used when: {slot.slot.usedWhen}</p>

      {fallback && <Alert className="mt-3"><AlertDescription>{fallback}</AlertDescription></Alert>}

      <div className="mt-3 grid gap-1.5">
        <label htmlFor={`wf-${slotId}`} className="text-xs font-semibold">Workflow to run</label>
        <Select value={workflowId} disabled={busy} onValueChange={(id) => onEdits(pickWorkflow(edits, slot, id))}>
          <SelectTrigger id={`wf-${slotId}`} className="w-full sm:w-80"><SelectValue /></SelectTrigger>
          <SelectContent>
            {workflowOptions.map((w) => (
              <SelectItem key={w.id} value={w.id}>{w.name}{w.id === slot.slot.defaultWorkflowId ? ' (default)' : ''}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {info.description && <p className="text-xs text-muted-foreground">{info.description}</p>}
        {warning && edit?.workflowId !== undefined && <Alert><AlertDescription>{warning}</AlertDescription></Alert>}
        <div className="flex flex-wrap gap-1.5" aria-label={`${info.name} steps`}>
          {steps.map((s, i) => <Badge key={s.id} variant="secondary">{i + 1}. {s.name}</Badge>)}
        </div>
      </div>

      <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">
        {steps.map((step) => {
          const notice = !workflowChanged && savedSteps.has(step.id) ? stepAgentNotice(savedSteps.get(step.id)!) : null;
          const options = enabledOptions(agents, step.agentId);
          return (
            <li key={step.id} className="flex flex-col gap-1.5 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-32 flex-1 text-sm font-medium">{step.name}</span>
                {step.customised && <Badge variant="default">Customised</Badge>}
                <Select value={step.agentId} disabled={busy} onValueChange={(id) => onEdits(pickStepAgent(edits, slotId, step, id))}>
                  <SelectTrigger aria-label={`Agent for ${step.name}`} className="w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {options.map((a) => <SelectItem key={a.id} value={a.id}>{agentLabel(a.id, step.defaultAgentId)}</SelectItem>)}
                  </SelectContent>
                </Select>
                {step.customised && (
                  <Button type="button" variant="link" size="sm" disabled={busy} onClick={() => onEdits(pickStepAgent(edits, slotId, step, step.defaultAgentId))}>
                    Reset to {agentNameOf(agents, step.defaultAgentId)}
                  </Button>
                )}
              </div>
              {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">Set all steps to</span>
        <Select
          value=""
          disabled={busy || steps.length === 0}
          onValueChange={(id) => {
            const all = allStepsTo({ ...slot, steps: steps.map((s) => ({ ...savedSteps.get(s.id), id: s.id, name: s.name, defaultAgentId: s.defaultAgentId, configuredAgentId: null, effectiveAgentId: s.defaultAgentId, agentFellBack: false })) }, id);
            onEdits({ ...edits, [slotId]: { ...edit, stepAgents: { ...edit?.stepAgents, ...all } } });
          }}
        >
          <SelectTrigger aria-label="Set all steps to" className="w-56"><SelectValue placeholder="Choose an agent…" /></SelectTrigger>
          <SelectContent>
            {enabledOptions(agents, '').map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}
