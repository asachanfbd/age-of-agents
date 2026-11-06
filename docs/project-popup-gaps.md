# Project popup: what is not built yet

The project popup (`web/src/ui/ProjectWorkspaceModal.tsx` and `web/src/ui/project-popup/`) was rebuilt on 2026-09-21 to match the approved template in `templates/project-popup.html`. This file lists what the design shows or implies that the app cannot do yet, and the behaviour that changed on the way. Nothing here is hidden: each missing feature is either disabled with a "coming soon" tooltip or absent from the UI, as noted.

## Shown disabled

| Feature | Where | What is missing |
| --- | --- | --- |
| View diff | Code tab header | A daemon endpoint that returns only the changed files and only their changed hunks, so the UI can render one unified diff (no side by side). The button is in place. |
| New file / new folder | Code tab tree | The Code tab is read-only. The two icons are there but disabled. (Documents has both working.) |
| Delete a planning session | Planning row | No endpoint deletes a planning session. Archive works. |
| Delete a completed task with no plan item | Completed row | Only completed plan items can be deleted. A finished task that never belonged to a plan item (an old freeform run) has no delete endpoint. |
| Attach file | Prompt | No attachment handling in task creation or planning. |

## Not in the UI at all

- **Effort size (XS to XXL).** Designed as a tag and a summary segment. There is no `size` on plan items, so nothing renders. When it exists, add it to `TaskRow` tags and to `rowSummaryParts` in `web/src/lib/projectTasks.ts`.
- **Executing state from the prompt.** The old composer had "Add" and "Execute now", plus a Template, Skills and autonomy picker for tasks. The new prompt only adds a task (as designed). To run one, add it and press play. Template and Skills selection for a task has no UI now, although the daemon still accepts `templateId` and `skillIds`.

## Behaviour worth knowing

- **Pause is Stop.** Pausing a running task stops it. For an interactive CLI task that exits the CLI and leaves a saved session, shown as "Paused". Play then resumes that session and opens the terminal panel. A non-CLI task cannot be resumed; it shows "Stopped" and play re-runs it.
- **Worker.** **Updated (task 5.016):** the coding agent is chosen only in the Start task dialog, every time a task starts — there is no Add-task picker and no separate Assign worker action any more. The dialog always pre-selects the available agent with the most remaining usage, ignoring any agent a planning session or earlier code left on the item; the item's own `executorId` is written only once it actually runs, and is then locked for any re-run.
- **Mark complete** works the same from the open tasks list (row or bulk) and the session view. It refuses while a task is running for it. A paused terminal session completes through `POST /api/tasks/:taskId/complete`; from the list, that session opens. Any other item (never started, failed, structured) has no session to document and is set done directly; one never started has no session to open. Both entry points decide this with `completesViaSession` in `web/src/lib/projectTasks.ts`, so a new "Mark complete" button should use it too. **Updated 2026-09-26 (task 3.012):** the old docs-and-retro completion question is gone — an executed PlanItem now runs through its Project's Workflow, ending in a built-in Complete stage (commit, push, PR) rather than a per-task completion confirmation. See `docs/architecture.md`'s "Configurable task Workflows" entry.
- **Run docs & retro** appears on a task's row and next to "Stop task" in the session view while a coding session waits for input, and hides once the pass has been sent. Stopping the session after that marks the task completed rather than paused. Both entry points use `canRunDocsRetro` in `web/src/lib/projectTasks.ts`; the daemon side is described under "Task lifecycle" in `server/README.md`.
- **Swimlanes and priority.** Open tasks are grouped into In Progress (running or waiting for input), then High, Medium and Low priority lanes. A task is dragged by its grip, or moved with ↑/↓ while the grip is focused, to reorder it within its lane or drop it into another priority lane. In-progress tasks cannot be dragged. Priority can also be set from a row's menu. A drop saves through `PUT /api/projects/:id/plan-items/order`, which lays out the whole target lane in one call. Lane and drop logic lives in `buildSwimlanes` and `planLaneDrop` in `web/src/lib/projectTasks.ts`. New tasks start at Medium.
- **Archive** is stored on an item's latest task, so an item that has never started cannot be archived.
- **Move to planning** was removed from the design.
- **Testing tab (task 2.006):** built on the daemon's normalized testing model (2.001-2.005) — the three Passed/Failed/Coverage stat cards distinguish "Not reported" from a real reported zero; every configured suite gets a row with its latest state, counts/metric summary, duration, relative time, trigger and branch/Task context; "Run all" enqueues every enabled suite's primary action (guarded against double-enqueue once the whole batch is already active) alongside per-suite access to its alternates and utility actions; the queue's Stop/Cancel and a running run's Stop all confirm first; a run's detail drawer renders whichever of cases/metrics/findings the result actually carries (not a hardcoded switch on suite kind) and streams its log live over `/ws` with ANSI colors (`lib/ansi.ts`'s `parseAnsi`), kept readable after the run settles; the setup approval gate (task 2.005) shows inline in the tab itself — the same read-only notice and round-aware Approve/Request changes/Reject as the run detail view's own gate (`SetupProposalDecision.tsx`, shared by both) — not only via a link-out. **Not yet implemented:** execution/dependency graphs (frameworks don't expose consistent instrumentation for it — an explicit scope cut, not an oversight); "load more" pagination on run history (a fixed recent-N list for now; the server's `listTestRuns` already supports `offset` for when this is wanted); a dedicated WS signal for "an ordinary Task just edited `.docs/testing/config.json`" (the tab instead reconciles off that Task settling, via `lastTaskSignature` in `lib/testingPanel.ts`).
- **Extra status tags** beyond the designed Queued / Executing / Paused: "Needs input" (blocked), "Failed" and "Stopped".
- **Theme.** The popup follows the app's existing light, dark and daytime preference. No second toggle was added.
- **Palette.** The shared shadcn tokens are now stock neutral, so every modal that uses them changed colour, not just this popup. `web/src/styles/shadcn.css` holds the values. Button, Badge, Tabs, Checkbox, Dropdown menu and Dialog recipes were updated to match the template.

## Daemon changes made for this

- `PATCH /api/plan-items/:id` accepts `status: "done"` and `archived`. **Updated (task 5.016):** it no longer accepts `executorId` — that action (and its "Assign worker" dialog) is gone; the agent is chosen only in the Start task dialog (`POST /api/plan-items/:id/execute`'s own `executorId`).
- Docs endpoints for the whole `.docs/` folder: `GET /projects/:id/docs/tree`, `GET` and `PUT /projects/:id/docs/file`, `POST /projects/:id/docs/entries`. The Code tab has the matching `POST /projects/:id/code/entries`, and `GET /projects/:id/code/tree` now also returns `folders`.
- The running daemon must be restarted to pick these up.

## Left in place but no longer used by the web app

These still work and have tests, but nothing in `web/` calls them now. Remove them if they stay unused.

- `GET /projects/:id/documents` and `GET /projects/:id/documents/plan/:name` (`server/src/projects/documents.ts`)
- `GET` and `PUT /projects/:id/blueprint`
- `PUT /projects/:id/plan/docs/:key`

## Not checked in a browser

Verified visually against a throwaway daemon: every tab in light and dark, the row hover states, and the row and bulk menus. Not exercised: the Executing and Needs input states, the live terminal panel, command logs, and branch checkout, since those need a running agent or a git remote.
