/** The most lines an auto-growing textarea shows before it scrolls inside itself. */
export const AUTO_GROW_MAX_LINES = 5;

export interface AutoGrowInput {
  /** Height of the text alone (the element's scroll height minus its vertical padding), in px. */
  contentHeight: number;
  lineHeight: number;
  /** Lines at rest, and the floor while the content is shorter. */
  minLines: number;
  maxLines?: number;
}

export interface AutoGrowSize {
  lines: number;
  /** True once the content needs more than `maxLines`, so the textarea scrolls instead of growing. */
  scrolls: boolean;
}

/** How many lines tall a textarea should be for its content: at least `minLines`, at most `maxLines`. */
export function autoGrowSize({ contentHeight, lineHeight, minLines, maxLines = AUTO_GROW_MAX_LINES }: AutoGrowInput): AutoGrowSize {
  const max = Math.max(1, Math.floor(maxLines));
  const min = Math.min(max, Math.max(1, Math.floor(minLines)));
  const needed = lineHeight > 0 && contentHeight > 0 ? Math.ceil(contentHeight / lineHeight - 0.01) : 0;
  return { lines: Math.min(max, Math.max(min, needed)), scrolls: needed > max };
}
