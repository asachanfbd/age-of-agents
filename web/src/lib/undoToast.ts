import { toast } from 'sonner';

export const UNDO_TOAST_MS = 8000;
type Notify = (message: string, options: { duration: number; action: { label: string; onClick: () => void } }) => unknown;

/** A bottom-centre toast with an "Undo" pill; `onUndo` runs once when it is pressed. `notify` is sonner's toast, replaceable in tests. */
export function showUndoToast(message: string, onUndo: () => void, notify: Notify = toast): void {
  let used = false;
  notify(message, { duration: UNDO_TOAST_MS, action: { label: 'Undo', onClick: () => { if (!used) { used = true; onUndo(); } } } });
}
