# Connections between Buildings

Buildings work together through **capabilities** (a request and a response), **events** (a published fact other Buildings can react to) and **links** (what a person has allowed). Every call and event is written to the **Activity log**.

Code: `server/src/connections/` (`rules.ts` pure rules, `fields.ts` input checks, `service.ts` the service, `sessions.ts` what a session may do), `server/src/api/connectionRoutes.ts`, `server/src/terminal/capabilityTool.ts` with `server/bin/capability-mcp.mjs`, `web/src/lib/connections.ts`, `web/src/store/connectionsStore.ts`, `web/src/ui/connections/`, `web/src/scene/ConnectionLines.tsx`. External webhooks, other people's permissions and the capabilities of the SEO and Sales types are not part of it.

## Capabilities

A type's code declares each capability in `capabilities` (`buildings/contract.ts`): an `id`, a description, `mode` (`read` or `write`), `requiresApproval`, `startsRun`, its `inputs` and `outputs` (field specs), and the `handle` function that does the work. `handle` never leaves the daemon. A declaration with no `mode`, or a duplicate capability or event id, is refused when the type registers.

- A **read** never changes anything and is never held for approval.
- A **write** is held for a person (approve, request changes, stop) unless it declares `requiresApproval: false`. A link may mark a write **pre-approved**; that skips the wait for a **scheduled job** only. An agent, a workflow step and a person making a call stay gated.
- A capability with `startsRun` answers at once with a reference to the run it started (`runRef`).

The SEO Building offers one read capability, **`get-latest-report`** (the newest saved SEO report as Markdown plus its key numbers; see `docs/seo-building.md`), and publishes the event **`report-published`**. Software offers four: **`get-open-tasks`** (read: the Tasks that are not done, in board order) and **`start-planning-session`** (write, starts a run, held for approval: starts a planning session the way the Building's chat does, through the same start path as the Building's chat (`startTask` with kind plan, then the session titler), so the approval, concurrency and folder rules are the same and a busy Building answers 409), plus two read-only task capabilities below.

### `get-task-details` and `list-completed-tasks` (Software)

Both are read-only: they start no run, need no approval and are offered to every session that can use read capabilities. The Activity log keeps their inputs (task id or filters), never the returned text. They return the task data the daemon stores; never transcripts, file contents, diffs, prompts, secrets or worktree paths.

**`get-task-details`**: input exactly one of `id` (the plan item id the task lists return) and `number` (board number such as `10.017`, matched exactly within this Building); both or neither is 400, each is at most 200 characters. A task of another Building and an unknown id are the same 404 (`Task not found`). Works for open, running, completed and archived tasks. Output: `id`, `number`, `title`, `type`, `createdAt`, `updatedAt`, `description`, `status`, `phase`, `completedAt` (when completed), `activity` (`step` and `progress` such as "2 of 5 done", while in progress), `runs` (how many times the task ran; the latest run is reported), `steps` (each: `name`, `state` pending/running/done/skipped/failed/stopped, `rounds`, `startedAt`, `finishedAt`, `summary` = the agent's summary of the latest round or the skip reason, `summaryTruncated`), `stepsTotal`, `delivery` (`branch`, `prUrl`, `prState` open/merged, `autoMerge` on/off/none), `outcome` (a completed task's completion report) and the flags below. A task with no run has `ready` status, no steps and no PR; a record without step summaries lists the steps without them. `prState` is `merged` only when Auto-merge recorded the merge.

- **Status vocabulary:** `ready`, `waiting` (for a parent, or a finished task's Auto-merge pull request not merged yet), `running`, `waiting-for-input`, `awaiting-approval`, `needs-attention`, `failed`, `stopped`, `completed`, `archived`. Derived the way the Tasks board groups a task. **Phase:** `not-started`, `in-progress`, `completed` (an archived task that was done is `archived` with phase `completed`).
- **Limits:** `description` 20,000 characters, each step `summary` 2,000, `outcome` 5,000, at most 100 `steps` (`stepsTotal` says how many exist). A cut is never silent: `descriptionTruncated`, `outcomeTruncated`, `summaryTruncated` per step, and a top-level `truncated` that is true if anything was cut. Text is cut by characters, never inside a surrogate pair.

**`list-completed-tasks`**: completed means done, including archived after being done (the Tasks board's Completed definition; a finished task whose Auto-merge pull request is not merged yet is not completed); failed, stopped and archived-not-done are excluded. Inputs, all optional: `limit` (default 20, 1 to 100, above is 400), `cursor` (the previous `nextCursor`; 400 if invalid or from other filters), `since` (completed at or after; a date or an instant with an offset or `Z`), `search` (case-insensitive title match, at most 200 characters). Newest completed first, ties by id. Output: `tasks` (each `id`, `number`, `title`, `type`, `completedAt`, `hasPr`, `prMerged`, `outcome` = one-line snippet of the completion report, at most 160 characters), `total` (for the filters) and `nextCursor` (absent on the last page). No match is an empty list.

**Default-on grants:** a new link's screen shows every capability of the target checked (not pre-approved); the person unchecks what they don't want and the change is saved per capability on the server. The API itself is unchanged: `POST /api/links` without `capabilities` grants none. Each stored link carries `grantsVersion`; at startup a link below the current version gets the capabilities listed in `server/src/connections/grantsMigration.ts` (version 1: `get-task-details` and `list-completed-tasks`) when its target type still offers them, then is stamped, so what a person unchecked later is never switched back on and no earlier choice changes. A capability added later is on for new links; whether it is migrated is decided by the task that adds it. Approval gates and events are not touched by default-on: a write stays held for approval and pre-approval stays off until a person sets it.

## Events

A type declares `events` (an `id`, a description and an optional payload spec) and publishes one through `POST /api/projects/:id/events`. Another Building **subscribes** to an event of a linked Building and names one of its own scheduled jobs; each event starts that job (history shows it as started by "event"). Delivery is **once**: an event waits in a stored outbox until its job has started, so a subscriber that is down gets it after the daemon restarts, and a start that is already in the job's history is never repeated.

An event chain is bounded by the same depth limit as calls. A subscription has a **per-hour limit (30)**; past it the subscription turns itself off, an Activity entry says why and a notification is raised once. Turning it on again resets the count.

## Links

A link says "Building A may use these capabilities and events of Building B". It has one direction: A to B gives B nothing on A. Without a link every call is refused. A grant must name something B's type declares. A Building cannot link to itself and the same pair has one link per direction.

A link whose target type no longer declares something it grants is **broken**: it is shown that way (Connections view, dashed red line in the 3D scene), and calls through it answer 409. Brokenness is worked out when a link is read, never stored. Deleting a Building removes its links, subscriptions, waiting events and calls waiting for approval; its Activity entries stay in the other Buildings with the missing Building shown as "Building deleted".

## Who may call, and which sessions get tools

Callers are a person (the Connections view), a scheduled job (a job whose target is a capability), a workflow step session and an agent session. Tool calls come from the session itself: the daemon works out the calling Building, whether the session may write and whether its run is still active from the Task, never from what the agent sends.

| Session | Tools offered |
| --- | --- |
| Execute Task of a Building with an outgoing link | every granted read and write capability |
| Writable workflow step | reads and writes |
| Read-only workflow step | reads only |
| Planning session | reads only |
| Building with no outgoing link | none |

A link that only comes in gives the target no tools. A call from a session whose run has ended is refused (403). Reads reach only linked, granted capabilities. The tenant of both Buildings must match (one local tenant today, but the check runs): a call across tenants answers as an unknown Building.

## The validation contract

| Status | When |
| --- | --- |
| 404 | the calling or target Building does not exist (or is in another tenant), or the target has no such capability and no link grants it |
| 403 | no link, the link does not grant it, a read-only session asking for a write, or a session whose run is over |
| 409 | the link is broken, the chain is deeper than the limit (3), the target is busy or not ready, the idempotency key was used with different inputs, a duplicate link, the call was already decided |
| 400 | a bad input, naming the field (`items[2].name` for a nested one); unknown fields are refused; text and lists longer than their declared cap are **rejected, never shortened**; caps count characters, not bytes; `null` and an omitted optional field are the same; enums match exactly |
| 202 | a write is waiting for approval (`callId`) |
| 504 | the capability did not answer within the timeout (60 seconds) |
| 502 | the capability returned something that does not match its declared outputs |

Checks run in this order: Building 404, capability 404, link 403, grant 403, broken 409, depth 409, input 400, then the capability itself (busy 409). Every refusal is `{ error }` (plus `field` for a bad value) and is written to the Activity log.

**Idempotency.** A call may carry an `idempotencyKey` (up to 128 characters). A repeat with the same caller, target, capability and key within **10 minutes** returns the first result and runs nothing. Two calls at once run it once. Only successes are remembered, plus a call held for approval: a retry of that key answers with the approval's current state (still waiting: the same 202; approved: 200 with the call id and run reference, without the outputs; stopped, changes requested or refused: 409), never a repeated change. Remembered keys live in memory, expire after the window and are lost on restart. The same key with other inputs is 409.

**Approvals** are claimed before anything runs: a second decision on a call that is being decided or already was is 409, so a double click runs a write once. If the link was removed or edited between the request and the approval, the approval is recorded as `refused` and nothing runs.

**Timeouts.** A call that passes its timeout answers 504 and is logged as an error, but the capability is not cancelled. If it finishes later, a second Activity entry ("Finished after the call had timed out") records the outcome, so a late change is visible.

**Housekeeping.** Chain-depth rows of runs are deleted with their Building and after 7 days. Events a subscriber missed are retried on every publish, at daemon start and every minute.

**Call chains** are limited to depth **3**. A call made from inside a run that a call or an event started counts one deeper than the call that started it.

## Activity log

`GET /api/projects/:id/activity` lists the calls and events a Building took part in, newest first: when, caller kind and Building, target, capability or event, a short inputs summary (cut at 200 characters and marked shortened, never holding a storage path), the result, the status, the run reference and the chain depth. Filters: `caller` (a Building id), `capability`, `result`, `from` and `to` (a date, or an instant with `Z` or an offset; a start later than the end is 400) and `limit` (default 100, at most 500).

## HTTP API

| Route | Purpose |
| --- | --- |
| `GET /api/links`, `GET /api/projects/:id/links` | every link; a Building's outgoing and incoming links |
| `POST /api/links`, `PATCH /api/links/:id`, `DELETE /api/links/:id` | create, change grants, remove |
| `GET /api/projects/:id/subscriptions`, `POST /api/subscriptions`, `PATCH`, `DELETE /api/subscriptions/:id` | event subscriptions |
| `POST /api/projects/:id/capability-calls` | a person's call from that Building |
| `POST /api/capability-calls/:callId/decision` | `approve`, `request-changes` or `stop` |
| `POST /api/projects/:id/events` | publish one of the Building's declared events |
| `GET /api/projects/:id/activity` | the Activity log |
| `GET`/`POST /api/agent-capabilities/...?taskId=` | the session tools (CLI token) |

A read-only Building refuses the changes in this list with 409.

## Settings in code

Defaults live in `connections/rules.ts` (`DEFAULTS`): depth 3, read timeout 60 s, idempotency window 10 minutes, 30 events per hour, key length 128, summary 200 characters, log page 100 of at most 500. Tests inject their own.

## Not yet implemented

- A workflow step that is itself a capability call (agents in step sessions can call through the tools, and scheduled jobs can call).
- Setting a job's target to a capability from the Job editor; the API accepts `target: { kind: 'capability', targetBuildingId, capabilityId, inputs }` and the editor does not offer it yet.
- Capabilities and events for any type other than Software's four capabilities.
- Live updates of links in an open Connections view (it reloads after its own changes).
- An approval raised by a call is answered in the Activity log, not in the Tasks board.
