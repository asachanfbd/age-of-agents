/**
 * Which status-footer popover is open. At most one is: opening another replaces it. A popover opened by
 * hover or focus (`pinned: false`) closes again when that ends; a click pins it until a second click.
 */
export interface FooterPopoverState {
  id: string;
  pinned: boolean;
}

export type FooterPopoverAction =
  | { type: 'preview'; id: string }
  | { type: 'unpreview'; id: string }
  | { type: 'toggle'; id: string }
  | { type: 'close' };

export function footerPopoverReducer(state: FooterPopoverState | null, action: FooterPopoverAction): FooterPopoverState | null {
  switch (action.type) {
    case 'preview':
      return state?.id === action.id ? state : { id: action.id, pinned: false };
    case 'unpreview':
      return state?.id === action.id && !state.pinned ? null : state;
    case 'toggle':
      return state?.id === action.id && state.pinned ? null : { id: action.id, pinned: true };
    case 'close':
      return null;
  }
}

/** Delays so a pointer passing over a number doesn't flash its list, and can cross the gap into it. */
export const FOOTER_POPOVER_OPEN_DELAY_MS = 150;
export const FOOTER_POPOVER_CLOSE_DELAY_MS = 200;
