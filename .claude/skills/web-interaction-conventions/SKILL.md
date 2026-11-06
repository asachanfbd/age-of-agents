---
name: web-interaction-conventions
description: React interaction-layer conventions for agent-visual-os's web app — the zustand data layer, popups, forms, and click/drag/hover handling. Use when building or changing UI interactions in web/src/ui/ or web/src/store/, or wiring the app to future server state.
---

# Web interaction conventions

Non-obvious conventions for agent-visual-os's `web/` interaction layer — things a fresh read of the code won't make obvious on its own.

## State

One flat zustand store, `web/src/store/worldStore.ts` — no nested/sliced stores. Add actions as plain functions inside the `create()` call; read via `useWorldStore((s) => s.field)` selectors, never destructure the whole store (avoids re-rendering every subscriber on unrelated changes).

## Pointer events fire on hover, not just while dragging

React Three Fiber dispatches `pointermove` on a mesh whenever the cursor crosses it — with or without a button held. Any drag handler reacting to `onPointerMove` must gate on an explicit boolean set on pointer-down and cleared on pointer-up (a ref, not state — state lags a frame). See the `threejs-scene-conventions` skill for the full pattern as used on draggable buildings.

## Click vs. pan/drag

To tell a real click from the tail end of a drag: record the pointer's client coordinates on pointer-down, compare against pointer-up, and only treat it as a click below a few pixels of drift. See `Ground.tsx`'s deselect-on-click handler for the reference implementation.

## Two popup surfaces, not one — don't merge them back

`DetailsPanel`/`BuildingDetailsPopup` (small, 3D-anchored) is **Home Base only** now (`selectedId` only ever means "Home Base's popup is open" — `'home'` or `null`). A click on a Project's dome calls `openWorkspace(projectId)` directly (`ProjectYard.tsx`'s `handlePointerUp`, through `openYardTarget`; a click on a yard item opens that item instead), opening `ProjectWorkspaceModal` (`web/src/ui/`) as a centered full-screen overlay — see [`docs/architecture.md`](../../../docs/architecture.md#a-buildings-click-opens-its-full-project-workspace-directly) for why the old two-step ("small popup, then an 'Open workspace' button") was collapsed into one. Keep it that way: a project building's `selected`/highlight state reads `workspaceProjectId`, not `selectedId` — don't route a project click back through `selectBuilding`, and don't add project content back into `DetailsPanel`. `BuildingDetailsPopup` still anchors to a building's actual 3D position via drei's `<Html>`, deciding its left/right side once when it opens (projecting the anchor to screen space and checking which half of the viewport it's on) rather than every frame, so it doesn't flip while the camera pans — reuse that anchor-in-3D-space pattern for any future in-scene (not full-screen) popup.

Centred popups get drag-to-resize from the shared `DialogContent` (`web/src/components/ui/dialog.tsx`, via `web/src/lib/useResizablePopup.ts`). Build new popups on it and set only their default size in `className`, not a hand-rolled resizer. After a drag, the dragged size is applied as inline `width`/`height`/`max-*` and wins over the class, which keeps the size cap (viewport minus 100px, with the status footer's height also taken off the height) in one place (`web/src/lib/popupResize.ts`). Size a popup's default height with `var(--popup-max-height)` (e.g. `h-[min(780px,var(--popup-max-height))]`), never a bare `dvh` value, so it stays clear of the status footer. Pass `sizeMemoryKey` to `DialogContent` to remember the dragged size per browser-window size in localStorage (`web/src/lib/popupSizeMemory.ts`); only a finished drag saves, restores never do.

Layers: popup scrims, dialogs, sheets and Radix poppers all use `z-[150]`, the status footer `z-[160]` and the global error alert `z-[170]`. Two Radix layers at the same z stack by mount order, so to put a sheet over an open dialog, mount it only while open rather than raising its z-index (a higher z would hide its own Select/Tooltip contents). Anything that must stay clickable over a modal needs `data-status-footer` or its own exclusion in `DialogContent`/`SheetContent`'s outside-interaction guard (`isStatusFooterTarget`), or the click dismisses the popup. A popper that can open near the bottom of the window needs `collisionPadding={{ bottom: STATUS_FOOTER_HEIGHT }}`, or it can open under the footer.

## The project popup has little vertical space

Plan every control in `ProjectWorkspaceModal` and its panels around height:

- Prefer single-row controls.
- No stacked labels or multi-line inputs in always-visible bars.
- Move rarely-used inputs into a dialog (`TaskDialogs.tsx`) or a collapsible section. The run view's approval bar is the reference: one row of prompt, Reject and Approve, with Reject's reason asked in `RejectStepDialog`.
- Combine tabs or toggles instead of adding rows.
- Keep fixed headers and footers to one row.
- Let the main content (terminal, markdown) take the remaining height.

## Keep three.js out of the non-3D UI

The project cards view (`'cards'` mode) exists so the browser never loads the 3D scene. `App.tsx` reaches the scene only through the lazy `ui/WorldView.tsx`. Code outside `web/src/scene/` must not import a scene module that pulls in `three`, `@react-three/*` or drei. Today `scene/townLayout.ts` and `scene/celestial.ts` are safe; `scene/skyKeyframes.ts` and every component are not. Anything both views need goes in `web/src/lib` or `web/src/ui`: the status dot is `lib/useProjectIndicators.ts` plus `ui/ProjectStatusDot.tsx`, and `ProjectYard.tsx` imports those, not the other way round. `web/tests/projectCardsView.test.mjs` pins this, and `.docs/testing.md` has the bundle check.

## Server types are hand-copied into `lib/serverApi.ts`

The web's `ServerTask`, `WorkflowRunRecord`, `ServerNotification` and their unions are copies of `server/src/domain/types.ts`, and nothing checks that the two still match. A server-side union member the web never uses compiles fine until some web code narrows on it. For example, `NotificationKind` was missing `'workflow.needs_attention'` until some later work filtered on it. When you consume a server field or union member in `web/`, compare the mirror with `server/src/domain/types.ts` first and add whatever is missing. `npx tsc -b` from `web/` catches the mismatch only once your code uses the member.

## Browser-only preferences

A setting that belongs to this browser rather than the daemon (theme, view mode, sound mute) gets its own `web/src/lib/<name>Preference.ts`. Wrap every localStorage read and write in try/catch and fall back to the default, because private modes can throw. Keep a cached value plus a listener set, and expose `get`/`set`/`subscribe` so `PreferencesSettings.tsx` can read it with `useSyncExternalStore`. Non-React code, such as `TaskSounds.tsx`'s `playTaskSound`, calls the getter when it acts, so a change applies straight away. Pass the storage in as an argument so tests can supply an in-memory or throwing one; see `lib/soundPreference.ts` and `web/tests/soundPreference.test.mjs`.

## Form state

Give a form/local-state component its own local `useState`, and force a remount when the thing it edits changes via `key={id}` from the parent — don't sync local state from a changing prop with a `useEffect`. That pattern trips oxlint's `set-state-in-effect` warning and causes an extra render for no benefit. See `ProjectWorkspaceModal.tsx`'s `<WorkspaceContent key={workspaceProjectId} .../>` (its tab/detail-view state resets cleanly on a project switch this way) and `TaskEditForm` in `ui/project-popup/TaskEditForm.tsx` (keyed by the task it edits).

## Cursor feedback

Set `document.body.style.cursor` directly in pointer handlers (`grab` on hover, `grabbing` on drag-start, `auto` on drag-end/pointer-out) — there's no cursor state in the store, and there doesn't need to be.

## The server is real — the store talks to it over REST + WebSocket

The daemon (`server/`) is built and running (`docs/roadmap.md`, Phase 1). Every store action that changes real state (`startTask`, `answerTask`, `stopTask`, `addProject`, `moveProject`, …) calls `lib/serverApi.ts` and folds the response into the store; live status pushes (project/task/log) arrive over `/ws` and are merged by the pure `mergeWorkerEvent(state, event)` — keep that function pure and exported so it stays testable without a real socket (see `web/tests/worldStore.test.mjs`). A `'log'` event is one turn in a Task's transcript; it's appended to `transcriptsByTask[taskId]`, creating the entry on first arrival rather than requiring `loadTranscript` to have run first, so a brand-new Task's first turns are never dropped.

An action's own HTTP response is not ordered against the WS feed, and the WS events often land first (for a terminal Task the daemon emits its settle events *before* responding). So never fold a response in blindly: `mergeTaskResponse` in `store/worldStore.ts` drops a Task response that isn't newer (`updatedAt`) than the stored copy, and only mirrors a Project to `'developing'` while the returned Task itself still is. Unconditionally setting `'developing'` from `answerTask`'s response is what once left a Project stuck "In development" after Mark Completed → No. Cover new actions with a test that delivers the WS events before the response resolves (`deliverEventsBeforeResponse` in `web/tests/worldStore.test.mjs`).

## Chat-style views read a Task's transcript, not just its latest status field

`ui/project-popup/TaskDetailsView.tsx` is the pattern for anything that shows a Task's back-and-forth (docs/roadmap.md's "wave-and-popover-into-chat" and "Task Execution & Tracking"): call `loadTranscript(taskId)` once (covers turns from before this tab connected) and read `transcriptsByTask[taskId]` afterward — it stays live via WS. Filter out `'raw-event'` turns before rendering; they're the full parsed `stream-json` stream (tool calls, thinking, etc.), not a chat message — surface them as a plain count instead. `loadTranscript` never lets a slow GET response regress turns a faster live `'log'` event already appended — it keeps whichever list is longer rather than blindly overwriting.
