---
name: ui-design
description: Use when designing or mocking up any user interface: classifies the design's complexity and names which design references to read.
---

# UI design router

## 1. Classify first

Pick the highest tier that matches.

- **Tier 1 · Small**: adds or changes controls inside one existing view (a button, field, label, badge or column) with no new container. Read nothing else. Apply only the core rules below.
- **Tier 2 · Standard**: adds a new panel, dialog, popover, form, list or table, or changes 2 or more existing views. Read `references/layout-and-type.md` and `references/states-and-edge-data.md`.
- **Tier 3 · Complex**: adds a new screen or a multi-step flow, changes 4 or more views, or places UI over a busy or 3D background such as a canvas or scene. Read everything Tier 2 reads, plus `references/depth-and-materials.md`.

Topic triggers, at any tier:

- Anything appears, disappears or moves with animation: read `references/motion.md`.
- Anything is dragged, swiped, scrubbed, or is a draggable sheet: read `references/gestures.md`.

## 2. Report

The step summary must state the tier chosen, why, and the exact list of reference files read (or "none"), so token use can be audited.

## 3. Core rules

- Reuse the project's existing design tokens, components and patterns. Inspect them before inventing anything. No new font, colour or radius when an existing one fits.
- Every spacing, size and alignment value is a defensible pick from the project's scale, never arbitrary.
- Make the most important thing the most obvious, using weight, size and spacing together. Show the common path first; put advanced options one level deeper.
- Place controls next to what they affect. A control that needs a label to explain what it does has a weak mapping.
- Use direct, specific labels ("Progress", "Library"), not vague umbrellas ("Home", "Manage").
- Confirm only destructive, irreversible actions, and prefer undo. Validate inline, not only on submit.
- Each view answers four questions: where am I, what is here, where can I go, how do I get out. Never trap the user.
- If the element shows data, always show the empty state and one long-text case, even at Tier 1.
- Accessibility: visible focus, sufficient contrast, hit targets that are not tiny, nothing conveyed only by colour.
