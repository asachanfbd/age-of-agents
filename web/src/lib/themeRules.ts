/**
 * The theme rule for `src/ui/`: every colour comes from a theme token (`bg-card`, `text-muted-foreground`,
 * `bg-stage-green`, `var(--sc-*)`), so light and dark both work and a palette change touches one place.
 * A raw Tailwind palette class, an arbitrary hex/rgb value or a hex/rgb literal is a violation.
 */
const PALETTE = 'red|amber|green|emerald|blue|slate|gray|zinc|neutral|stone|orange|yellow|sky|indigo|violet|purple|pink|rose|teal|cyan|lime|fuchsia|black|white';
const UTILITY = 'bg|text|border|ring|from|via|to|fill|stroke|outline|divide|accent|decoration|shadow';

export const RAW_COLOUR = new RegExp(
  [
    `\\b(?:${UTILITY})-(?:${PALETTE})(?:-\\d{2,3})?(?:/\\d+)?\\b`,
    `\\b(?:${UTILITY})-\\[(?:#|rgb|hsl|oklch)[^\\]]*\\]`,
    `var\\(--color-(?:${PALETTE})-\\d{2,3}\\)`,
    '#[0-9a-fA-F]{6}\\b',
    '#[0-9a-fA-F]{3}(?![0-9a-zA-Z])',
    'rgba?\\([^)]*\\)',
  ].join('|'),
  'g',
);

/** Every raw colour in a source text. */
export const rawColours = (text: string): string[] => text.match(RAW_COLOUR) ?? [];
