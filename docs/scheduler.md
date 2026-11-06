# Scheduler contract

Added 2026-10-11 (task 10.004). The daemon runs each Building's jobs on its own: cron schedules, and poll triggers that watch a folder, a file or an HTTP endpoint. A job starts an ordinary workflow run, so it shows on the Tasks board, raises the usual notifications and takes the usual approve, request changes and stop actions.

Code: `server/src/scheduler/` (engine and pure rules), `server/src/api/scheduleRoutes.ts`, `web/src/ui/schedules/`, `web/src/lib/schedules.ts`, `web/src/store/schedulesStore.ts`. Inbound webhooks and inbound email are not part of it; a job may call a capability of a linked Building and an event may start a job (see [connections](connections.md)).

## A job

A job belongs to one Building. It has a name, an on/off switch, a trigger, a target and guardrails.

| Trigger | Fields | Behaviour |
|---|---|---|
| `cron` | `cron` | Runs at each slot of the expression, in the Building's timezone. |
| `file` | `path`, `detect` (`mtime` or `hash`), `intervalSeconds` | Reads the folder (nested folders included) or the single file every interval. A relative path is inside the Building's folder; an absolute one may point anywhere on the computer. |
| `api` | `url`, `jsonField` (optional), `intervalSeconds` | A plain `GET` with no headers every interval, to any `http` or `https` address. |

| Target | Fields | What starts |
|---|---|---|
| `slot` | `slotId`, `description` | A run of the workflow that fills that slot of the Building's type, on a new task with that description. |
| `prompt` | `agentId` (null means the Catalog's default agent), `prompt` | A run of a built-in one-step workflow (`scheduled-prompt`): the prompt is the task and the chosen agent runs the step. |
| `capability` | `targetBuildingId`, `capabilityId`, `inputs` | A call of a linked Building's capability. |
| `action` | `actionId` | An in-process action the Building's type declares in `scheduledActions` (the SEO data fetches). It starts no workflow run; its state is tracked under an `action:` run id. A start refused for a reason that is not a failure throws `SkipStartError` and the entry is recorded as skipped. |
| `command` | `commandId` | One of the same Building's saved commands (Settings > Commands), started with `runCommand`. It runs without an agent, creates no PlanItem and uses no worker slot. Its state is tracked under a `command:<command run id>` run id: `success` is succeeded, `failed` is failed with the note `Exited with code N` (a start that never ran shows `Failed to start: …` from the run output, else `The command failed`), `stopped` is stopped. The command run is marked `automatic`, so its History shows the Automatic badge; the command runner's own `command.failed` notification still fires beside the scheduler's. |

Each workflow run (`slot`, `prompt`) gets its own PlanItem marked `scheduledJobId`. Such an item never holds the Planning queue.

**A command job and the guardrails.** It is not counted against and does not wait on the Building's concurrency cap, and the usage gate never defers it (no agent is involved). `needsApproval: true` is refused with a field error on `needsApproval`. Overlap and the usage percentages are stored if sent but have no effect: a command already running is recorded as skipped (the same as `skip`), never queued. The daily limit, the failure threshold and both failure notifications apply as for any job. A command that was deleted makes the start fail at set-up ("This command no longer exists", 409 on Run now); the job stays listed, shows "command no longer exists", and can still be renamed or switched off, because an edit without `target` is not checked again. A target is checked on create and when sent: the command must exist and belong to the same Building (field `target.commandId`). A history entry for a command run has no "Open run" link, since the Schedules area opens workflow runs only; the note is shown instead.

### Guardrails

| Setting | Values | Default |
|---|---|---|
| `overlap` | `skip`, `queue`, `parallel` | `skip` |
| `missedPolicy` (cron only) | `skip`, `once` | `skip` |
| `maxRunsPerDay` | 1 to 1,000, or null | null |
| `maxFiveHourPercent`, `maxWeeklyPercent` | 1 to 100, or null | null |
| `needsApproval` | true or false | false |
| `failureThreshold` | 1 to 100 | 3 |

A start is checked in this order: the Building must be writable, then the overlap rule, the daily limit, the usage gate, and the Building's concurrency cap.

- **Overlap.** With a run of the job going, `skip` records a skipped entry, `queue` holds one start until the run ends (a second one is skipped), and `parallel` starts another run. A job under `skip` or `queue` never has more than one start waiting.
- **Daily limit.** Counts the runs the job started on the Building's local calendar day, however they were started.
- **Usage gate.** Uses the default coding agent's 5-hour and weekly usage, the same numbers as the status footer. A start above a limit is deferred until that window resets, then starts once. With no known reset time it is skipped. A reading whose reset has passed is treated as out of date, and with no usage reading at all the gate holds nothing back. Only one start per job waits this way; a second is skipped. There is no per-run spend cap.
- **Concurrency.** A start that does not fit under the Building's cap waits as queued and starts when a slot frees, in order of due time, then job creation time, then job id. A Building with no repository runs one thing at a time in its own folder, and an in-place run that needs attention or approval still holds that folder, so the next start queues until a person settles it. While it queues, later slots under `skip` or `queue` are skipped by the overlap rule and are not failures, so such a job raises one notification and never reaches its failure threshold (a current limitation; whether a blocked slot should count as a failure is undecided).
- **Needs approval.** The run pauses before the workflow's last step: the step before it becomes an approval step in the run's own copy of the workflow. A one-step workflow or a single prompt pauses after its step. Where that step is already an approval step there is no second pause. A last step that is itself an approval step does not replace the pause before it, because an approval step asks only after it has run; such a run pauses twice, before the last step and after it. Request changes re-runs the gated step and the pause applies again.
- **Failures.** A failed run raises a `schedule.run_failed` notification (warning). After `failureThreshold` failed runs in a row the job switches itself off and raises `schedule.job_disabled` (critical). A success resets the count; a run a person stopped does not count. Switching the job back on resets the count and resolves both notifications.

**Run now** starts the job at once without moving its schedule. The overlap rule can refuse it (409). It ignores the daily limit and the usage gate, counts toward today's runs, and works on a job that is switched off. A start that fails at set-up (its slot, workflow or agent is gone) also answers 409 with the reason; the failed entry stays in the history and counts as a failed run.

An edit that does not send `target` is not checked against the Catalog or the type again, so a job whose agent or slot was removed can still be renamed or switched off.

Switching a job off never stops a run that is going; starts still waiting are recorded as skipped, except a Run now a person asked for, which still starts. Editing a job changes later runs only. Deleting a job removes its history; a run that is going carries on untracked. Deleting the Building removes its jobs.

## Time

Cron expressions have five fields with `* , - /`, month and weekday names in any case, weekday 0 and 7 both Sunday, and the macros `@hourly @daily @weekly @monthly @yearly`. With both day fields restricted, a day matching either one runs. There is no seconds field and no `? L W #`.

Each Building has a timezone (`ProjectRecord.timezone`, an IANA name or `UTC`); null means the host's. Changing it recomputes every cron job's next run.

A local time the clocks skip runs once, at the instant of the jump, however many slots the gap hid. A local time that happens twice runs on its first occurrence only.

The engine reads the time through an injected clock and never sleeps more than a minute, so a clock change or a wake from sleep is noticed. A job fires when its stored `nextRunAt` has passed and then moves to the next slot after now, so a late tick gives at most one start per job and a clock stepping back never repeats a slot.

When the daemon starts, each cron job whose slot passed while it was off gets its missed-run policy once: `skip` writes one skipped entry, `once` starts one run marked catch-up. A poll job has no catch-up; its next check simply runs.

## Poll triggers

The first reading is a baseline and starts nothing. A later reading that differs starts a run and records what changed. The baseline moves on even when a guardrail then skips the start, so one change fires once.

- A folder baseline is a signature per file: modified time and size (`mtime`), or a content hash (`hash`). `mtime` does not see an edit that keeps both. A whole API response is compared on its raw body and only its hash is stored. A selected JSON field (dots and `[n]`, such as `plans[0].price`) is compared on its canonical JSON, so key order and whitespace do not count.
- A failed check (unreadable path, non-2xx answer, network error, missing field, non-JSON body with a field selected, no answer in 30 seconds, a response over 1 MB, a folder over 20,000 files) records a check-failed entry, starts nothing, keeps the old baseline and tries again at the next interval. The error shows on the job until a check succeeds. The same error repeating is recorded once. Failed checks do not count toward switching the job off.
- The next check is timed from when the last one finished. A read that passes the 30-second timeout is told to stop, and the job is not read again until that read has ended.
- An API response is read as it arrives and dropped once it passes 1 MB.

## History

Each job keeps its newest 200 entries; an entry whose start has not finished is never dropped.

| Field | Meaning |
|---|---|
| `startedBy` | `schedule`, `poll`, `run-now`, `catch-up` |
| `outcome` | `queued`, `deferred`, `running`, `awaiting-approval`, `succeeded`, `failed`, `stopped`, `skipped`, `check-failed` |
| `startedAt`, `finishedAt`, `durationMs` | `finishedAt` and `durationMs` are null until the entry ends |
| `note`, `change` | why it was skipped, deferred, queued or failed; what a poll saw change |
| `runId` | the workflow run, or null |
| `seq` | increases per job; the paging cursor |

A run that needs attention because its step ended without completing is `failed`, with the run's attention reason as the note (a CLI-reported turn error such as a usage limit is part of that reason). A run only waiting for an answer stays `running`. A run deleted while it was going ends its entry as `stopped` with no run link.

## HTTP API

All under `/api/projects/:id/schedules`. A refused request answers `{ error }`, with `field` beside it on a 400. Unknown Building or job: 404. Read-only Building: reads work, every change is 409 with the reason.

| Method and path | Answer |
|---|---|
| `GET` | `{ projectId, timezone, hostTimezone, jobs, missingDefaults }` |
| `PATCH` `{ timezone }` | the same view; 400 for an unknown timezone |
| `GET /cron-preview?cron=` | `{ cron, timezone, runs }` with the next three run times; 400 when invalid |
| `POST /restore-defaults` | the view, with the type's missing default jobs added back |
| `POST /jobs` | 201 with the job |
| `PATCH /jobs/:jobId` | the job; the patch is validated as the whole job it produces |
| `DELETE /jobs/:jobId` | 204 |
| `POST /jobs/:jobId/run` | 201 `{ entry, job }` started, 202 queued, 409 `{ error }` refused by the overlap rule or failed at set-up |
| `GET /jobs/:jobId/history?cursor=&limit=` | `{ entries, nextCursor }`, newest first, 50 by default, at most 200 |

A job in a response also carries `nextRunAt`, `consecutiveFailures`, `autoDisabled`, `pollError`, `declaredJobId`, `runsToday`, `activeRun`, `queued` and `lastEntry`. Field limits: name 120 characters; task description and prompt 10,000; path 1,024; address 2,048; JSON field 256; interval 1 minute to 30 days.

`/ws` sends `{ type: 'schedules', projectId, schedules }` when a Building's jobs change and `{ type: 'scheduleEntry', projectId, jobId, entry }` for each history entry written.

## Jobs a type declares

`BuildingTypeDefinition.scheduledJobs` lists default jobs: `{ id, description, cron }` plus optional `name`, `enabled` (off unless set), `slotId` (the type's first slot unless set), `task`, `overlap`, `missedPolicy`, `maxRunsPerDay`, `needsApproval`, `failureThreshold`. Registering a type fails, naming `scheduledJobs`, on a duplicate id, an invalid cron expression or an unknown slot.

Each Building gets a copy of them once (`scheduledJobsSeeded`), when it is created or, for an older Building, when the daemon next starts. The copies can be edited and deleted like any job. A deleted one stays deleted until Restore default jobs adds the missing ones back in their declared state.

## The Schedules area

`SchedulesPanel` takes a Building and an `onOpenRun` callback and imports nothing from the workspace shell. Both built-in workspaces show it as the Schedules section of the Settings tab. A type can render it inside its own popup or leave it out and build its own screen on the same routes and store actions.

## Storage and injection

Jobs, history and poll baselines are in `scheduled-jobs.json`, `scheduled-job-history.json` and `scheduled-job-baselines.json` in the daemon's data directory.

`createScheduler` takes its clock, timer, file and HTTP sources, usage reader and a `RunStarter`. The daemon's starter (`scheduler/runStarter.ts`) goes through the worker manager. Tests pass fakes from `server/tests/helpers/schedulerFakes.ts`.

## Not yet implemented

- Request headers or credentials for an API poll.
- A usage gate on a specific agent: the gate reads the default coding agent only.
- An event bus: a detected change is recorded in the job's history and nowhere else.
- Nothing here has been run for hours on real timers, against a real endpoint or folder, or looked at in a browser (`.docs/testing.md`, Known gaps).
