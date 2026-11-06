/**
 * The fixed full-width status footer (`ui/StatusFooter.tsx`). Its height is taken out of the space every
 * popup, side sheet, toast and the error alert may use, so nothing ever covers it.
 */

/** The footer's height in px — the one source for both its own height and every offset that clears it. */
export const STATUS_FOOTER_HEIGHT = 46;

/** Marks the footer's root element, so popups can tell a click on it from a click outside them. */
export const STATUS_FOOTER_ATTRIBUTE = 'data-status-footer';

/**
 * Whether a popup's outside-interaction event started on the footer. Modal popups call
 * `preventDefault()` for these, so the footer — the bell included — stays usable without closing them.
 */
export function isStatusFooterTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return !!element?.closest?.(`[${STATUS_FOOTER_ATTRIBUTE}]`);
}
