# Default coding agent and the shared agent picker

Task 19.001. One app-wide default coding agent, one dropdown for choosing an agent wherever agent work starts, and a reordered Start task dialog that carries the task's Auto-merge switch.

## The default

There is exactly one default for the whole app, across all Projects. The daemon stores it (`server/data/default-executor.json`), so it survives a reload, a daemon restart and other browser tabs.

- **Available.** An agent is available unless one of its quota windows (5-hour or 7-day) is at 100% used and that window's reset time is unknown or still ahead. Missing quota data counts as available.
- **Most quota left.** Lowest active 5-hour usage, then lowest active 7-day usage. A window that is missing or already reset counts as unused. Ties keep the configured order.
- **First pick.** With no stored default and at least one available agent, the daemon stores the one with the most quota left. This is silent: no notification.
- **Sticky.** The default does not change because another agent has more quota left. It changes only when the person sets it, when it runs out, or when it is removed.
- **It runs out.** The default is unavailable and another agent is available: the daemon switches to the available agent with the most quota left. The switch is permanent: when the old agent's limit resets, the default does not switch back.
- **It is removed.** Deleting the default agent in Settings → Coding agents switches the default the same way. With no available agent there is no default until one becomes available.
- **Every agent out of quota.** The default stays as it is and nothing is notified. As soon as another agent becomes available while the default is still unavailable, the switch happens.
- **Making an exhausted agent the default** is refused (409), and the controls are disabled with the reason and reset time.

The daemon re-checks at startup, on every new quota reading (the analytics sampler, an Analytics Refresh, the agent list read, a running task reporting fresh limits) and when an agent is added, edited or removed. Re-checks run one at a time, so overlapping readings switch once.

### Notification

`executor.default_switched`, info, subject `{ type: 'app' }`, title "Default coding agent changed".

- Ran out: "<Old> has used its <5-hour|7-day> limit (resets <time>). New sessions now use <New>." When both windows are used up, the one that resets later is named.
- Removed: "<Old> was removed. New sessions now use <New>."
- A newer switch updates the unresolved notification instead of adding a second. Setting a default by hand resolves it. The first silent pick and a manual change raise none.

### API

- `GET /api/executors` carries `isDefault: boolean` on each agent. At most one is true; none is when no default is stored.
- `PUT /api/executors/default` with `{ "executorId": string }`: 200 `{ defaultExecutorId }`; 400 for a malformed body or an empty or non-string id; 404 for an unknown agent (the id is matched exactly); 409 when the agent is unavailable, naming it and its reset time. Setting the current default is a 200 no-op.
- `/ws` event `executors.default_changed` with `defaultExecutorId`, `previousExecutorId` (null when there was none) and `reason` (`manual`, `exhausted`, `removed` or `initial`). Every open tab updates its footer dots, Analytics control and untouched pickers.

### Where the person sets it

- **Footer.** Each agent has a dot, filled for the default and hollow for the others, acting as a radio group. The dot is its own keyboard-focusable button named "Make <label> the default coding agent"; clicking it only sets the default and does not open Agent analytics. An unavailable agent's dot is disabled with its reason as tooltip. The hover card shows "Default coding agent" for the default. A failed request raises an error notification.
- **Agent analytics.** A "Default for new sessions" button beside the agent selector. It shows a pressed state when that agent is already the default, is disabled for retired and unavailable agents with the reason as its tooltip, and shows a failed request in the dialog's alert area.

### Runs started with no agent choice

Bug 19.001.001. A run that names no agent uses the stored default, through one daemon helper (`createFallbackExecutor` in `server/src/executors/fallbackExecutor.ts`, wired as `resolveFallbackExecutor` in `defaultExecutorInstance.ts` and injected into the worker manager as `resolveDefaultExecutor`). This covers:

- Set up, Reconfigure and Repair testing (no picker; the web sends no agent);
- the new-Project "Set up project documentation" task;
- `POST /api/plan-items/:id/execute` with no agent and no agent saved on the task, including a queued entry, which resolves the agent when it actually starts;
- a planning or ordinary session started with no agent;
- a workflow step whose own and run agents are both gone (last resort);
- the scheduler's usage gate, which reads the default agent's quota.

Explicit choices still win, in this order: the request's agent, the task's saved agent, the step's own agent, then the default. With no default stored, or a stored default that is gone or not a CLI kind, the helper uses the first configured interactive CLI agent. It never re-checks or reads quota itself, so a start stays cheap; the next re-check (above) repairs a stale default.

## The shared coding-agent picker

One dropdown, labelled "Coding agent", defined once in `web/src/ui/CodingAgentPicker.tsx` with its selection rule in `web/src/ui/useExecutorChoice.ts` and the pure rules in `web/src/lib/executorAvailability.ts`.

- Each entry shows the agent's name, its kind and the quota text the footer hover card shows. The default carries a "Default" marker. Unavailable agents are listed but disabled, with their reset time.
- **Preselection:** the default when it is available; otherwise the available agent with the most quota left; otherwise nothing, and the surface's start or send stays disabled.
- **Per-session override.** Choosing another agent applies to that one start or send and never changes the default.
- **While a surface is open.** An untouched picker follows the current default live. Once the person picks, it keeps the choice. A choice that becomes unavailable falls back to the preselection and is not restored if the agent frees up again.
- With no agents configured it shows "No coding agent is configured".

Used by: Start task, Plan & bugs (the no-agent notice and "Create session"; the earlier Plan and Report bug dialogs are gone), the bug session's Start session form, the PR tab's Resolve conflicts dialog (which asks every time, including on Retry, and remembers no agent), and Start pending tasks, whose "Coding agent for all" preselects the same way and whose per-row pickers add a leading "Same as all" entry (see [Unified Planning board](unified-planning-board.md#starting-several-pending-tasks)). Not covered: the agent Auto-merge's own conflict resolution uses, scheduled jobs, testing setup runs (they use the default; see [Runs started with no agent choice](#runs-started-with-no-agent-choice)) and per-step agents in workflows and Building Types.

## Start task dialog

Top to bottom: the bug's "Needs more info" warning, Workflow (with its fallback note), **Steps**, Create a separate branch (linked repository only), **Auto-merge** (linked repository only), Coding agent.

- **Steps** are collapsed every time the dialog opens, showing the checklist's existing count text (for example "6 of 7"). The row is a button with its expanded state exposed; expanding shows the checklist unchanged. A workflow change resets the selection and keeps the expanded or collapsed state. With no step selected the section expands itself and shows "Pick at least one step to run."
- **Auto-merge** opens in the task's current setting. While "Create a separate branch" is unchecked it is off and disabled ("Auto-merge needs a separate branch"); unchecking turns a switched-on Auto-merge off and re-checking does not turn it back on.
- Start sends the switch's value as `autoMerge`. It is saved only when the server accepts the start (started, or accepted as waiting for parents); a refused start leaves the task's Auto-merge as it was. Turning it off for a task that had it on behaves like turning off the task details switch, including resolving its Auto-merge notifications.
- `POST /api/plan-items/:id/execute` and `POST /api/projects/:id/plan-items/:itemId/start-when-ready` accept an optional boolean `autoMerge`; absent leaves the setting unchanged and a non-boolean is 400. `true` with `createBranch: false`, or on a Project without a linked repository, is 409 with Auto-merge's ineligibility reason, and nothing starts.

The dependent-task second screen is unchanged.

## Not yet checked

The real-browser checks (footer dot versus item click, keyboard focus on the dots and the Steps expander, the dropdown with an exhausted agent, the Analytics control, two tabs, a daemon restart) and a real repository with `gh` for an accepted Auto-merge start have not been run.

Known difference: the picker and tooltips format a reset time in the web helper (`unavailableReason`, IST), while the 409 text and the notification use the daemon's `formatReset` (UTC), so the same reset can read differently.
