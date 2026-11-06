import { useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { canDragCard, canDropOn, dropAnnouncement, planBoardDrop, reorderPeers } from '../../lib/taskBoard';
import type { BoardCard, BoardColumn, BoardDrop, BoardDropTarget } from '../../lib/taskBoard';

/** What a card needs to take part in drag-and-drop. */
export interface CardDnd {
  draggable: boolean;
  dragging: boolean;
  /** Where the drop line shows while reordering its own column. */
  dropPosition: 'before' | 'after' | null;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** The dragged card would become a parent of this one if dropped now. */
  linkTarget: boolean;
  /** The card's middle band is a link drop zone; its top and bottom edges still reorder. */
  onLinkOver: (event: DragEvent<HTMLElement>) => void;
  onLinkLeave: (event: DragEvent<HTMLElement>) => void;
  onLinkDrop: (event: DragEvent<HTMLElement>) => void;
}

/** Linking a card by dropping it onto another: the dragged card becomes a parent of the card it lands on. */
export interface LinkDnd {
  canLink: (parentId: string, childId: string) => boolean;
  onLink: (parentId: string, childId: string) => void;
}

/** The middle share of a card's height that links; the rest, top and bottom, reorders. */
const LINK_ZONE = { from: 0.25, to: 0.75 };

function inLinkZone(event: DragEvent<HTMLElement>): boolean {
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
  return ratio >= LINK_ZONE.from && ratio <= LINK_ZONE.to;
}

/** What makes a whole column a drop target — see `BoardColumnView`. */
export interface ColumnDrop {
  active: boolean;
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

/** How many of `selector`'s cards in `container` sit above the pointer — the drop index. */
function cardsAbove(container: Element, selector: string, clientY: number): number {
  return [...container.querySelectorAll<HTMLElement>(selector)].filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.top + rect.height / 2 < clientY;
  }).length;
}

/**
 * Where the pointer is. A nested task dragged within Planning lands in the group list under the pointer
 * (`data-group-list`), or in no group when it's outside every list; anything else lands among the
 * column's top-level cards.
 */
function pointerTarget(event: DragEvent<HTMLElement>, column: BoardColumn, draggedGroup: string | undefined): BoardDropTarget {
  if (!draggedGroup || column !== 'planning') {
    return { column, index: cardsAbove(event.currentTarget, '[data-card]:not([data-nested=true])', event.clientY) };
  }
  const list = (event.target as Element).closest<HTMLElement>('[data-group-list]');
  return list
    ? { column, group: list.dataset.groupList, index: cardsAbove(list, ':scope > [data-card]', event.clientY) }
    : { column, index: 0 };
}

/**
 * The board's drag-and-drop: a whole card is dragged, and `planBoardDrop` decides what the drop means (a
 * top-level reorder, a reorder within one planning group, or Planning → Running to start it). `onDrop`
 * gets that decision.
 */
export function useBoardDnd<T extends BoardCard>(columns: Record<BoardColumn, T[]>, onDrop: (drop: BoardDrop<T>) => void, link?: LinkDnd) {
  const [dragged, setDragged] = useState<{ id: string; column: BoardColumn; group?: string } | null>(null);
  const [target, setTarget] = useState<BoardDropTarget | null>(null);
  const [linkTargetId, setLinkTargetId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  function endDrag() {
    setDragged(null);
    setTarget(null);
    setLinkTargetId(null);
  }

  function cardDnd(column: BoardColumn, card: T & Pick<BoardCard, 'locked'>): CardDnd {
    const peers = reorderPeers(columns[column], card);
    const index = peers.findIndex((peer) => peer.id === card.id);
    const reordering = target && dragged?.column === column && target.column === column && target.group === card.group;
    const lastIndex = peers.length - 1;
    return {
      draggable: canDragCard(column, card),
      dragging: card.id === dragged?.id,
      dropPosition: !reordering ? null : target.index === index ? 'before' : target.index === index + 1 && index === lastIndex ? 'after' : null,
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', card.id);
        setDragged({ id: card.id, column, group: card.group });
      },
      onDragEnd: endDrag,
      linkTarget: linkTargetId === card.id,
      onLinkOver: (event) => {
        if (!dragged || !link?.canLink(dragged.id, card.id) || !inLinkZone(event)) {
          if (linkTargetId === card.id) setLinkTargetId(null);
          return;
        }
        // Handled here, not by the column, so the drag doesn't also show a reorder line.
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'link';
        setTarget(null);
        setLinkTargetId(card.id);
      },
      onLinkLeave: (event) => {
        if (linkTargetId === card.id && !event.currentTarget.contains(event.relatedTarget as Node | null)) setLinkTargetId(null);
      },
      onLinkDrop: (event) => {
        if (!dragged || linkTargetId !== card.id) return;
        event.preventDefault();
        event.stopPropagation();
        const parentId = dragged.id;
        endDrag();
        link?.onLink(parentId, card.id);
      },
      onKeyDown: (event) => {
        if (!event.altKey || !['ArrowUp', 'ArrowDown', 'ArrowRight'].includes(event.key)) return;
        if (event.key === 'ArrowRight' && column !== 'planning') return;
        const destination: BoardDropTarget = event.key === 'ArrowRight'
          ? { column: 'running', index: 0 }
          : { column, group: card.group, index: event.key === 'ArrowUp' ? index - 1 : index + 2 };
        const drop = planBoardDrop(columns, card.id, destination);
        if (!drop) return;
        event.preventDefault();
        onDrop(drop);
        setAnnouncement(dropAnnouncement(drop, event.key === 'ArrowUp' ? 'up' : 'down'));
      },
    };
  }

  function columnDrop(column: BoardColumn): ColumnDrop {
    /** Accepting both dragenter and dragover makes the column the drop target straight away, however quickly the card is let go. */
    const accept = (event: DragEvent<HTMLElement>) => {
      if (!dragged) return;
      const next = pointerTarget(event, column, dragged.group);
      if (!canDropOn(columns, dragged.id, column, next.group)) {
        // Outside the nested task's own group: not a drop target, so letting go cancels the drag.
        if (target?.column === column) setTarget(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (target?.column !== column || target.index !== next.index || target.group !== next.group) setTarget(next);
    };
    return {
      active: target?.column === column,
      onDragEnter: accept,
      onDragOver: accept,
      onDragLeave: (event) => {
        if (target?.column === column && !event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null);
      },
      onDrop: (event) => {
        event.preventDefault();
        const drop = dragged ? planBoardDrop(columns, dragged.id, pointerTarget(event, column, dragged.group)) : null;
        endDrag();
        if (drop) onDrop(drop);
      },
    };
  }

  return { cardDnd, columnDrop, announcement };
}
