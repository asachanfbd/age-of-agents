import { useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { Bot, Bug, GitMerge, Loader2, Play } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  bulkLimitNote, checkedRows, classifyStart, createBulkRunner, DEFAULTS_NOTE, failedIds, liveOverride, lockedAgentLabel, NO_WORKFLOW_NOTE,
  NOT_SELECTED_STATUS, PLAY_BUTTON_LABEL, playButtonState, progressLine, rowAgentId, rowPickerEnabled, rowStartOptions, rowStatusText,
  SAME_AS_ALL, sameAsAllLabel, selectableIds, selectionSummary, setOverride, startBlockReason, startButtonLabel, summaryLine, toggleChecked, waitsForText,
} from '../../lib/bulkStart';
import type { BulkPhase, BulkRow, BulkRunner, RowResult } from '../../lib/bulkStart';
import type { StartConfirmParent } from '../../lib/dependencies';
import type { ExecutorProfile, ExecutePlanItemOptions, PlanItemQueueEntry } from '../../lib/serverApi';
import { slotCap } from '../../lib/waitingList';
import { CodingAgentPicker } from '../CodingAgentPicker';
import { useExecutorChoice } from '../useExecutorChoice';
import { useNow } from '../useNow';

/**
 * The Planning column header's play button. While no card can start it stays focusable with
 * `aria-disabled` (a disabled Button takes no pointer events, so its title would never show).
 */
export function StartPendingButton({ rows, onOpen }: { rows: readonly BulkRow[]; onOpen: () => void }) {
  const state = playButtonState(rows);
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={PLAY_BUTTON_LABEL}
      aria-disabled={state.disabled || undefined}
      title={state.title}
      className="aria-disabled:cursor-not-allowed aria-disabled:[&_svg]:opacity-50"
      onClick={() => { if (!state.disabled) onOpen(); }}
    >
      <Play aria-hidden="true" />
    </Button>
  );
}

/**
 * "Start pending tasks": every startable Planning card, checked by default, started one by one in
 * column order through the same call as the single Start task dialog. The dialog stays open with each
 * row's result until the owner closes it; it cannot be closed while starts are being sent.
 */
export function BulkStartDialog({
  rows,
  hasRepository,
  slotsInUse,
  lookupParents,
  start,
  queue,
  onClose,
}: {
  /** The column's startable cards, live; frozen once Start is pressed, so a batch never gains or loses a row. */
  rows: BulkRow[];
  hasRepository: boolean;
  slotsInUse: number;
  /** The parents a row's task still waits for (the Start dialog's lookup). */
  lookupParents: (itemId: string) => Promise<StartConfirmParent[]>;
  /** The single Start's call; resolves to the run id, or '' when the task queued or waits. */
  start: (row: Pick<BulkRow, 'id' | 'title'>, options: ExecutePlanItemOptions) => Promise<string>;
  /** The Project's waiting list right after a start, for the queued row's place. */
  queue: () => readonly PlanItemQueueEntry[] | undefined;
  onClose: () => void;
}) {
  const { executors, executorId: commonId, choose } = useExecutorChoice();
  const now = useNow();
  const [frozen, setFrozen] = useState<BulkRow[] | null>(null);
  const shown = frozen ?? rows;
  const [checked, setChecked] = useState<string[]>(() => selectableIds(rows));
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [sent, setSent] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const parents = useParentLookups(rows, lookupParents);
  const retryRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Each start reads the agent picked at the moment it is sent, so a retry uses the new pick.
  const latest = useRef({ shown, overrides, commonId, executors, now, hasRepository, start, queue });
  latest.current = { shown, overrides, commonId, executors, now, hasRepository, start, queue };
  const runner = useRef<BulkRunner | null>(null);
  runner.current ??= createBulkRunner(async (id) => {
    const current = latest.current;
    const row = current.shown.find((candidate) => candidate.id === id)!;
    const agent = rowAgentId(current.executors, current.commonId, current.overrides[id], current.now);
    const runId = await current.start(row, rowStartOptions(row, agent, current.hasRepository));
    return classifyStart(runId, current.queue(), id);
  }, (id, result) => setResults((previous) => ({ ...previous, [id]: result })));

  const phase: BulkPhase = running ? 'running' : Object.keys(results).length > 0 ? 'done' : 'idle';
  const failed = failedIds(shown, results);

  useEffect(() => {
    if (phase === 'done') (failed.length > 0 ? retryRef : closeRef).current?.focus();
    // Only when a batch finishes, not on every result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function send(ids: string[]) {
    if (!runner.current || runner.current.busy) return;
    setRunning(true);
    try { await runner.current.run(ids); } finally { setRunning(false); }
  }

  function startAll() {
    if (runner.current?.busy) return;
    const ids = checkedRows(rows, checked).map((row) => row.id);
    setFrozen(rows);
    setSent(ids);
    void send(ids);
  }

  function retryFailed() {
    if (runner.current?.busy) return;
    setSent(failed);
    void send(failed);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !running) onClose(); }}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-xl" hideClose>
        <DialogHeader>
          <DialogTitle>Start pending tasks</DialogTitle>
          <DialogDescription>Starts the checked tasks one by one, in board order.</DialogDescription>
        </DialogHeader>
        <BulkStartBody
          rows={shown}
          checked={checked}
          overrides={overrides}
          results={results}
          sent={sent}
          phase={phase}
          executors={executors}
          commonId={commonId}
          now={now}
          parents={parents}
          hasRepository={hasRepository}
          slotsInUse={slotsInUse}
          retryRef={retryRef}
          closeRef={closeRef}
          onCommonChange={choose}
          onToggle={(id) => setChecked((current) => toggleChecked(shown, current, id))}
          onSelectAll={() => setChecked(selectableIds(shown))}
          onSelectNone={() => setChecked([])}
          onOverride={(id, value) => setOverrides((current) => setOverride(current, id, value))}
          onStart={startAll}
          onRetry={retryFailed}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Asks the daemon once per row with parents which of them are not merged yet. A row is missing from
 * the result while its lookup runs; a failed lookup records nothing to show (the daemon decides at start).
 */
function useParentLookups(rows: readonly BulkRow[], lookup: (itemId: string) => Promise<StartConfirmParent[]>): Record<string, StartConfirmParent[]> {
  const [found, setFound] = useState<Record<string, StartConfirmParent[]>>({});
  const asked = useRef(new Set<string>());
  const mounted = useRef(true);
  const lookupRef = useRef(lookup);
  useEffect(() => {
    lookupRef.current = lookup;
  });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const key = rows.filter((row) => row.hasParents).map((row) => row.id).join(',');
  useEffect(() => {
    for (const id of key ? key.split(',') : []) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      const record = (parents: StartConfirmParent[]) => { if (mounted.current) setFound((previous) => ({ ...previous, [id]: parents })); };
      lookupRef.current(id).then(record, () => record([]));
    }
  }, [key]);
  return found;
}

export interface BulkStartBodyProps {
  rows: readonly BulkRow[];
  checked: readonly string[];
  overrides: Readonly<Record<string, string>>;
  results: Readonly<Record<string, RowResult>>;
  /** The rows the current batch sends, in order. */
  sent: readonly string[];
  phase: BulkPhase;
  executors: ExecutorProfile[];
  /** The "Coding agent for all" choice; '' when no agent is usable. */
  commonId: string;
  /** Epoch seconds, for agent availability. */
  now: number;
  /** Each looked-up row's parents not merged yet; a row with parents and no entry is still being looked up. */
  parents: Readonly<Record<string, readonly StartConfirmParent[]>>;
  hasRepository: boolean;
  slotsInUse: number;
  retryRef?: Ref<HTMLButtonElement>;
  closeRef?: Ref<HTMLButtonElement>;
  onCommonChange: (executorId: string) => void;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onOverride: (id: string, value: string) => void;
  onStart: () => void;
  onRetry: () => void;
  onClose: () => void;
}

/** The dialog's content under its title, with no Radix Dialog around it, so it renders on its own. */
export function BulkStartBody(props: BulkStartBodyProps) {
  const { rows, checked, results, phase, executors, commonId, parents, hasRepository, slotsInUse, retryRef, closeRef, onRetry, onClose, onStart } = props;
  const selection = selectionSummary(rows, checked);
  const lookupsPending = rows.some((row) => row.hasParents && !parents[row.id]);
  const blockReason = startBlockReason({ selected: selection.count, commonAgentId: commonId });
  const limitNote = phase === 'idle' ? bulkLimitNote(slotsInUse, slotCap(hasRepository)) : null;
  const failed = failedIds(rows, results);
  const progress = progressLine(props.sent, results);
  const idle = phase === 'idle';
  return (
    <div className="grid min-w-0 gap-4">
      <CodingAgentPicker executors={executors} value={commonId} onChange={props.onCommonChange} id="bulk-start-agent" label="Coding agent for all" disabled={!idle} />
      <div className="grid min-w-0 gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-medium" id="bulk-start-tasks-label">Tasks · <span data-selection-count>{selection.text}</span></span>
          <span className="ml-auto flex gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={!idle || !selection.canSelectAll} onClick={props.onSelectAll}>Select all</Button>
            <Button type="button" variant="ghost" size="sm" disabled={!idle || !selection.canSelectNone} onClick={props.onSelectNone}>Select none</Button>
          </span>
        </div>
        <ul aria-labelledby="bulk-start-tasks-label" className="max-h-[min(22rem,50vh)] overflow-y-auto rounded-md border">
          {rows.map((row) => <BulkStartRow key={row.id} row={row} {...props} isChecked={checked.includes(row.id)} result={results[row.id]} waits={waitsForText(parents[row.id])} />)}
        </ul>
      </div>
      {idle && <p className="text-xs text-muted-foreground" data-defaults-note>{DEFAULTS_NOTE}</p>}
      {limitNote && <p className="text-xs text-muted-foreground" data-full-note>{limitNote}</p>}
      <p className="text-xs text-muted-foreground empty:hidden" aria-live="polite" data-progress>{phase === 'running' ? progress : phase === 'done' ? summaryLine(results) : ''}</p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {phase === 'done' ? (
          <>
            {failed.length > 0 && <Button type="button" variant="outline" ref={retryRef} onClick={onRetry}>Retry failed ({failed.length})</Button>}
            <Button type="button" ref={closeRef} onClick={onClose}>Close</Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" disabled={!idle} onClick={onClose}>{idle ? 'Cancel' : 'Close'}</Button>
            <Button type="button" disabled={!idle || blockReason !== null || lookupsPending} onClick={onStart}>{idle ? startButtonLabel(selection.count) : 'Starting…'}</Button>
          </>
        )}
      </div>
      {idle && blockReason && <p className="text-right text-xs text-muted-foreground" data-start-reason>{blockReason}</p>}
    </div>
  );
}

/** One card's row: its checkbox and label (type, number, info marker, title, what it waits for), its agent and, once sent, its result. */
function BulkStartRow({ row, isChecked, result, waits, phase, executors, commonId, overrides, now, onToggle, onOverride }: BulkStartBodyProps & { row: BulkRow; isChecked: boolean; result: RowResult | undefined; waits: string | null }) {
  const checkboxId = `bulk-start-row-${row.id}`;
  const override = overrides[row.id];
  const own = liveOverride(executors, override, now);
  const status = phase === 'idle' ? null : !isChecked && !result ? NOT_SELECTED_STATUS : rowStatusText(result);
  const pickerEnabled = rowPickerEnabled({ phase, checked: isChecked, result });
  const TypeIcon = row.kind === 'Bug' ? Bug : GitMerge;
  return (
    <li className="grid gap-1 border-b px-3 py-2 last:border-b-0" data-row={row.id}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Checkbox id={checkboxId} className="mt-0.5" checked={isChecked} disabled={row.locked || phase !== 'idle'} onCheckedChange={() => onToggle(row.id)} />
          <Label htmlFor={checkboxId} className="grid min-w-0 flex-1 gap-0.5 font-normal">
            <span className="flex flex-wrap items-center gap-1">
              <Badge variant={row.kind === 'Bug' ? 'soft-destructive' : 'secondary'}><TypeIcon aria-hidden="true" /> {row.kind}{row.number && ` ${row.number}`}</Badge>
              {row.needsMoreInfo && <Badge variant="warning">Needs more info</Badge>}
            </span>
            <span className="line-clamp-2 text-sm leading-5 [overflow-wrap:anywhere]" title={row.title}>{row.title}</span>
            {waits && <span className="text-xs text-muted-foreground" data-waits>{waits}</span>}
            {row.locked && <span className="text-xs text-muted-foreground" data-locked>{NO_WORKFLOW_NOTE}</span>}
          </Label>
        </div>
        <div className="min-w-0 sm:w-48 sm:shrink-0">
          {!commonId ? (
            <span className="text-xs text-muted-foreground">No agent</span>
          ) : pickerEnabled || phase === 'idle' ? (
            <CodingAgentPicker
              executors={executors}
              value={own ?? SAME_AS_ALL}
              onChange={(value) => onOverride(row.id, value)}
              id={`${checkboxId}-agent`}
              label={`Coding agent for ${row.title}`}
              inherit={{ value: SAME_AS_ALL, label: sameAsAllLabel(executors, commonId) }}
              compact
              disabled={!pickerEnabled}
              overridden={own !== null}
            />
          ) : (
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"><Bot className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{lockedAgentLabel(executors, commonId, override, now)}</span></span>
          )}
        </div>
      </div>
      {status && (
        result?.status === 'failed'
          ? <p role="alert" className="text-xs break-words text-destructive">{status}</p>
          : <p className="flex items-center gap-1 text-xs text-muted-foreground">{result?.status === 'starting' && <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />}{status}</p>
      )}
    </li>
  );
}
