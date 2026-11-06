# Agent analytics

Each configured coding agent has an Analytics view, opened by selecting its item in the status footer. It shows how much of the provider account's 5-hour and 7-day quota remained over time, which app sessions were running, and how the rounds of a workflow step compare with each other. It covers all Projects at once and opens as its own dialog, so the Project workspace underneath is left as it was.

The view exists to make capacity and activity visible side by side. It does not say how many tokens a task cost from a quota percentage, and it never divides a quota drop between tasks.

## What the view shows

The footer keeps showing percent used (`22%`). The view shows percent remaining with the used figure beside it: `78% remaining (22% used)`. Remaining is 100 minus the provider's used percentage.

The chart shows one local calendar day, midnight to midnight, with every reading as its own point. Previous and next arrows, a date picker and Today move between days. Next is disabled on today and previous on the oldest day history covers. An earlier design with 24h, 7d, 30d and 90d ranges was replaced by this day view during UI planning; there are no range buttons.

The 5h series is a solid line and the 7d series a dashed one. Each can be hidden from the legend. The plot is one focusable element: arrow keys, Page Up, Page Down, Home and End step through the readings, and the reading in focus is shown in a hover box and announced to screen readers. The Readings table under the chart lists the same values in time order, with a row for each reset and each gap.

Activity sits in lanes under the chart on the same time axis. Sessions that overlap get separate lanes. Coding is solid, planning is striped and app background work is dotted, so the kinds differ by more than colour. The filled part of a band is working time and the dashed outline around it is the whole session including waits. A band that started before or ran past the day shown is marked with `‹` or `›`, and its details still give the real start and end. Hovering or focusing a band shows its Project, task, agent, kind, step and round, times, active time and observed quota decrease. Selecting it opens the task at that step round. The Activity table has the same rows with an Open task button.

The Step comparison tab lists workflow step rounds with their active duration, exact tokens and observed 5h and 7d decrease, each beside its median and the number of earlier rounds the median comes from. It can be sorted by any metric and filtered to rounds marked High usage.

There is no CSV export.

## How readings are collected

The daemon samples every configured account about every five minutes, whether or not a browser is open. One sampler drives both the Claude and Codex pollers described in [claude-usage.md](claude-usage.md) and [codex.md](codex.md), and stores what they observed. Opening the view or reloading it reads history and never adds a reading.

A reading is stored under the provider account and its observation time, so two profiles on one account, a repeated poll or a backoff period cannot produce a second point for the same observation. Neither provider returns a timestamp with its answer, so the moment the answer arrived is used as the observation time. A Claude status-line reading keeps its own recorded time.

History starts when collection first runs. Nothing earlier is reconstructed, and a status-line reading from before that moment is not taken in.

Refresh asks the daemon for a fresh check. The provider is contacted only when a check is allowed: not within a minute of the last successful one, and not inside a failure backoff. Otherwise the last successful reading is kept with its real time and the view says when another check is eligible.

History is kept for 90 days in `server/data/analytics/` as `quota-history.json` and `activity-history.json`, and is read back after a restart. It holds an account identifier that is a hash, readings, failed checks, session times, names and token counts. It holds no credential, environment value, prompt or transcript text.

## Gaps, resets and failures

Two readings are joined by a line only when they are at most eleven minutes apart and no failed check falls between them. That is two five-minute samples plus a minute of slack, so one skipped sample does not break the line and two do. Otherwise the line breaks and the stretch is drawn as a gap. A window the provider did not report in a reading is a gap for that window only; the two windows are analysed separately.

A reset is recorded when remaining goes up, when the previous reading's reset time has passed, or when the reset time moves by more than a minute. The line breaks there and the point is marked as replenishment. No fall is ever calculated across a reset or a gap.

Each window's current state is one of: measured, stale (no reading for 15 minutes), failed (the latest check failed, last good value still shown with its time), expired (the reset time has passed with no newer reading), unavailable (the provider did not report it) and awaiting first reading. Only the first three show a percentage. None of the others is a 0% or a 100%.

If the history file cannot be read, the file is left alone and collection carries on in memory with a warning. If a save fails, readings stay in memory and the view shows a save error until the next save succeeds.

## Tracked activity

The daemon records a session for every planning session, every coding Task (a workflow step round when it belongs to a WorkflowRun), and the headless turns that name tasks and sessions or summarise a completed run. The summariser turn appears under the run as the Complete stage.

A session is split at the moments its state changed. It counts as working while the Task is developing and its CLI is starting or running. A question, an approval prompt or an idle prompt is waiting. Stopped, failed, paused and finished Tasks have ended. Only working time is drawn as active and counted as active duration.

A session's names are stored as they were at the time. Renaming a Project, task or step later does not change history. When the task is deleted its rows read "Deleted task" and have no link; when the Project is deleted the rows keep their names and have no link.

Every session begins in a "starting" state. A session first seen further along than that was already running when collection began, so its start was not observed: it is shown from the moment it was first seen and marked approximate. A Task that waits in a queue before it starts is not affected. A session still open when the daemon stopped is closed at the last moment its state was known and marked approximate.

A state change is timed by the Task's own change time when that moved, and otherwise by the moment the daemon saw the change.

Sessions reopened for inspection from a finished step are not tracked, because their CLI hooks are switched off. Work done in the same provider account outside this app is not tracked either.

## Observed quota decrease

A session's observed decrease is the fall in remaining percentage points between the reading just before the agent first worked and the reading just after it last worked. Waits in between are included; a wait after the last working time is not. It is stated only when both readings exist within eleven minutes of those boundaries and nothing between them is a gap or a reset. Otherwise it is unavailable, with the reason: missing boundary reading, reset, gap, or still in progress.

It is always worded as an estimate. It measures the whole account, so usage from outside the app can be part of it even when no other tracked session overlaps.

When other tracked sessions were working on the account between those two readings, the decrease is flagged as shared and shown in full on each of them. It is not divided.

A fall between two joined readings with no tracked session working is labelled "Unattributed activity". Consecutive falls are reported as one stretch until tracked work, a gap or a reset interrupts it.

## Exact tokens

Tokens for a round come only from the CLI's own usage report. Claude Code and Codex both pass the path of their session file in their hook events. At the end of a turn, and once more when the session ends, the daemon reads the usage figures from that file and nothing else. For Claude each assistant message is counted once by its id; for Codex the last running total is used, with cached input split out of input.

The total is input plus output plus cache-creation plus cache-read, the same convention as elsewhere in the app. The four categories are shown under it.

A CLI reports a running total for the whole session and a later round can resume an earlier round's session. Only the increase since the last report is assigned to the round reporting now, so a repeated report adds nothing. A total lower than what was already assigned is treated as a new count.

A Claude conversation is identified by the first message in its session file that reports usage, not by the session id. If a resumed session is written to a new file under a new id, that file repeats the earlier messages, is recognised as the same conversation, and the earlier usage is not assigned again. A Codex session is identified by its session id. Neither case has been checked against a live resumed CLI session; the tests use session files written by hand.

A round with no usage evidence shows "Unavailable". Task records created by interactive sessions carry an all-zero token total; that is not evidence and is never shown as zero. A failed or stopped round keeps what was confirmed and is marked partial. No token figure is ever derived from a quota percentage.

## Step comparison and High usage

A round is compared with earlier completed rounds of the same named step, in the same Workflow, run by the same agent profile, in any Project, within the 90 days kept. A renamed step starts a new group. Skipped steps, the Complete stage and planning sessions are not comparison rows.

Each metric has its own median, drawn only from the rounds where that metric is known. A quota decrease that is shared, or unavailable, is left out of the quota medians. A duration marked approximate is left out of the duration median. The median of an even number of values is the mean of the middle two.

A completed round is marked High usage for a metric when at least five earlier rounds have that metric and the round's value is at least twice their median. The marker names each metric with the round's value and the median. A zero or missing median never triggers it. A running round shows its values so far and the baseline, without a marker. Below five earlier rounds the cell reads "Not enough history".

Rounds recorded before collection began appear with a duration taken from their start and finish times, marked approximate, and with tokens and quota decrease unavailable. They are not part of any median.

## Agents, accounts and retired profiles

History belongs to the provider account. Profiles that share an account show the same readings, and the view says which other profiles share it: it is one capacity, not several.

A profile that is removed, or pointed at a different account, is listed as a retired agent until its history is 90 days old. Its history stops at the moment it was retired. A new profile never takes over a retired one's history, even when it reuses the same id and label.

## Not yet implemented, and limits

- The view has only been checked in a real browser in the dark theme. Light theme colours come from the planning palette and were not checked on the app's light surfaces.
- A session in progress (a live band, "so far" values) was exercised by tests only, not in a browser.
- The token readers were written against the session files of the Claude Code and Codex versions installed when this was built. A CLI that stops passing its session file path, or changes that file's shape, makes tokens read "Unavailable" until the reader is updated.
- "Unattributed activity" rows are listed after the other rows of the Readings table, not at their place in time order.
- The day arrows step from the day last loaded, not the day selected. Two quick clicks move one day, and after a failed day load the title stays on the old day.
- The open view does not reload by itself. A running round's "so far" values and the newest readings stay as they were until Refresh or reopening.
- With one day per view, a week-long 7d trend is only visible by stepping through days.

Out of scope: CSV export, billing or cost prediction, reconstructing quota from before collection, estimating tokens from percentages, and scheduling or limiting Tasks from analytics.

## Where the code is

Daemon: `server/src/analytics/`. `quotaSampler.ts` samples, `analyticsHistory.ts` stores, `quotaSeries.ts` builds series and decreases, `activityRecorder.ts` records sessions and tokens, `stepComparison.ts` holds the median and marker rule, and `analyticsService.ts` answers the four routes under `/api/analytics/agents`. Both providers poll through `server/src/executors/usagePoller.ts`.

The header has a "Default for new sessions" button for the agent being viewed (see [default coding agent](default-coding-agent.md)); it is disabled for retired and out-of-quota agents.

Web: `web/src/lib/agentAnalytics.ts` holds the view-model functions and `web/src/ui/analytics/` the dialog. The view's state is the `analytics` slice of `web/src/store/worldStore.ts`.
