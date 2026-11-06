/** The four stage accents plus a neutral track tint, as theme tokens: every stage or category colour in the app comes from here. */
export type Accent = 'yellow' | 'green' | 'orange' | 'charcoal' | 'neutral';

/** Fill and text classes of an item card painted with the accent: dark text on yellow, white (or cream in dark mode) on the others. */
export const ACCENT_FILL: Record<Accent, string> = {
  yellow: 'bg-stage-yellow text-stage-yellow-foreground',
  green: 'bg-stage-green text-stage-green-foreground',
  orange: 'bg-stage-orange text-stage-orange-foreground',
  charcoal: 'bg-stage-charcoal text-stage-charcoal-foreground',
  neutral: 'bg-secondary text-secondary-foreground',
};

/** The accent as a plain dot or bar colour. */
export const ACCENT_SOLID: Record<Accent, string> = {
  yellow: 'bg-stage-yellow', green: 'bg-stage-green', orange: 'bg-stage-orange', charcoal: 'bg-stage-charcoal', neutral: 'bg-muted-foreground',
};

/** The accent's fill as a CSS value, for SVG and style props that cannot take a class. */
export const accentVar = (accent: Accent): string => (accent === 'neutral' ? 'var(--sc-secondary)' : `var(--sc-stage-${accent})`);
