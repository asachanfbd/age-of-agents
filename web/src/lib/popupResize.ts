import { STATUS_FOOTER_HEIGHT } from './statusFooter.ts';

/**
 * Gap kept between a popup and each edge pair of the space it's centred in — the window above the status
 * footer — so it never spills out of the window or touches the footer.
 */
export const POPUP_VIEWPORT_MARGIN = 100;

/** Smallest a popup can be dragged down to, so it can't collapse into an unusable sliver. */
export const POPUP_MIN_SIZE = { width: 320, height: 200 } as const;

export interface Size {
  width: number;
  height: number;
}

/** The largest a popup may grow in a viewport of this size: the space above the footer less the margin, never negative. */
export function maxPopupSize(viewport: Size): Size {
  return {
    width: Math.max(0, viewport.width - POPUP_VIEWPORT_MARGIN),
    height: Math.max(0, viewport.height - STATUS_FOOTER_HEIGHT - POPUP_VIEWPORT_MARGIN),
  };
}

/**
 * CSS custom properties carrying these rules to stylesheets and Tailwind classes, set on `:root` so
 * portalled popups can read them: the footer's height, the tallest a popup may be, and the vertical
 * centre of the space above the footer.
 */
export const POPUP_LAYOUT_CSS_VARS: Readonly<Record<string, string>> = {
  '--status-footer-height': `${STATUS_FOOTER_HEIGHT}px`,
  '--popup-max-height': `calc(100dvh - ${STATUS_FOOTER_HEIGHT + POPUP_VIEWPORT_MARGIN}px)`,
  '--popup-center-y': `calc((100dvh - ${STATUS_FOOTER_HEIGHT}px) / 2)`,
};

export function applyPopupLayoutCssVars(root: { style: { setProperty(name: string, value: string): void } }): void {
  for (const [name, value] of Object.entries(POPUP_LAYOUT_CSS_VARS)) root.style.setProperty(name, value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, Math.min(min, max)), max);
}

/** Clamps a requested popup size between `POPUP_MIN_SIZE` and `maxPopupSize(viewport)`. */
export function clampPopupSize(requested: Size, viewport: Size): Size {
  const max = maxPopupSize(viewport);
  return {
    width: Math.round(clamp(requested.width, POPUP_MIN_SIZE.width, max.width)),
    height: Math.round(clamp(requested.height, POPUP_MIN_SIZE.height, max.height)),
  };
}

/**
 * The size a centred popup should take while its corner is dragged by `delta` from `start`. The popup
 * stays centred, so it grows on both sides — doubling the delta keeps the dragged corner under the pointer.
 */
export function resizedPopupSize(start: Size, delta: { x: number; y: number }, viewport: Size): Size {
  return clampPopupSize({ width: start.width + delta.x * 2, height: start.height + delta.y * 2 }, viewport);
}
