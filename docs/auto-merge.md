# Auto-merge

A task can merge its own pull request once it is done. The **Auto-merge** switch sits in the Task details header, per task, and is off by default. When it is on, the daemon merges the task's PR after the task's workflow has finished, using the PR tab's merge flow.

Code: `server/src/projects/autoMerge.ts` (pure rules), `server/src/projects/autoMergeService.ts` (the service), `web/src/lib/autoMerge.ts` (wording and view models), `web/src/ui/project-popup/AutoMergeControl.tsx` (switch, panel, board chip).

## When it merges

- Only after the Complete step has pushed and the PR exists. Auto-merge never bypasses a step: a workflow that ends in an approval step (for example a human approval step) is merged only after it is approved.
- Switched on while the task is still running, it waits for completion. Switched on after completion with the PR still open, it is evaluated at once.
- It merges the task's own PR (the one in the run's PR link), never another.
- The switch is unavailable, with a reason, for a project with no linked repository and for a run without its own branch. Turning it off is always possible.
- A conflict run is waited on inside the project's turn, for at most six hours per look. After that the turn is released so the project's other merges can go ahead, and the next look (every minute) waits again.
- Merges in one project happen one at a time, so each PR is read against the base as the previous merge left it. A PR that was clean may then conflict and goes through the conflict path.

## Merge rules (careful mode)

| PR as the provider reports it | What Auto-merge does |
| --- | --- |
| Clean | Merges with a merge commit and deletes the remote head branch, exactly as the PR tab does. |
| Conflicting | Starts a conflict-resolution run with the agent chosen below. After the agent pushes and the PR re-checks as mergeable, the run merges it. |
| Any other blocker: failing or pending *required* checks, requested changes, review required, draft, base protection, unknown state | Never overridden. The task waits as "Awaiting merge: blocked" with the reasons and raises a notification. When the cause clears at a later check, Auto-merge continues by itself. The person can also merge from the PR tab, with its warning-and-confirm flow. |
| Cannot be merged at all: closed, no permission, head branch gone | Auto-merge stops with that reason. The switch stays on; nothing happens until the person acts. |

A conflicting PR that also has blockers resolves its conflicts first. The blockers are checked afterwards.

### Which checks block

GitHub's own rule: only checks the base branch requires (branch protection or rulesets) block a merge.

- A failing (failure, error, timed out, cancelled) required check blocks as "Checks are failing: build, lint". A pending or expected required check (required but not reported yet) blocks as "Checks are still running: build". Names are listed three at a time, then "+N more".
- A check that is **not** required never blocks. It shows as a warning line, "Optional checks failing: Vercel" or "Optional checks running: docs", in the task's Auto-merge panel (in any state, including Waiting and Merged) and in the PR tab row. The warning never changes the state, the tone or whether Merge asks for confirmation.
- No protection or no required checks: checks never block.
- If the daemon cannot tell which checks are required (GitHub does not return the flag, or the PR has more checks than one page of 100), every non-passing check blocks, and the blocker ends "(could not tell which checks are required)". An unknown state is never clean.
- The confirmed-merge bypass (`--admin`) is only for a PR-tab merge the person confirmed despite blockers. Auto-merge never uses it.

## Which agent resolves conflicts

1. The agent of the **Development step** (the workflow step with the id `development`).
2. If the workflow has no Development step, the agent of the **first step that can edit code**.
3. If a step has no agent of its own, or no step applies, the task's own (assigned) agent.

This applies only to Auto-merge. Merging from the PR tab still asks the person to choose an agent, with the shared coding-agent picker.

## States

These are shown in the details panel under the header and as a small chip on the board card, beside the completion state. They are stored with the task, so they survive reloads and daemon restarts.

| State | Meaning |
| --- | --- |
| Auto-merge on, waiting for the task to complete | The switch is on and the task has not finished. |
| Merging | The merge is running. |
| Resolving conflicts | The conflict run is working; the panel links to it. |
| Awaiting merge: blocked | A blocker is listed. Retried by itself. |
| Awaiting merge: can't reach the provider | `gh` is missing or signed out, or the network failed. Retried at the next evaluation. |
| Awaiting merge: agent unavailable | The chosen agent was removed or reached its usage limit. Retried when available; Retry is offered, and the person can merge from the PR tab with another agent. |
| Merged | Shows when, and what happened to the remote branch (deleted, a deletion warning, or left in place on purpose). |
| Auto-merge failed | The merge was refused or the conflict run failed or was stopped. The PR stays unmerged; Retry starts again. |
| No PR to merge | The Complete step raised no PR; the panel shows its error. |
| Can't be merged | The PR is closed, the account may not merge, or the branch is gone. |

## Where the task sits on the board

A finished task is Completed only once its PR is merged, Auto-merge on or off. The run and plan item still read `completed`/`done` (the daemon needs that to start the merge); the Tasks board holds the card back. With Auto-merge on, the daemon's auto-merge state decides:

- `waiting`, `merging`, `resolving`, `blocked`, `provider`, `agent`: the lower "PR not merged yet" row of the Needs you column (equal height to the upper row; each row scrolls on its own). Its cards open but can't be dragged.
- `failed`, `cannot-merge`, `no-pr`: the upper Needs you row, with the red dot, since you must act.
- `merged`: Completed, with the Merged chip.

### Auto-merge off: the task's own PR decides

With Auto-merge off, the daemon reads the task's own pull request from the Git provider (the newest PR whose head is the run's own branch in this repository; a fork's same-named branch is ignored) and stores the last successful reading on the plan item (`pullRequest`: `open`, `merged`, `closed` or `none`, with the PR number). The board maps it like this:

| Reading | Where the card sits |
| --- | --- |
| `open` | "PR not merged yet", with a "PR #N open" tag that opens that PR in the PR tab and a "Turn on Auto-merge" button (the task toggle's own action and disabled reasons) |
| `merged` | Completed, with the Merged badge (merged by hand, by Auto-merge or on the provider) |
| `closed` | Completed, with a "PR closed" badge; reopening the PR brings the card back at the next reading |
| `none` | Completed, no badge |
| never read | Completed, with a "PR status unknown" hint, until a reading succeeds |

A failed lookup (provider unreachable, `gh` signed out) changes nothing: the last reading keeps deciding, so cards do not flicker between rows. Only a task that ran its own workflow and raised its own PR is read: a task completed by hand, a conflict-resolution run, a testing-setup run, a project without a linked repository and a run on the project's own branch are never held. The details header of a held task reads "Waiting for PR merge", and the PR tab tags the PR with the task waiting on it. The progress bar counts a held task as in progress, not done.

Order inside "PR not merged yet": Auto-merge rows first in plan order, then the rows held only by an open PR, newest completion first, ties by planning task number.

Readings are refreshed with the daemon's 60 s timer, when a task's run completes and right after a merge from the PR tab. A project asks about at most 100 branches per refresh, 20 per provider call, 250 ms apart, never-read tasks first and then the least recently asked; merged tasks are not read again. No migration: existing completed tasks with an open PR move into the row at the first reading.

The footer's Needs you count includes the upper row only; the lower row has no count. "Archive all" in Completed archives only cards in Completed, never held ones; a single held task can still be archived by hand.

## Turning it off, and other cases

- Turning the switch off cancels any pending merge. A conflict run already working is not stopped, but when it ends nothing is merged; the person can merge from the PR tab.
- If the person merges the PR by hand first (or it is merged on GitHub), the task goes straight to Merged, also from Failed or Can't be merged. The panel then says the branch outcome is not known.
- A task that is deleted or archived while pending is cancelled without merging.
- Evaluations are idempotent: a restart, a poll or switch flips never merge twice or start a second conflict run for the same PR.
- After a merge the project's branch sync indicator is refreshed. Pulling the merged base into the checked-out branch stays with the automatic pull and the manual sync.
- The merge and the conflict run use the project's chosen GitHub account when one is set.
- The conflict run appears on the Tasks board titled "Auto-merge conflicts · <task title>". The PR tab row shows which task is merging the PR; Merge and Check out still work there.

## Notifications

Project-scoped, one per task, resolved when the state changes: blocked awaiting merge, conflict resolution failed, auto-merge failed (also raised for "No PR to merge" and "Can't be merged").

When a task's state becomes Merged while its switch is on, an info notification `automerge.merged` is raised on the same task subject: title "Auto-merge: <task title>", description "PR #<n> merged." plus the branch note or warning. This covers a merge by Auto-merge and a PR merged by hand (on GitHub or from the PR tab), which Auto-merge records as Merged. It resolves when the person opens or reads it, and raising it resolves the task's open blocked, failed and conflict-failed notifications. A switch turned off before the merge raises nothing, then or later.

## Sounds

- With Auto-merge on at the end of a task's run, the completion chime does not play. It plays once, with the notification above, when the state becomes Merged. If the switch is turned on after the run already ended, the run-end chime has played; the merge chime still comes.
- The "needs attention" horn plays once when the state enters one that raises a blocked, failed or conflict-failed notification (blocked, failed, can't be merged, no PR).
- History never plays a sound (initial load, reload, reconnect), a repeat of the same state does not play again, and the Preferences mute for task sounds mutes all of these. Logic: `web/src/lib/taskSounds.ts`.

## API

- `PUT /api/projects/:id/plan-items/:itemId/auto-merge` with `{ "enabled": boolean }` returns the task. 400 for a malformed body, 404 for an unknown task or one of another project, 409 when the task cannot have a PR.
- `POST /api/plan-items/:id/execute` and `POST /api/projects/:id/plan-items/:itemId/start-when-ready` accept an optional boolean `autoMerge` (the Start task dialog's switch, or a row's Auto-merge in Start pending tasks). It is saved only when the start is accepted; absent leaves it unchanged, a non-boolean is 400, and `true` with `createBranch: false` or without a linked repository is 409 with the reason above.
- `POST /api/projects/:id/plan-items/:itemId/auto-merge/retry` returns the task. 409 unless the state is failed or agent unavailable.

## Not covered

A project-wide default, other merge methods, merging PRs that are not a task's own, chains of dependent tasks, and pulling the merged result locally.
