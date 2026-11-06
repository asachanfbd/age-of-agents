import { useCallback, useEffect, useRef, useState } from 'react';
import { Ellipsis, Trophy, UserX } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { crmApi } from '../../lib/crmApi';
import { BOARD_STAGES, columnCountLabel, columnHidden, COLUMN_FETCH_LIMIT, COLUMN_LIMIT, contactLabel, DROP_ZONES, emptyBoard, moveTargets, stageAccent } from '../../lib/crmBoard';
import type { BoardState, DropZoneKey } from '../../lib/crmBoard';
import { createBoardActions } from '../../lib/crmBoardActions';
import { queryParams, rowStatuses } from '../../lib/crmProspects';
import type { ListQuery } from '../../lib/crmProspects';
import { disabledTitle } from '../../lib/crmWorkspace';
import type { ContactDto, Stage } from '../../lib/crmTypes';
import { showUndoToast } from '../../lib/undoToast';
import { cn } from '@/lib/utils';
import { ACCENT_SOLID } from '../../lib/accent';
import { IconButton } from '../design/Buttons';
import { ItemCard } from '../design/Cards';
import { ChannelIcon } from './channelIcons';
import { errorText } from './crmHooks';
import { ErrorNote, StatusText } from './shared';

const TAG = 'rounded-full bg-current/20 px-2 py-0.5 text-[11px] font-medium';

function CardMenu({ contact, disabled, readOnly, onMove, onOpen }: { contact: ContactDto; disabled: boolean; readOnly: boolean; onMove: (to: Stage) => void; onOpen: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton aria-label={`Actions for ${contactLabel(contact)}`} tone="glass" className="size-7"><Ellipsis /></IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onOpen}>Open contact</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">{readOnly ? disabledTitle(true) : 'Move to…'}</DropdownMenuLabel>
        {moveTargets(contact.stage ?? 'New').map((stage) => (
          <DropdownMenuItem key={stage} disabled={disabled} onSelect={() => onMove(stage)}>{stage}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProspectCard({ contact, timeZone, disabled, readOnly, dragging, onDragStart, onDragEnd, onMove, onOpen, onOpenPending }: {
  contact: ContactDto; timeZone?: string; disabled: boolean; readOnly: boolean; dragging: boolean; onDragStart: () => void; onDragEnd: () => void;
  onMove: (to: Stage) => void; onOpen: () => void; onOpenPending: () => void;
}) {
  const channels = [...new Set(contact.channels.map((ch) => ch.type))];
  return (
    <ItemCard
      accent={stageAccent(contact.stage)}
      draggable={!disabled}
      onDragStart={(event) => { event.dataTransfer.setData('text/plain', String(contact.id)); event.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnd={onDragEnd}
      title={contactLabel(contact)}
      openLabel={`Open ${contactLabel(contact)}`}
      onOpen={onOpen}
      subtitle={contact.company ?? undefined}
      topLine={<span className="flex items-center gap-1.5">{channels.map((type) => <ChannelIcon key={type} type={type} />)}</span>}
      menu={<CardMenu contact={contact} disabled={disabled} readOnly={readOnly} onMove={onMove} onOpen={onOpen} />}
      lifted={dragging}
      aria-grabbed={dragging}
      className={cn(!disabled && 'cursor-grab active:cursor-grabbing', dragging && 'rotate-1 opacity-60')}
    >
      {rowStatuses(contact).length > 0 && (
        <div className="relative z-10 mt-1 flex flex-wrap gap-1">
          {rowStatuses(contact).map((status) => (
            status.kind === 'pending_reachout'
              ? <button key={status.kind} type="button" className={cn(TAG, 'hover:underline')} onClick={onOpenPending}>{status.label}</button>
              : <span key={status.kind} className={TAG}><StatusText status={status} timeZone={timeZone} /></span>
          ))}
        </div>
      )}
    </ItemCard>
  );
}

/**
 * The Prospects kanban: one column per stage. A card dragged to another column (or sent there from its "Move to…" menu)
 * moves at once and is saved with `setStage`; Undo moves it back. Each column loads a few cards and "Show all" fetches the rest.
 * Dropping on the pinned Customer or Lost zone opens that contact on the matching action.
 */
export function ProspectBoard({ projectId, query, readOnly, reloadKey, timeZone, onOpenContact, onOpenPending, onZoneDrop }: {
  projectId: string; query: ListQuery; readOnly: boolean; reloadKey: number; timeZone?: string;
  onOpenContact: (contactId: number) => void; onOpenPending: (contact: ContactDto) => void;
  onZoneDrop: (contactId: number, zone: DropZoneKey) => void;
}) {
  const disabled = readOnly;
  const [board, setBoardState] = useState<BoardState>(emptyBoard);
  const boardRef = useRef(board);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<Stage>>(new Set());
  const [dragging, setDragging] = useState<{ id: number; from: Stage } | null>(null);
  const [over, setOver] = useState<Stage | DropZoneKey | null>(null);
  const requestKey = JSON.stringify([projectId, query, [...expanded], reloadKey]);
  const requestKeyRef = useRef(requestKey);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const loading = settledKey !== requestKey;
  const loadToken = useRef(0);

  const setBoard = useCallback((update: (b: BoardState) => BoardState) => {
    boardRef.current = update(boardRef.current);
    setBoardState(boardRef.current);
  }, []);

  useEffect(() => {
    const token = ++loadToken.current;
    requestKeyRef.current = requestKey;
    void Promise.all(BOARD_STAGES.map(async (stage) => {
      const limit = expanded.has(stage) ? COLUMN_FETCH_LIMIT : COLUMN_LIMIT;
      const page = await crmApi.contacts(projectId, queryParams({ ...query, segment: 'prospect', stage, offset: 0, limit }));
      return [stage, { cards: page.rows, total: page.total }] as const;
    })).then(
      (columns) => { if (loadToken.current === token) { setBoard(() => Object.fromEntries(columns) as BoardState); setSettledKey(requestKey); setError(null); } },
      (failure) => { if (loadToken.current === token) { setError(errorText(failure)); setSettledKey(requestKey); } },
    );
  }, [projectId, query, expanded, requestKey, setBoard]);

  const actions = () => createBoardActions({
    setStage: (id, stage) => crmApi.setStage(projectId, id, stage),
    getBoard: () => boardRef.current, setBoard, invalidateLoads: () => { loadToken.current += 1; setSettledKey(requestKeyRef.current); },
    offerUndo: showUndoToast, reportError: setError, describeError: errorText,
  });

  const drop = (stage: Stage) => {
    if (dragging && !disabled) void actions().moveCard(dragging.id, stage);
    setDragging(null); setOver(null);
  };
  const dropOnZone = (zone: DropZoneKey) => {
    if (dragging && !disabled) onZoneDrop(dragging.id, zone);
    setDragging(null); setOver(null);
  };
  const allow = (target: Stage | DropZoneKey, accepts: boolean) => (event: React.DragEvent) => {
    if (!dragging || disabled || !accepts) return;
    event.preventDefault(); setOver(target);
  };

  return (
    <div className="grid gap-3" aria-label="Prospect board" aria-busy={loading}>
      <ErrorNote message={error} />
      <div className="flex gap-3 overflow-x-auto pb-1">
        {BOARD_STAGES.map((stage) => {
          const column = board[stage];
          const hidden = columnHidden(column);
          return (
            <section
              key={stage}
              aria-label={`${stage} column`}
              onDragOver={allow(stage, dragging?.from !== stage)}
              onDragLeave={() => setOver((o) => (o === stage ? null : o))}
              onDrop={(event) => { event.preventDefault(); drop(stage); }}
              className={cn('flex min-w-[15.5rem] flex-1 flex-col gap-2 rounded-card bg-secondary/70 p-3', over === stage && 'ring-2 ring-ring')}
            >
              <header className="flex items-center gap-2 px-1">
                <span aria-hidden className={cn('size-2.5 rounded-full', ACCENT_SOLID[stageAccent(stage)])} />
                <h4 className="m-0 text-sm font-semibold">{stage}</h4>
                <span className="rounded-full bg-card px-2 text-xs tabular-nums text-muted-foreground">{column.total}</span>
                <span className="ml-auto text-xs text-muted-foreground">{columnCountLabel(column)}</span>
              </header>
              <div className="flex flex-col gap-2">
                {over === stage && <div aria-hidden className="h-16 rounded-item border-2 border-dashed border-input" />}
                {column.cards.map((contact) => (
                  <ProspectCard
                    key={contact.id}
                    contact={contact}
                    timeZone={timeZone}
                    disabled={disabled}
                    readOnly={readOnly}
                    dragging={dragging?.id === contact.id}
                    onDragStart={() => setDragging({ id: contact.id, from: stage })}
                    onDragEnd={() => { setDragging(null); setOver(null); }}
                    onMove={(to) => void actions().moveCard(contact.id, to)}
                    onOpen={() => onOpenContact(contact.id)}
                    onOpenPending={() => onOpenPending(contact)}
                  />
                ))}
                {!loading && column.cards.length === 0 && over !== stage && <p className="m-0 px-1 py-3 text-center text-sm text-muted-foreground">No prospects in {stage}</p>}
              </div>
              {hidden > 0 && !expanded.has(stage) && (
                <button type="button" onClick={() => setExpanded((s) => new Set(s).add(stage))} className="mx-auto rounded-control border border-input bg-card px-4 py-1 text-sm hover:bg-accent">Show all {column.total}</button>
              )}
            </section>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-3" aria-label="Drop zones">
        {DROP_ZONES.map((zone) => {
          const Icon = zone.key === 'customer' ? Trophy : UserX;
          return (
            <div
              key={zone.key}
              onDragOver={allow(zone.key, true)}
              onDragLeave={() => setOver((o) => (o === zone.key ? null : o))}
              onDrop={(event) => { event.preventDefault(); dropOnZone(zone.key); }}
              className={cn('flex items-center gap-3 rounded-card border-2 border-dashed border-input px-5 py-3 text-sm text-muted-foreground', over === zone.key && 'border-ring bg-accent text-foreground')}
            >
              <Icon className="size-5" aria-hidden /><span><b className="text-foreground">{zone.label}</b> · {disabled ? disabledTitle(true) : zone.hint}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

