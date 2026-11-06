# Town groups (2D view)

The non-3D view shows the same 240 plots as the 3D town, laid out as streets. Street, side and slot are derived from a project's stored `position`; nothing extra is stored.

## Mapping

Code: `web/src/scene/townLayout.ts` (the plot generator), `web/src/lib/townGroups.ts` (pure mapping and rules), `web/src/ui/ProjectCardsView.tsx` (view), `web/src/store/worldStore.ts` (`moveProjectToSlot`, repair on load), `server/src/projects/townPlots.ts` (server plot table).

- The town is 12 streets. Each street has a **left** and a **right** side of 10 slots, so 12 × 2 × 10 = 240 project plots (`PROJECT_CAPACITY`). City Center (the Catalog) stands on the cross road in the middle and is not a project plot.
- **Street n** is numbered outward from City Center, alternating between the north half (odd numbers) and the south half (even numbers). **Slot 1–10** counts outward from the cross road. A slot is named "Street 3, Left, slot 4".
- **Orientation.** The default 3D camera (`DEFAULT_VIEW` in `web/src/scene/defaultView.ts`, 36° above the horizon, at (40.9, 39.97, 40.9) looking at (2, 0, 2)) sits on the +x/+z diagonal, so on screen +x runs right-and-down and +z runs left-and-down. The 2D view is drawn as a plain top-down map with +x to the right and +z downward. Left is the street's side at smaller x. Every yard faces its street.
- The view is a pinned Catalog card, then one card per street with the left side, the road and the right side. Empty streets collapse to one line. A search box matches a project name or a street number, and "Only streets with projects" hides empty streets. The top bar reads "N projects · 12 streets" and warns when the map is nearly full (216 plots) or full (240).

## Moving

- A move targets one exact empty slot. Occupied slots, the Catalog and gaps refuse the drop; the card returns. No swapping.
- The move is applied at once and saved with `PATCH /api/projects/:id`. If the server refuses, the card goes back (unless a newer move or live update has already changed it) and an error notification appears.
- Keyboard: Space picks up (Enter still opens the workspace when not moving); arrows go to the previous/next empty slot in reading order without wrapping (left side then right side of a street, then the next street); Enter or Space drops; Escape cancels. Announcements are in an `aria-live` region ("Street 3, Left, slot 2, empty").
- The "Move to…" menu lists free slots by street ("No free slots" when full). Touch has no drag; it uses this menu.
- A resize or Escape during a pointer drag cancels it.
- 3D drags are unchanged: they snap to the nearest free plot, then save that exact plot.

## Position contract

`PATCH /api/projects/:id` with `{ position: [x, z] }`:

| Status | When |
|---|---|
| 200 | The position is within 0.001 of one of the 240 project plots (or of a block-grid plot from earlier versions, which is moved to its street plot) and no other project holds it (including the project's own plot). The stored value is the exact plot. |
| 400 | Not an array of two finite numbers, or not a project plot, or `position` missing. |
| 404 | Unknown project (checked after the position is validated). |
| 409 | Another project holds that plot. |

Errors use the usual `{ error }` body. The check and write run inside the project store's serialized queue, so two simultaneous moves to one plot give one 200 and one 409. `POST /api/projects` is unchanged.

## Legacy data

Earlier versions had 32 plots in a grid of blocks. Positions saved on those are moved once to the 32 street plots nearest City Center, in the old reading order, so saved projects keep their relative order and none is lost. The daemon does this at startup (`migrateLegacyPositions`), and the web app does it on load for anything still on the old grid; a second run finds nothing to move. The block-grid coordinates never coincide with a street plot, so a migrated position is never moved twice.

On load, projects with a missing position, a position that is not a plot, or one shared with an earlier project are moved to the nearest free plot (the same rule new projects use) and the change is saved. The first of two sharing a plot keeps it. Projects beyond 240 stay unplaced.
