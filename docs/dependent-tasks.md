# Dependent tasks

A task can wait for other tasks. When the person starts it, it begins by itself once every parent's work is merged into the project's checked-out branch, so it always starts from real merged code.

## Defining dependencies

- A task depends on one or several other tasks of the **same project**, from any planning group or standalone. The picker offers ready tasks (pending, not started, not archived) first, then started tasks that are not finished: in progress, needs you, or done with the PR not merged (shown with a state badge). Merged, archived, failed, stopped, PR-conflict and testing-setup tasks are never offered (bug 10.018.001); a parent that has since started, finished or been archived stays listed on the child. No cycles, no self-dependency, at most 20 parents per task and chains at most 10 tasks long (`MAX_PARENTS`, `MAX_DEPENDENCY_DEPTH` in `server/src/projects/dependencies.ts`).
- The task details panel has a **Depends on** section: on a ready, unstarted task it adds and removes parents through a searchable picker (type to filter, list capped to the screen height); once the task started it is read-only. A project without a linked repository shows it disabled with the reason.
- Planning groups have a **Chain tasks** action (group card, once expanded and with two or more ready tasks): each ready task depends on the previous ready task in the group's order, optionally with auto-merge turned on for all of them. Group order, numbers, titles and branches do not change.
- Cards show a "Depends on #12, #13" chip when the task has parents. Cards have no menu in the current UI, so a ready card carries a small **Depends on…** action that opens an inline searchable popover (ready or started-unmerged, unarchived, same-project tasks that are not already parents and would not make a cycle) and links in one step. Dropping a card on the middle half of another card also links them: the dragged card (ready or running) becomes the **parent** of the card it lands on, which must be ready. The top and bottom edges of a card still reorder. Link drops work across groups and between nested and top-level cards, and are refused without a linked repository; the daemon still validates cycles and the depth cap. The details view keeps its own parent select.
- Chain tasks links only ready tasks that are not already waiting; waiting and started tasks keep their dependencies.

## When a parent is satisfied

Evaluated against the branch checked out **at that moment** in the project folder. A parent is satisfied when its run completed and any of these hold:

1. its last commit (its branch head) is in the checked-out branch;
2. its pull request's resulting merge commit is in that branch (squash and rebase merges, done by hand on GitHub, leave a different commit than the branch head);
3. it finished with nothing to merge: no pull request was raised and its branch adds no commits to its base, or it ran in the project's own folder.

A parent that is re-run or given Request changes after being counted goes back to waiting. A parent merged into a different branch than the one checked out keeps the child waiting ("Different branch checked out than <branch>").

## Bugs and the Plan & bugs session

Bugs take part in dependency chains in both directions: a bug can wait on a task or a bug, and a task can wait on a bug. The same parent rules, picker (each option tagged Task or Bug), card chip, drag-link, Waiting and Blocked states, notifications, evaluation and **Start when parents are merged** apply. A ready bug that waits keeps its Planning placement until its start is accepted; a started waiting bug sits in Running with the Waiting badge, a blocked one in Needs you, like a task. A waiting bug starts with its Bug Fix workflow preselected. **Chain tasks** links tasks only; a session's bugs are left alone.

A **Plan & bugs** session sets parents with its `set_dependencies` tool (`PUT /api/agent-bugs/:itemId/dependencies`, see [Unified Planning board](unified-planning-board.md#plan--bugs)) on items it filed that have not started, so the work runs in the right order without linking by hand. Unlike the routes below, it also refuses a parent that is merged, archived, failed or stopped (409).

## Starting and waiting

- Start on a task whose parents are not all satisfied does not start a run. The Start dialog asks for the normal options, then confirms **Start when parents are merged**. The task moves to the Running column with a **Waiting** badge (**Blocked** when a parent blocks it). On the board a child is nested under the parent it waits for when both are in the same column, and a card whose parents are elsewhere lists them in its dependency line. Cancel waiting returns the task to Planning.
- **Cancel waiting** returns it to plain ready (dependencies and position intact).
- When the last parent is satisfied the daemon starts the task with the options chosen at Start, as a normal parallel run with its own worktree and branch off the checked-out branch. A rejected automatic start (usage limit, folder or git busy) leaves it Waiting with the reason; the next evaluation retries.
- Several children becoming ready at once start in planning order, then group order, then creation time.
- Reasons shown live on the card and in the details: waiting for a parent to finish; waiting for it to be merged; the parent isn't set to auto-merge (with a one-click toggle); waiting for the branch to receive the parent (pull needed, with Sync and the blocker of an automatic pull); different branch checked out.
- **Blocked**: a parent that failed, was stopped, needs input, was archived without being merged, or was deleted blocks the child ("Blocked: parent #12 failed"). The child never starts by itself; the person removes the dependency, retries or resumes the parent, or cancels waiting. A deleted parent's id stays in `dependsOn` until the person acts.

## Stacking

**Decision (B.020):** no task stacks. Every run branches from the Project's own branch and opens its PR against it; a dependent task gets its parents' work by waiting for their merges. Stacking onto the previous task's unmerged branch was removed because the PR base could be a branch that auto-merge had already deleted, which made `gh pr create` fail. Runs stacked before the removal keep the parent branch as their base and can still hit that failure; open the PR by hand or re-run the task.

## Auto-merge

With auto-merge on for a parent, a chain runs end to end without the person. Without it, the child waits for a manual merge from the PR tab and the branch to be updated (automatic pull or Sync). Dependencies work either way.

## Notifications

`dependency.started` (a waiting child started by itself), `dependency.blocked`, and `dependency.long_wait` (30 minutes waiting on a manual merge or pull). They are task-scoped notifications (subject type `autoMerge`) and are resolved when the task starts, is cancelled or deleted.

## API

All under `/api/projects/:id`; errors: 400 malformed, 404 unknown or out-of-project task, 409 cycle, self-dependency, depth cap, adding to a started task, or a project without a linked repository.

| Route | Purpose |
| --- | --- |
| `PUT /plan-items/:itemId/dependencies` `{ dependsOn: string[] }` | Replace the parents of a ready task |
| `GET /plan-items/:itemId/dependencies` | Each parent: `satisfied` and the `reason` |
| `POST /plan-items/:itemId/start-when-ready` (start options) | 201 `{ started: true, run }`, or 202 `{ started: false, item }` when it waits |
| `POST /plan-items/:itemId/cancel-waiting` | Back to plain ready; 409 when not waiting |
| `POST /planning-groups/:session/chain` `{ autoMerge? }` | Chain shortcut |

`POST /api/plan-items/:id/execute` answers 409 for a task that has dependencies or is waiting; the web uses `start-when-ready` for those.

## Evaluation

`server/src/projects/dependencyService.ts`. One evaluation at a time per project, idempotent (a task is started only if it is still ready and waiting). Triggers: a parent's run, plan item or deletion event; a project sync reading (pull, sync, branch switch); a dependency change; daemon start; and every 30 seconds. State (`dependsOn`, `waiting`) is on the plan item, so it survives restarts.

## Not covered

Stacked PRs, dependencies across projects, scheduling by time, automatic retry of failed parents, project-level defaults. Not verified: a real three-task chain against a throwaway repository with real `gh`, and the UI in a browser (both themes, narrow width).
