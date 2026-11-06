# States and edge data

Mock up worst-case data next to the happy path. Values must be realistic or taken from real schema and length limits, never random strings.

## What to show

- **Text**: very long names, one-letter names, non-Latin scripts, emoji, and strings with no break points such as long emails or URLs.
- **Missing data**: optional fields empty, and values at the real schema or length limit.
- **Numbers**: 0, exactly 1 (pluralisation), and huge counts.
- **Collections**: 0 items, 1 item, and 1,000+ items. Does the list need pagination or virtualisation?
- **Labels**: long translated button, badge and status labels.
- **Async**: loading and error states.

## Where to check

- 320px wide.
- The container's real width.
- The widest layout.
- 200% zoom.
- Dark mode and right-to-left, where the product supports them.

## Classify what you find

- **Broken**: unreadable, an unreachable action, or wrong data.
- **Ugly**: readable but visibly wrong, such as a wrapped badge or a squished avatar.
- **Fragile**: one realistic change from breaking, such as a field with no length limit.

List every issue under its class in the step summary, with the fix chosen for each.
