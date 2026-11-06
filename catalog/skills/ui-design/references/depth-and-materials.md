# Depth and materials

## Layers

- Toolbars, panels and sheets over content are translucent layers: `backdrop-filter: blur()` on a semi-transparent background, so content shows through.
- Heavier, darker materials mark structural regions. Lighter materials draw attention to interactive elements.
- Never stack a light translucent surface on another one.
- Larger surfaces get a stronger blur and a deeper shadow than small chips. Over busy content, use a heavier shadow.

## Modal and non-modal

- **Modal tasks**: a dimming scrim pushes the background back. For stacked sheets, dim each parent progressively.
- **Non-blocking panels**: translucency and an offset, with no scrim.

## Text over translucency

- Use higher contrast, a slightly heavier weight and slightly wider letter-spacing.
- Keep colour on solid layers.

## Sticky headers

Where a header overlaps scrolling content, prefer an edge fade or blur over a 1px divider.

## Accessibility fallbacks

- `prefers-reduced-transparency: reduce`: raise opacity and remove blur.
- `prefers-contrast: more`: near-solid background with a defined border.
