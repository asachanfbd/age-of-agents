import { applyMove, inverseMove, moveToastText, rollbackMove } from './crmBoard';
import type { BoardState, Move } from './crmBoard';
import type { Stage } from './crmTypes';

/** What the board's moves need from the outside, so the optimistic-move rules can be exercised without a screen. */
export interface BoardDeps {
  setStage: (contactId: number, stage: Stage) => Promise<unknown>;
  getBoard: () => BoardState;
  /** Replaces the board with `update(current)`; later calls see the earlier result. */
  setBoard: (update: (board: BoardState) => BoardState) => void;
  /** Ends any load still in flight, so a stale answer cannot overwrite the move. */
  invalidateLoads: () => void;
  offerUndo: (text: string, undo: () => void) => void;
  reportError: (message: string | null) => void;
  describeError: (error: unknown) => string;
}

/**
 * Dragging a card (or choosing "Move to…") moves it at once, then saves; a failed save puts only that card back and
 * says why. A saved move offers Undo, which moves the card back the same way. Dropping on the card's own column does nothing.
 */
export function createBoardActions(deps: BoardDeps) {
  const save = async (move: Move, direction: 'forward' | 'back'): Promise<boolean> => {
    const target = direction === 'forward' ? move.to : inverseMove(move).stage;
    try { await deps.setStage(move.id, target); return true; }
    catch (error) {
      deps.setBoard((board) => (direction === 'forward' ? rollbackMove(board, move) : applyMove(board, move.id, move.to)?.board ?? board));
      deps.reportError(deps.describeError(error));
      return false;
    }
  };

  const undo = async (move: Move): Promise<void> => {
    // The card moved again since the toast: Undo has nothing left to undo, and the server must not be told otherwise.
    if (!deps.getBoard()[move.to].cards.some((card) => card.id === move.id)) return;
    deps.invalidateLoads();
    deps.reportError(null);
    deps.setBoard((board) => rollbackMove(board, move));
    await save(move, 'back');
  };

  const moveCard = async (contactId: number, to: Stage): Promise<boolean> => {
    const result = applyMove(deps.getBoard(), contactId, to);
    if (!result) return false;
    const card = deps.getBoard()[result.move.from].cards[result.move.fromIndex]!;
    deps.invalidateLoads();
    deps.reportError(null);
    deps.setBoard(() => result.board);
    const saved = await save(result.move, 'forward');
    if (saved) deps.offerUndo(moveToastText(card, to), () => { void undo(result.move); });
    return saved;
  };

  return { moveCard, undo };
}
