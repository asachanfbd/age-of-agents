# Motion

## Whether to animate

Frequency decides:

- 100+ times a day, or anything triggered from the keyboard: no animation.
- Tens of times a day (hover, list navigation): minimal or none.
- Occasional (modals, drawers, toasts): standard.
- Rare or first-time: delight is fine.

Every animation needs a purpose: spatial consistency, state change, explanation, feedback, or avoiding a jarring appearance.

## Easing

- Enter and exit: `ease-out`.
- Moving or morphing on screen: `ease-in-out`.
- Hover or colour: `ease`.
- Constant motion: `linear`.
- Never `ease-in` for UI.

Strong curves:

- ease-out: `cubic-bezier(0.23, 1, 0.32, 1)`
- ease-in-out: `cubic-bezier(0.77, 0, 0.175, 1)`
- drawer: `cubic-bezier(0.32, 0.72, 0, 1)`

## Durations

- Button press: 100–160ms.
- Tooltip or small popover: 125–200ms.
- Dropdown: 150–250ms.
- Modal or drawer: 200–500ms.

Keep UI under 300ms, and make exits faster than entries.

## Components

- Pressables get `scale(0.97)` on `:active`.
- Entrances start from `scale(0.95)` plus `opacity: 0`, never `scale(0)`.
- Popovers grow from their trigger (`transform-origin`); modals grow from the centre.
- Things exit along the path they entered by.
- After the first tooltip, later tooltips appear instantly.
- List items stagger 30–80ms apart and never block input.

## Properties

- Animate only `transform` and `opacity`.
- Name exact properties; never `transition: all`.
- Gate hover effects behind `@media (hover: hover) and (pointer: fine)`.

## Reduced motion

- Swap slides, springs and parallax for short opacity cross-fades.
- Keep colour and opacity changes.
- Avoid full-viewport moving backgrounds and slow looping motion.

## In a static mockup

Write motion as short annotations (property, duration, curve), not as working animation code.
