import type { Accent } from './accent';
import type { ContactDto, FollowupDto, Stage } from './crmTypes';
import { REOPEN_STAGES } from './crmCustomers';

/** The Prospects board's columns, in pipeline order. */
export const BOARD_STAGES: readonly Stage[] = REOPEN_STAGES;
/** Contacts each column loads at first; "Show all" loads up to the server's page cap. */
export const COLUMN_LIMIT = 8;
export const COLUMN_FETCH_LIMIT = 200;

export const STAGE_ACCENT: Record<Stage, Accent> = { New: 'neutral', Contacted: 'yellow', Engaged: 'green', 'Meeting set': 'orange', Proposal: 'charcoal' };

/** A stage's accent; a missing or unknown stage reads as New's neutral tint. */
export const stageAccent = (stage: string | null | undefined): Accent => STAGE_ACCENT[stage as Stage] ?? 'neutral';

/** The "Move to…" choices for a card: every stage but its own. */
export const moveTargets = (stage: Stage): Stage[] => BOARD_STAGES.filter((s) => s !== stage);

/** One column as the server answered it: the cards loaded and how many the stage holds in all. */
export interface BoardColumn { cards: ContactDto[]; total: number }
export type BoardState = Record<Stage, BoardColumn>;
export const emptyBoard = (): BoardState => ({ New: { cards: [], total: 0 }, Contacted: { cards: [], total: 0 }, Engaged: { cards: [], total: 0 }, 'Meeting set': { cards: [], total: 0 }, Proposal: { cards: [], total: 0 } });

export interface Move { id: number; from: Stage; to: Stage; fromIndex: number }

/** Moves a card to the top of another column; null when the card is unknown or is already there (nothing to save). */
export function applyMove(board: BoardState, id: number, to: Stage): { board: BoardState; move: Move } | null {
  const from = BOARD_STAGES.find((stage) => board[stage].cards.some((card) => card.id === id));
  if (!from || from === to) return null;
  const fromIndex = board[from].cards.findIndex((card) => card.id === id);
  const card = board[from].cards[fromIndex]!;
  return {
    move: { id, from, to, fromIndex },
    board: {
      ...board,
      [from]: { cards: board[from].cards.filter((c) => c.id !== id), total: Math.max(0, board[from].total - 1) },
      [to]: { cards: [{ ...card, stage: to }, ...board[to].cards], total: board[to].total + 1 },
    },
  };
}

/** Puts a failed or undone move back where the card was. Only this card moves, so a later move of another card survives. */
export function rollbackMove(board: BoardState, move: Move): BoardState {
  const card = board[move.to].cards.find((c) => c.id === move.id);
  if (!card) return board;
  const restored = [...board[move.from].cards];
  restored.splice(Math.min(move.fromIndex, restored.length), 0, { ...card, stage: move.from });
  return {
    ...board,
    [move.to]: { cards: board[move.to].cards.filter((c) => c.id !== move.id), total: Math.max(0, board[move.to].total - 1) },
    [move.from]: { cards: restored, total: board[move.from].total + 1 },
  };
}

/** What Undo sends: the card back to the stage it came from. */
export const inverseMove = (move: Move): { id: number; stage: Stage } => ({ id: move.id, stage: move.from });

/** The contact panel's heading: the trimmed name, else the first channel handle. */
export const contactLabel = (c: { name: string | null; channels: ReadonlyArray<{ handle: string }> }): string => c.name?.trim() || c.channels[0]?.handle || 'Contact';
/** A calendar item's contact, labelled like the contact panel heading but by the item's own channel handle. */
export const itemContactLabel = (item: Pick<FollowupDto, 'contactName' | 'channelHandle'>): string =>
  contactLabel({ name: item.contactName, channels: item.channelHandle ? [{ handle: item.channelHandle }] : [] });
/** The Undo toast's text: "Support plan upgrade → Proposal". */
export const moveToastText = (c: Pick<ContactDto, 'name' | 'channels'>, to: Stage): string => `${contactLabel(c)} → ${to}`;

/** Contacts a column holds that are not loaded yet: what its "Show all N" pill brings in. */
export const columnHidden = (column: BoardColumn): number => Math.max(0, column.total - column.cards.length);

export const columnCountLabel = (column: BoardColumn): string => `${column.total.toLocaleString('en-US')} ${column.total === 1 ? 'contact' : 'contacts'}`;

/** The pinned drop zones: dropping opens that contact's detail on the matching action (marking needs a reason or a confirmation, not a stage). */
export const DROP_ZONES = [{ key: 'customer', label: 'Customer', hint: 'Drop to mark as customer' }, { key: 'lost', label: 'Lost', hint: 'Drop to mark as lost' }] as const;
export type DropZoneKey = (typeof DROP_ZONES)[number]['key'];
