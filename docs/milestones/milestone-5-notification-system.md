# Milestone 5: Notification System

**Status: Built.** The shared notification system described below is implemented and shipped — `server/src/notifications/notificationService.ts`, the producers listed in "Raise/resolve catalog", and the frontend drawer/toasts/building-dot described under "Frontend". This document now describes the system as built, not a proposal.

Not to be confused with the per-project `Milestone` feature this app already ships (see [`README.md`](README.md) at the top of this folder) — this document describes a *feature of the application itself*.

## Why

Alerts about what's happening across the system used to be scattered and passive: a Task's `blocked`/`error` state showed as a colored dot on its Building only if you were looking at the scene; a failed Project Command's result sat in its run history until opened; a git-sync conflict was visible only inside a Project's workspace; nothing outside a Task's own turn could reach the user proactively. This milestone gives the app one shared primitive every producer reports into — Task lifecycle, Project Commands, git-sync, Catalog skill installs, plus a couple of smaller producers added along the way (testing, workflow runs) — surfaced consistently as a building-dot color, a toast, and a drawer.

**Amended, 2026-09-25 (Notification Agent removed):** an earlier version of this plan called for an LLM-driven Notification Agent that ran a full `claude -p` turn on every Notification to decide what to do about it. It was built, then removed, before this redesign: a turn per event cost real usage on every single occurrence and never produced a decision a plain rule couldn't — every producer already knows exactly what happened and what "resolved" means for it. `server/src/notifications/notificationAgent.ts`, the `agentDecision`/`possibleActions` fields, and the `NotificationAction`/`NotificationAgentDecision` types are gone. Every producer now raises and resolves deterministically instead (see "Raise/resolve catalog" below). The `NotificationChannel` interface and WhatsApp adapter stay, with no current caller, as plumbing for a future rule-based escalation — they were never wired to anything in the shipped version.

**Amended, 2026-10 (subject-based redesign, task 1.002):** the original `status: 'open' | 'acknowledged' | 'resolved' | 'dismissed'` field packed together two independent questions — has the user seen this, and is it still true — into one value, and its only actions were status transitions with no connection to what the Notification was actually about. This redesign splits those into `readAt`/`resolvedAt`, keys every Notification by a `subject` (what it's about and where clicking it goes), and replaces the old Notification Center dialog with a drawer that deep-links and offers a one-click fix where one exists. The sections below describe this shipped shape.

## Data model

`NotificationRecord`, in `server/src/domain/types.ts`:

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `kind` | `NotificationKind` | what raised it — see the raise/resolve catalog below. Severity is fixed per kind (`NOTIFICATION_SEVERITY_BY_KIND`), never caller-supplied. |
| `severity` | `'info' \| 'warning' \| 'critical'` | derived from `kind` at raise time |
| `subject` | `NotificationSubject` | what it's about and where clicking it goes (see below) |
| `projectId` | string \| null | derived from `subject` — null only for the one project-less subject (a Catalog skill install) |
| `title` | string | short and specific — the task's first line / command name / project name / skill repo |
| `description` | string | longer detail, shown in the drawer |
| `readAt` | string (ISO) \| null | owned by the user: null until they've seen it |
| `resolvedAt` | string (ISO) \| null | owned by the system: null while the condition that raised it is still true. Resolving also sets `readAt` if it was null. |
| `createdAt` / `updatedAt` | string (ISO) | |

`NotificationSubject` is a closed union, one variant per thing a Notification can be about:

```ts
| { type: 'task'; projectId; conversationId; taskId }   // conversationId = TaskRecord.conversationId ?? task.id
| { type: 'command'; projectId; commandId; runId }
| { type: 'project'; projectId }                         // git sync, and the two gap-filling kinds below
| { type: 'skill'; repo }                                 // Catalog install — the one project-less subject
```

A subject's *identity* — what `raiseNotification` dedupes an unresolved Notification on — is its `type` plus whichever field names the thing itself (`conversationId`/`commandId`/`projectId`/`repo`). `taskId`/`runId` are **not** part of identity: they only ever point at the latest attempt, for the deep link. A `task` subject is keyed by conversation, not by the individual `TaskRecord` — a follow-up/resume creates a new `TaskRecord` with the same `conversationId` (`workerManager.ts`'s `continueTask`), so raising/resolving against whichever Task in that chain is currently live always lands on the one Notification for the whole conversation.

Storage is unchanged from the original plan: `notificationsDb = new FileDatabase<NotificationRecord>(path.join(DATA_DIR, 'notifications.json'))` in `server/src/db/collections.ts`.

**Retention.** A Notification that is both read AND resolved, with `resolvedAt` older than `NOTIFICATION_RETENTION_MS` (7 days), is deleted by `pruneNotifications` — run once at daemon start and hourly (`startNotificationPruning`, unref'd like `executors/claudeUsage.ts`'s usage poller). A resolved-but-unread or read-but-unresolved Notification is kept regardless of age — it's still either unreviewed or still true. A legacy `notifications.json` record with no `kind` field (the pre-redesign shape) is deleted on sight rather than migrated — there's no way to recover a kind/subject that was never recorded.

## Architecture

### Ingestion: a shared primitive, not a new subsystem per producer

Two calls in `server/src/notifications/notificationService.ts`, called directly from the producer code that already has the context:

- **`raiseNotification({kind, subject, title, description})`** upserts: if there's an unresolved Notification with the same kind + subject identity, it's updated in place (title/description/subject/`updatedAt`) and re-unread (`readAt: null` — this is a fresh occurrence); a resolved record with that identity never blocks a new insert.
- **`resolveNotifications(subject, kinds?)`** resolves every unresolved Notification matching that subject identity, optionally narrowed to specific kinds — so, say, settling a Task failed can resolve just `task.needs_input` and leave a sibling `task.failed` alone.

Both emit through `onNotificationEvent`, broadcast over the existing `/ws` channel as a `{type: 'notification', notification}` `WorkerEvent` — no new transport. `markNotificationsRead`/`markNotificationUnread`/`markSubjectRead`/`markAllRead` are the user-facing counterpart: they only ever touch `readAt` (plus the task.completed-resolves-on-read rule below), never `resolvedAt`.

**Reading a `task.completed` also resolves it** — reviewing a completion counts as handling it. This is the one place reading has a side effect beyond `readAt`, enforced in the service so every caller (the drawer, mark-read-on-view, the API) gets it for free.

### Raise/resolve catalog

| Kind | Severity | Subject | Raised when | Auto-resolves when |
|---|---|---|---|---|
| `task.needs_input` | warning | task | a terminal hook reports `waiting_input` (not while its terminal is attached) | the hook reports running again, the task settles done/failed/stopped, or the conversation is archived/deleted |
| `task.failed` | critical | task | `settleFailed` (including the restart-recovery "session id never recorded" path) | a follow-up/resume starts in the conversation, or it's archived/deleted |
| `task.completed` | info | task | `settleDone`/`finishTerminalTaskDone` settles a non-workflow-step Task, for every kind including planning sessions. Title is `Task completed: <first line>` or `Planning session #N finished`; description is the result message, trimmed. | it's read, a follow-up starts in the conversation, or it's archived/deleted |
| `command.failed` | warning | command | a Project Command run finishes non-zero or fails to spawn (not the branch-sync run — see below) | a later run of the same `commandId` succeeds |
| `command.completed` | info | command | a saved or custom command exits 0 after executing at least 10s while its log popup is not open in a browser (never a sync run, a stopped run or a run settled at daemon start) | it's read or dismissed |
| `git.out_of_sync` | warning | project | the git-sync poller sees a Project go `behind`/`diverged` | the poller sees it back in sync |
| `skill.install_failed` | warning | skill | a Catalog `npx skills add <repo>` install fails | a later successful install of the same repo |
| `testing.failed`* | warning | project | a manual Test Run fails or errors | a later manual run in that Project passes |
| `testing.passed` | info | testRun | a manually started Test Run passes after executing at least 10s while its run drawer is not open (never an agent-started run) | it's read or dismissed |
| `task.limit_reached` | warning | project | a queued task could not start because its Project is at its concurrent-task limit | a queued task starts or the queue empties |
| `workflow.awaiting_approval`* | warning | project | a WorkflowRun step reaches its approval gate | the run leaves `awaiting-approval` (approved, retried, stopped) |
| `workflow.needs_attention`* | critical | project | a WorkflowRun step ends without completing, a review loop exhausts its rounds, or a daemon restart finds an orphaned step | the run leaves `needs-attention` |

\* These three kinds aren't part of the original milestone's producer list — they keep two pre-existing producers (`testing/testRunner.ts`'s manual-run notification, `workerManager.ts`'s workflow-attention notification) working under this model rather than silently dropping behavior the redesign's own spec never mentioned. Both are also coarser than the task/command kinds: `testing.failed` and the two `workflow.*` kinds key off the whole Project (`{type:'project'}`), not a specific action/run, because the closed `NotificationSubject` union has no run-scoped variant for them — when these kinds were written at most one WorkflowRun was active per Project at a time (`executorHolder` serialized PlanItem execution). That gate is gone (task 31.003): the Project's task slot cap now bounds concurrent runs, so a Project-keyed notice may stand for any of several active runs. A Project sync *run* failing (`runProjectSync`) deliberately does not also raise `command.failed`: `git.out_of_sync` already covers that same underlying condition, and raising both would just be two alerts for one thing.

Settling a Task done resolves that conversation's `task.needs_input` **and** `task.failed`. Settling failed resolves `task.needs_input`. A follow-up starting resolves all three task kinds. `workerManager.ts` has two small helpers so call sites don't repeat this: `taskSubject(task)` (the subject for a Task's conversation) and `resolveTaskNotifications(task, kinds)`.

### External channels (unused, kept as plumbing)

`NotificationChannel` (`send(message, target): Promise<void>`) and its WhatsApp adapter under `server/src/notifications/channels/` are kept on purpose, with no current caller, as plumbing for a future rule-based escalation — see the amendment above for why they're not wired to anything.

## Frontend

- **Building status dot** (`web/src/lib/buildingVisualStatus.ts`): counts only Notifications that are **unread AND unresolved** (`isAttention`) for a Project — a notification the user has already read, or one the system has already resolved, no longer needs the dot's attention even if it's still sitting in the drawer.
- **Bell badge** (the status footer's bell, formerly in the top bar): counts every **unread** Notification regardless of resolved state (`countUnreadNotifications`) — a resolved-but-unread one still deserves a look.
- **Notifications drawer** (`web/src/ui/NotificationCenter.tsx`, opened via the existing `notificationCenterOpen`/`openNotificationCenter`/`closeNotificationCenter`): a right-side Sheet, replacing the old status-based dialog.
  - Header: "N unread notifications" and "Mark all as read" (only the notifications matching the drawer's *current filters* — disabled when none of those are unread).
  - Unread/Read tabs with counts; each row's tab is fixed the instant the drawer opens — toggling a row's dot only flips its own indicator until the drawer is reopened.
  - Filters: state (Any/Active/Resolved), severity, project (+ "System" for the one project-less subject).
  - Each row: title, 2-line clamped description, severity badge (+ "Resolved" badge once resolved), a target chip (icon + label by subject type: task → list-checks, or a lightbulb for a planning session; command → terminal; project → folder-kanban; skill → sparkles), and "project · time ago".
  - Clicking a row calls `openNotificationTarget` (always marks read first) and closes the drawer. The read/unread dot and the quick-action button both stop the click from reaching the row.
  - A quick-action outline button shows only for an unresolved kind that has one (see "Quick actions" below); it shows a pending state while it runs and reports a failure as an error notification (without marking read).
  - 10 rows per page with "Load more (x of y remaining)"; any filter change resets to page 1.
- **Toasts** (`web/src/ui/NotificationToasts.tsx`, Sonner): every new Notification toasts. `info`/`warning` auto-dismiss after `TOAST_AUTO_DISMISS_MS`; `critical` persists with a close button. A Notification that *recurs* — the same id, still unread and unresolved, with a newer `updatedAt` than it was last toasted at — toasts again; a content-only update to an already-read notification does not. A shown toast closes itself the moment its Notification is read or resolved, from any source. The action is the quick action when there is one, otherwise "Open".
- **Deep links** (`openNotificationTarget`, in `worldStore.ts`): task → the workspace's Tasks tab, detail open on the subject's `taskId` (`TasksPanel` resolves the conversation chain via `chainFor`; for `task.needs_input` the embedded terminal auto-focuses on mount, which is the "reply composer" there is). command → the workspace's Settings → Commands section (there is no standalone top-level Commands tab). project → the workspace. skill → the Catalog. `workspaceTab`/`workspaceDetailTaskId`/`workspaceSettingsSection` live in the store (not component state) specifically so this can reach into the open workspace from outside its component tree; `openWorkspace` resets all three to their defaults on every call, the reset that used to come from remounting the workspace's content by project id.
- **Quick actions** (`lib/notificationCenter.ts`'s `quickActionFor`, `worldStore.ts`'s `runNotificationQuickAction`), offered only while unresolved:

  | Kind | Button | Action |
  |---|---|---|
  | `task.needs_input` | Reply | opens the task detail (same as the deep link) |
  | `task.failed` | Retry | a terminal task resumes (`POST /tasks/:taskId/resume`); a structured task gets a templated follow-up (`POST /tasks/:taskId/followup`, "Retry the task. The previous attempt failed: …") |
  | `command.failed` | Run again | `POST /commands/:commandId/run` |
  | `git.out_of_sync` | Sync | `POST /projects/:projectId/sync` |
  | everything else | — | no quick action |

- **Mark-read-on-view**: showing a task's session (`TaskDetailsView`/`TaskSessionBody`, however the user got there — not just via a notification) calls `markSubjectRead` for its conversation; showing the Commands section marks that Project's unread `command.failed` Notifications read. Both only call the server when the store actually holds a matching unread Notification.

## API

`server/src/api/router.ts`:

- `GET /api/notifications?resolved=&read=&severity=&projectId=` — query-string booleans are the literal strings `"true"`/`"false"`; anything else (including omitted) means "no filter". `projectId=none` means the one project-less subject.
- `POST /api/notifications {kind, subject, title, description}` — for anything outside the daemon process itself to report in, same as every producer's own direct `raiseNotification` call. No auth, consistent with this app's local-only stance.
- `POST /api/notifications/read {ids} | {subject}`
- `POST /api/notifications/:id/unread`
- `POST /api/notifications/read-all` with an optional filter body ("Mark all as read")

The old `PATCH /api/notifications/:id/status` route, `GET /api/notifications/:id`, and the status-constant validation are gone.
