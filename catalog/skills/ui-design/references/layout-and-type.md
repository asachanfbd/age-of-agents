# Layout and type

## Typography

- Tracking depends on size. Large display text gets negative tracking (about `-0.02em`), body text stays near `0`, small text gets slightly positive tracking.
- Leading runs inverse to size: about `1.05` for large headings, about `1.5` for body, tighter in dense UI.
- Use weight for emphasis. It adds presence without taking space.
- Size in `rem`/`em` so the layout scales with the user's text size.
- Default to the project's font, or `system-ui` if it has none.

## Grouping

- Proximity implies relationship: things that belong together sit close, and unrelated things get clear space between them.
- The layout of controls mirrors the layout of what they change. If a toggle affects the left column, it lives by the left column.

## Feedback kinds

Pick the kind that matches the moment:

- **Status**: something is ongoing. Show it while it runs.
- **Completion**: a meaningful action finished. Confirm it.
- **Warning**: a problem is about to happen. Say so before it does.
- **Error**: something failed. Say what, and what the user can do next.

## The eight foundations

1. **Purpose**: decide what not to build.
2. **Agency**: offer choices and undo.
3. **Responsibility**: ask for permissions at the right moment. For risky AI actions, add previews or confirmations.
4. **Familiarity**: things that look alike behave alike and live in the same place.
5. **Flexibility**: support touch and precise pointers, all abilities, and long translations.
6. **Simplicity**: this is not minimalism. Sometimes adding context makes a thing simpler.
7. **Craft**: support light and dark, and keep icons aligned.
8. **Delight**: it comes from the other seven, not from decoration. Pick the intended emotion and reinforce it.
