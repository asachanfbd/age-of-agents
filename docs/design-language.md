# Design language

One visual language for the whole web app, taken from a reference CRM dashboard: a warm cream canvas, large white cards, charcoal primary actions, four stage accents and the Outfit typeface. Only the look is copied, not the reference's data.

## Tokens

- `web/src/styles/shadcn.css` is the single token source: `--sc-*` custom properties for light (`:root`) and dark (`.dark`), mapped to Tailwind utilities in `@theme inline` (`bg-card`, `text-muted-foreground`, `bg-stage-green`, `bg-success/15`, `rounded-card`, `shadow-soft`, `bg-scrim`, `bg-toast`).
- Status tokens: `success`, `warning`, `destructive`, `info`. Each `*-foreground` is the status' text colour (readable on a card and on a tint of itself). Stage accents: `stage-yellow|green|orange|charcoal`, each with a foreground (dark text on yellow). `brand` is the deliberate cyan accent.
- `.glass` is the translucent, blurred surface for HUD pieces over the 3D scene (top bar, status footer and its popovers, notifications). `.canvas-warm` is the cream canvas with its faint glow, used by the Building popups.
- `index.css` aliases the older HUD variable names (`--bg`, `--text`, `--text-dim`, `--panel-border`, `--accent-strong`) to these tokens.
- Outfit is bundled through `@fontsource/outfit` (no network font); code and terminals keep monospace.
- Dark mode is class-based (`lib/uiTheme.ts`). Contrast of the text/background and accent/foreground pairs is checked against WCAG AA in `tests/designSystem.test.mjs`.

## The colour rule

Surfaces in `web/src/ui/`, `web/src/components/` and the class strings in `web/src/lib/` use theme tokens only: no raw Tailwind palette class (`bg-red-500`, `text-white`), no `dark:` palette variant, no hex or `rgb()` literal. `lib/themeRules.ts` defines the rule and `tests/designSystem.test.mjs` enforces it. Canvas libraries (xterm, sigma) read tokens through `lib/themeColour.ts`. The SEO internal-links graph's categorical node palette (`lib/seoInternalLinks.ts`) and the 3D scene's status colours are data colours and are outside the rule.

## Components

`web/src/components/ui/*` carries the restyled primitives (pill buttons and tabs with a sliding indicator, borderless 24px cards, tinted and dot badges, pill inputs with an icon slot, `NativeSelect`, the dark toast with a yellow action pill). `web/src/ui/design/` holds the reusable pieces: `PageHeader`, `KpiStat`/`KpiRow`, `Section`, `CardHeading`, `SegmentedControl`, `FilterChips`, `IconButton`, `ItemCard`, `StageProgress`, `AvatarStack`, `ScoreBar`, `ScoreRing`, `DataTable`, `StatusDot`, `BarChart`, `StageModal`. `lib/undoToast.ts` shows the Undo toast.

Every timestamp and planned or due time renders through `RelativeTime` (`ui/design/RelativeTime.tsx`): a relative label ("in 5m", "yesterday") with the exact local time on hover, in the Building's time zone where there is one. Clock times that are the point of a row (calendar session starts, working hours) use `formatExactTime` from `lib/sessionTiming.ts`.

Floating text panels use the shared card radius (`rounded-card`, 24px from `--sc-radius-card`), while small controls stay pill-shaped. Audit of floating panels:

- Changed to 24px: the toast (`components/ui/sonner.tsx`, action button stays pill) and the tooltip (`components/ui/tooltip.tsx`, padding `px-4 py-2` so text clears the corners).
- Intentional exception: the chart hover tip in `ui/design/Charts.tsx` keeps `rounded-2xl` (16px).
- Already smaller, unchanged: dropdown menu, select list and popover panels (`rounded-xl`, 18px) with `rounded-lg` items that sit inside them.

## Charts and motion

Reports draws the period comparison as a smooth line chart (current period solid with a light area fill, previous period dashed) and the by-channel and by-source breakdowns as rounded grouped bars, all from hand-built SVG in `ui/design/Charts.tsx` with token colours, a tooltip card and a hidden table for screen readers. The reports API gives only two period totals, so the line runs across the metrics rather than across days. A stage modal grows out of the card that was clicked (`lib/pointerOrigin.ts`), and every animation is switched off under `prefers-reduced-motion`.

## Not yet implemented

Waiting on a decision from the person:

- "N this month" counts on the Customer/Lost drop zones (no endpoint gives them). Dropping a card opens the contact on the Customer or Lost action.
- The document-style side sheet of the reference (the CRM has no invoices).
- "Move to <stage> >" in the Reachout and Expand Today modals (follow-ups have no stage).
- Rebuilding the individual Software tab bodies into KPI-and-card pages. Both Building shells have a `PageHeader` and KPI row (task counts for Software; keyword, sitemap, page and backlink counts for SEO, from data the tabs already loaded) and the SEO Settings content sits in a card; the other tab bodies keep their dense layouts.
