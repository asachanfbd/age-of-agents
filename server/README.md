# server/

agent-visual-os's background daemon — see [`docs/architecture.md`](../docs/architecture.md) and the `agent-visual-os-domain` skill for the design this implements.

## Running it

```sh
cd server
npm install
npm run dev     # node --watch src/index.ts
```

Listens on `PORT` (default `4500`). No build step: source runs directly via Node's native TypeScript support (Node 23.6+ / 25.x). `npm run typecheck` runs `tsc --noEmit` for full type-checking; `npm test` runs `node --test tests/*.test.ts`.

### Running the tests: no real CLI, and a clean machine afterwards

Tests must never start a real agent CLI. `createWorkerManager` falls back to the real runner for any path a test doesn't fake (a real node-pty `TerminalSessionManager` when `terminalSessions` isn't injected — every Task now runs this way; `deps.runClaudeTurn`/`deps.runCodexTurn` default to the real headless runners too, but the only thing still calling either is the Complete stage's own headless summarizer turn, `workflowSummarizer.ts`), and the fixture executors point at the real `claude`/`codex` binaries on your PATH. So a test that drives a WorkflowRun to its Complete stage must pass a fake `runClaudeTurn`/`runCodexTurn` for the summarizer, and any test that starts a Task at all must pass `fakeTerminalHost()`. `resumeInterruptedTasks` needs every fake at once (use `resumeTestManager` in `tests/workerManager.test.ts`), because it settles *every* `developing` Task in the shared test database, including ones earlier tests left behind. Breaking this rule once launched a real `codex exec` with full disk access, and a real `claude --resume` in a PTY, on every run. That also kept `npm test` from ever exiting.

`npm test` should exit on its own in seconds. After every run:

1. If it hangs after the last test finishes, something real is still running: don't just add `--test-force-exit`, find it and fake it.
2. Check nothing was left behind, and kill only your own run's processes (another Worker may be testing in the same checkout):
   ```sh
   ps -Ao pid,ppid,etime,command | grep -E "codex exec|claude --resume|node --test" | grep -v grep
   ```
3. A killed run skips its `after()` hooks and leaves `$TMPDIR/<name>-test-*` dirs behind. Remove them only when no other test run is in progress, since this also deletes a live run's dirs:
   ```sh
   rm -rf "$TMPDIR"/*-test-?????? "$TMPDIR"/agent-visual-os-codex-* "$TMPDIR"/avos-test-run-*
   ```

Test Runs follow the same rule: `createTestRunner` takes a fake `spawnProcess` (and artifact/git fakes) from `tests/helpers/testRunFakes.ts`. The real default spawns the configured test command in its own process group, so a test that forgets the fake would run a real `npm test`/Playwright/k6 inside a temp project. Only `testRunner.test.ts`'s default-filesystem case uses the real artifact-directory functions, and it still fakes spawn. Its real temp dirs are named `avos-test-run-*`, so clean those up too after a killed run.

The web app expects the daemon at `http://localhost:4500` by default — override with `VITE_SERVER_URL` in `web/`'s environment if you run the daemon on a different port.

## What it owns

- **`projects/`** (repo root, git-ignored) — a real folder per Project, created fresh by `POST /api/projects`, each with an empty `.docs/` folder and no pre-made subfolders or stub files. Every new software Project (blank or cloned) also gets a board item, 'Set up project documentation', started like any user-started task through the plan-item queue, on a fixed one-step documentation workflow (`projectService.ts`'s `startDocsBootstrapTask`, `plan.ts`'s `DOCS_BOOTSTRAP_WORKFLOW`); it writes the real docs from what the repository already has.
- **`server/data/`** (git-ignored) — the file-based database: `projects.json`, `tasks.json`, `task-contexts.json`, `plan-items.json`, `plan-item-queue.json`, `test-runs.json` (Test Run records), and `test-runs/` (one `<id>.log` and `<id>.result.json` per Test Run — see [`docs/testing-contract.md`](../docs/testing-contract.md#test-runs)). See `src/db/FileDatabase.ts`.
- **`catalog/`** (repo root, committed) — Templates and Skills (`catalog-index.json` + `agents/*.md` + `skills/*/SKILL.md`), full CRUD from the daemon's side.
- **`server/executors.json`** (git-ignored, machine-specific — see "Executors" below) — which CLI/account a Task can run as.
- Spawning real `claude -p` Workers (`src/worker/claudeProcess.ts`), one active Task per Project (`src/worker/workerManager.ts`), and the REST + WebSocket API (`src/api/`) the frontend talks to.

## Project plan & Tasks breakdown

Every Project gets five fixed markdown docs under `.docs/plan/` — Specifications, Requirements, Test Cases, End-to-End Testing, Performance Testing (`src/projects/plan.ts`) — stubbed at creation, self-healing if missing, and readable/writable at `GET`/`PUT /api/projects/:id/plan[/docs/:key]`. The Tasks breakdown is structured data, not parsed out of a markdown checklist: `PlanItemRecord` via `POST /api/projects/:id/plan-items`, `PATCH`/`DELETE /api/plan-items/:id` (a `priority` of `high`/`medium`/`low` can be sent on create or `PATCH`; items default to `medium`), `PUT /api/projects/:id/plan-items/order` (body `{ids, priority?}`: the listed items take that sequence within the order slots they already hold, plus `priority` if given, which is how the Tasks tab saves a swimlane drop), and `POST /api/plan-items/:id/execute` to run one for real — now a WorkflowRun through the Project's Workflow rather than a single bare Task; see "Task Workflows" below (`src/projects/planItemService.ts`). See `docs/architecture.md`'s "Project plan documents and the Tasks breakdown" for why this is structured data rather than markdown the daemon parses.

### Sequential plan-item execution queue

`POST /api/plan-items/:id/execute` (body: `{executorId?, workflowId?, createBranch?, skippedStepIds?}`) starts the item's WorkflowRun at once and returns `201` with its first step's `TaskRecord`; it never queues. A concurrency conflict or a busy in-place folder is a 409, and invalid options are a 400 (see the route's comment in `src/api/router.ts`). `skippedStepIds` names steps of the chosen workflow to leave out of this run; each is recorded as a skipped round and never started. The plan-item execution queue (`enqueuePlanItemExecution` in `src/worker/workerManager.ts`, `PlanItemQueueEntry` in `src/domain/types.ts`) is used only by testing setup today; an entry keeps its start options until it starts, and queue changes broadcast `{type: 'planItemQueue', projectId, entries}` over `/ws`. It has no REST routes.

## Milestones

A Milestone is a target state for a Project with its own definition of done, one plain markdown file per milestone under `.docs/milestones/` (`milestone-1.md`, `milestone-2.md`, ...). Milestone files are written by hand (nothing creates one at Project creation any more) (planning sessions no longer author milestones). `PlanItemRecord.milestoneId` links an item to a milestone, but nothing sets it any more; items linked by older planning sessions keep theirs. No DB record, API route, or UI tab of its own yet; a milestone file is read the same way any other repo file is, via the Code tab's file tree.

## Agent-driven planning chat

`POST /api/projects/:id/chat` is the workspace's persistent chat. It defaults to `kind: 'plan'`: a planning session, which runs **only** in an interactive CLI (a `claude-cli` or `codex-cli` executor — the only executor kinds that exist; see "Executors" below). With no `executorId` it uses the first CLI executor configured; an executor whose `kind` isn't one of those (a stale/hand-edited `executors.json` entry) is refused with 422 (`PlanningRequiresCliError`). The session's prompt is the user's message plus `PLAN_INSTRUCTIONS` in `plan.ts`, and nothing else: research the topic, talk it through with the user and ask questions until the requirement is unambiguous, then write one task per feature, each a self-contained feature specification (problem and goal, behaviour, rules, decisions, edge cases, scope, acceptance criteria) that describes what and why and leaves the implementation (file paths, code names, coding steps) to the coding agent. It is read-only, and its only output is tasks: Claude CLI runs it with `--disallowed-tools Bash,BashOutput,KillShell,Edit,Write,NotebookEdit` (`PLAN_DISALLOWED_TOOLS`), and Codex CLI, which has no per-tool deny flag, runs it with `--sandbox read-only --ask-for-approval never` whatever its autonomy (`readOnly` in `terminalSessionManager.ts`). It never changes repo files, so it needs no branch or worktree and can run beside coding Tasks (see `docs/architecture.md`'s "One task per project" entry). Pass `skipPlanning: true` to run the same message as a normal `kind: 'execute'` Task instead. See `docs/architecture.md`'s "Agent-driven planning" entry.

### Managing tasks from a planning session

A planning session manages its Project's open Tasks live, through a session-scoped stdio MCP server, `bin/plan-task-mcp.mjs` (`src/terminal/planTaskTool.ts`), registered through Claude's `--mcp-config` or Codex's `-c mcp_servers.*` overrides. Its tools are pre-approved (Claude's `--allowed-tools`, Codex's per-tool `approval_mode="approve"`); without that, Codex's `--ask-for-approval never` refuses every call with "MCP tool call requires approval". It exposes four tools, each relayed to an internal route that names the session with `?taskId=` and needs `Authorization: Bearer <per-daemon CLI hook token>`:

| Tool | Route | Does |
|---|---|---|
| `list_tasks` | `GET /api/agent-tasks` | the Project's PlanItems, in display order |
| `create_task` (`title`, `description`) | `POST /api/agent-tasks` | adds the next numbered item |
| `update_task` (`id`, `title?`, `description?`, `uiPlanningWaitsForParent?`) | `PATCH /api/agent-tasks/:itemId` | edits an item; refuses (409) one already `done` — further work on it goes in a new task — and the boolean setting on one that has started |
| `delete_task` (`id`) | `DELETE /api/agent-tasks/:itemId` | removes an item |

Each change is broadcast over `/ws` (`planItem` / `planItemDeleted`). The routes answer 401 without the token, 400 for bad input, 404 for an unknown task or an item in another Project, and 409 unless the caller is a `'plan'`-kind Task that is still `developing`, or when the item has a Task running.

Every planning session gets a number within its Project (`TaskRecord.planningSessionNumber`, kept by follow-ups), and every item it creates is titled `<session>.<task>: <title>`, the task number zero-padded to three digits (e.g. `3.002: Add login`) (`PlanItemRecord.planningRef`), numbered one past the highest the session already has. Editing a numbered item keeps its prefix. Task changes are serialized per Project, so concurrent `create_task` calls never share a number. Shell tools stay denied: an MCP tool is the one channel both CLIs expose to such a session.

The prompt (`PLAN_INSTRUCTIONS`, `src/projects/plan.ts`) makes the session interview the user before its first `create_task`, even for a short request, and confirm the scope, decisions and open assumptions before filing; each task must carry the specification completeness checklist (`src/projects/planningInterview.ts`, shared with the Plan & bugs prompt). Nothing on the routes enforces the confirmation: `create_task` still takes only `title` and `description`.

### Running configured tests from a coding session

Every coding session that may edit code (an `'execute'` Task, or a WorkflowRun step with `canEditCode` or `canRunCommands`) also gets a testing MCP server, `bin/test-task-mcp.mjs` (`src/terminal/testTaskTool.ts`, daemon side in `src/testing/agentTesting.ts`). Planning sessions and read-only steps without `canRunCommands` don't. Its tools relay to `/api/agent-testing` with `?taskId=` and the CLI hook token: `list_test_actions` (GET `/actions`), `run_test_action` (POST `/runs`, `{suiteId, actionId, waitSeconds?}`), `get_test_run` (GET `/runs/:runId?waitSeconds=`) and `run_all_tests` (POST `/run-all`). A call blocks up to `waitSeconds` (default 120, max 240) and answers with a compact report: status, counts, capped failures and findings, diagnostics and the output tail. A run still going when the wait ends comes back with `settled: false` and its run id, for `get_test_run`. The routes answer 401 without the token, 404 for an unknown Task or another Project's run, and 409 unless the Task is `developing`, still one of its Project's active Tasks, and allowed the tools. Runs go through the same Test Run engine as the Testing tab in the Task's own working tree, recorded with `trigger: "agent"` and the `taskId`.

**Boundary:** only configured Test Actions run through these tools (or from the Testing tab) are captured as Test Runs. Test commands an agent runs directly in its shell are never guessed at, parsed or recorded, however much they look like tests. The agent instructions (`TESTING_TOOL_INSTRUCTIONS`) say this explicitly.

### Testing setup: approval-gated, read-only until approved

The Testing tab's Set up / Reconfigure / Repair testing (`src/testing/setup.ts`, task 2.005) creates an ordinary PlanItem marked `testingSetup: { mode }` and runs it through the built-in testing-setup workflow, so it shows in Open Tasks and queues like any other item. The marker is set only by the daemon; the plan-item routes ignore it.

- `GET /api/projects/:id/testing/setup` returns the active setup (queued, running, awaiting approval, needing attention or failed), otherwise the latest completed one with `active: false`, otherwise `null`: `{ planItem, run, queueEntry, active }`.
- `POST /api/projects/:id/testing/setup {executorId?}` starts one (201) or returns the active one (200, `existing: true`). Starts are serialized per Project. The title follows the config in the Project's checkout: absent → "Set up testing", valid → "Reconfigure testing", invalid → "Repair testing" (its issues go into the task description).
- `POST /api/testing-setup/:runId/approve {proposalRound, comment?}` is the only thing that approves a proposal. `proposalRound` must be the round awaiting a decision (409 otherwise). `/workflow-runs/:id/approve` refuses a setup run.
- `POST /api/testing-setup/:runId/revise {comment}` asks for a revised proposal: a new round, still read-only. `POST /api/testing-setup/:runId/reject` stops the run with the Project unchanged. Both 409 on a run that isn't a testing setup.

What the daemon enforces: the Setup Proposal step runs read-only (Claude denied tools, Codex read-only sandbox) with no test tools, can't be skipped, and must complete with a proposal output. If its worktree changed anyway, the run needs attention and nothing is offered for approval. The Setup & Validation step may write only while the latest proposal round is `approved` (fail-closed). Its verdict `issues` loops back to a new read-only proposal, and its verdict `pass` is refused (422, with what is missing) until `.docs/testing/config.json` in its tree is valid and every enabled suite's primary action has a `passed`/`failed` agent run with a normalized result from this setup's own implementation Tasks. The last check is saved on the run as `testingSetup.evidence`. A rejected setup doesn't hold the plan-item queue. Only ordinary `planItem`/`workflowRun`/`stepRun`/`task` events are emitted. Full rationale: [`docs/architecture.md`](../docs/architecture.md#testing-setup-an-approval-gated-open-task).

## Executors — picking which account runs a Task

Every executor is an interactive CLI session (`"kind": "claude-cli"` or `"codex-cli"`) — there is no headless/structured `claude -p`/`codex exec` executor kind any more; every Task, including every WorkflowRun step, runs as a real terminal session in the project popup (see `docs/architecture.md`). The daemon never spawns a bare `claude` and hopes for the best: on a machine with multiple logged-in accounts (e.g. shell aliases like `claude-ab`/`claude-nik`, each a wrapper for `CLAUDE_CONFIG_DIR=~/.claude-ab claude`), the *plain* `claude` binary on `PATH` is often not logged in at all — spawning it fails, and the daemon reports that Task as `failed` (see `TaskRecord.failureReason`). Shell aliases don't apply to a spawned subprocess, so the fix isn't in your `.zshrc`, it's in `server/executors.json`.

Copy `server/executors.example.json` to `server/executors.json` (git-ignored — it names real local paths) and list every account you want available, e.g.:

```json
{
  "executors": [
    { "id": "claude-ds", "label": "Claude — ds", "kind": "claude-cli", "bin": "/Users/you/.local/bin/claude", "env": { "CLAUDE_CONFIG_DIR": "/Users/you/.claude-ds" } }
  ]
}
```

Hand-editing that file is no longer the only way in: the frontend's Settings page (`SettingsPanel.tsx`'s "Coding agents" section, `AgentsSettings.tsx`, opened from the top bar's gear button) adds/edits/removes executors through `POST`/`PATCH`/`DELETE /api/executors`, writing back to this same file (created from `executors.example.json` on the very first write if it doesn't exist yet). An added executor's `id` is slugified from its label, de-duplicated with a numeric suffix if needed; removing the last remaining one is refused (409, `LastExecutorError`) since `startTask` always needs at least one to fall back to.

`GET /api/executors` lists them; `POST /api/projects/:id/tasks` takes an optional `executorId` (defaults to the first entry). Both `claude-cli` and `codex-cli` run a Task today; any other `kind` (only reachable via a stale/hand-edited `executors.json` entry, since the settings API itself only accepts these two) is rejected with a 422 (`ExecutorNotSupportedError`) rather than silently failing.

## Branch listing and checkout

`GET /api/projects/:id/branches` runs a quiet `git fetch origin` (`git.ts`'s `fetchOrigin`) before listing `refs/heads`/`refs/remotes/origin`, so the branch picker always shows a fresh list rather than whatever was fetched the last time anyone looked — a fetch failure surfaces as an ordinary 409. `POST /api/projects/:id/branches` (`{branch, create?}`) checks it out; checking out a branch that exists only on the remote (no local ref yet) creates a real local tracking branch (`git switch -c <branch> --track origin/<branch>`) rather than relying on git's version-dependent auto-guessing. See `docs/architecture.md`'s "Fetch before listing or switching a Project's branches."

## Remote sync — noticing when a branch moves on GitHub

Checking out a branch locally is a snapshot: if someone pushes new commits to that same branch on GitHub afterward, nothing here would otherwise notice. `src/projects/gitSyncPoller.ts` closes that gap with a background sweep, independent of any Task or open UI tab: every 60s (`GIT_SYNC_REFRESH_MS`), it runs a quiet `git fetch origin` for every git-backed Project and compares `HEAD` against `origin/<branch>` (`git rev-list --left-right --count`), landing on one of `synced`/`ahead`/`behind`/`diverged`/`no-remote`/`unknown` (`GitSyncStatus`). Readings are kept in memory only (`ProjectSyncState` is never persisted — it's cheap to recompute and stale the moment another push happens), attached to every `GET /api/projects[/:id]` response as `sync`, and pushed live over `/ws` as a `projectSync` event the instant a fetch completes. The frontend's branch picker shows a sync button from this, turning red and glowing — the same "needs attention" treatment a failed Task's rooftop dot gets (`web/src/lib/buildingVisualStatus.ts`) — for `behind`/`diverged`.

Clicking that button doesn't call a bespoke sync endpoint that just succeeds-or-fails — it runs `git fetch && git merge --ff-only origin/<branch>` as a real, trackable **CommandRun**, the exact same mechanism as a user-defined Project Command (`src/commands/commandRunner.ts`'s `runProjectSync`, `POST /api/projects/:id/sync`), so the frontend's existing log popup shows the real command, its live output, and its actual success/failure/exit code — not just a toast. It's never a persisted `ProjectCommandRecord` though (a synthetic `commandId` of `sync:<projectId>` just reuses the same "can't run the same thing twice concurrently" guard), so it never shows up in the Commands settings tab's list of defined commands — its runs do still show up in that tab's History, same as any other command's. `--ff-only` means a diverged branch (local commits of its own) fails the run outright rather than silently rewriting anything. Once the run settles, `gitSyncPoller` is refreshed and rebroadcast immediately rather than waiting for its next scheduled tick.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4500` | HTTP + WS listen port |
| `CLAUDE_BIN` | `claude` | Fallback CLI binary when a Task's executor doesn't override `bin` |
| `AGENT_VISUAL_OS_PROJECTS_DIR` | `<repo>/projects` | Where Project folders are created — tests point this at a temp dir |
| `AGENT_VISUAL_OS_DATA_DIR` | `<repo>/server/data` | Where the file-based database lives — tests point this at a temp dir |
| `AGENT_VISUAL_OS_EXECUTORS_PATH` | `<repo>/server/executors.json` | Which executors config to read — tests point this at a fixture |
| `AGENT_VISUAL_OS_TEST_RUN_RETENTION` | `100` | Finished Test Runs kept per Project (active runs are never pruned) |
| `AGENT_VISUAL_OS_DEV_TYPES` | unset | `1` lets a Building of a developer-only type (Notes) be created; without it creating one is a 400 |
| `AGENT_VISUAL_OS_TEST_FAULTS` | unset | `1` lets tests inject storage faults (e.g. a disk-full error) into a Building's database worker; never set it outside tests |

## Task lifecycle

`POST /api/projects/:id/tasks` (or the chat/plan-item-execute entry points above) spawns a Worker (`claude -p`) scoped to that Project's folder. Every turn ends with a required `{"status": "done"|"blocked", "message": "..."}` result (enforced via `--json-schema`, confirmed reliable by the Phase 0 spike in `docs/architecture.md`; a `'plan'`-kind Task's schema also allows an optional `planTasks`):

- **`done`** → the Task completes, the Project returns to `idle`.
- **`blocked`** → the Project shows the question; `POST /api/tasks/:id/answer` resumes the same session (`--resume <sessionId>`) with the answer.
- A spawn or process error settles the Task as **`failed`** and frees the Project.
- Once a Task is `done` or `failed` (not `developing`/`blocked`), `POST /api/tasks/:id/followup` starts a **new** TaskRecord that resumes the same session with a fresh instruction — the Task itself never un-settles; see `docs/architecture.md`'s "Follow-up Tasks continue a session" entry.
- An interactive CLI Task (`claude-cli`/`codex-cli`) has no status result. Exiting the CLI or `POST /api/tasks/:id/stop` pauses it (`stopped`); `POST /api/tasks/:id/complete` finishes it.

If the settled Task was running one Tasks-breakdown PlanItem (`planItemId` set), the daemon mirrors its final status onto that item automatically.

**Task Workflows (task 3.012).** `POST /api/plan-items/:id/execute` no longer starts a bare `kind: 'execute'` Task — it starts a **WorkflowRun** through the Project's selected Workflow (Catalog CRUD at `GET/POST /api/catalog/workflows`, `GET/PUT/DELETE /api/catalog/workflows/:id`; a Project's choice at `PATCH /api/projects/:id/workflow`). Each Step of the run becomes its own Task, sharing the run's single git worktree/branch rather than each taking a separate concurrency slot; the run itself holds the Project's one queue-managed executor slot for its whole lifetime, including while paused for approval or attention. The old docs-and-retro completion flow (`POST /api/tasks/:id/docs-retro`, `TaskRecord.docsRetro`/`awaitingCompletionConfirmation`, the Yes/No completion question) is gone entirely — replaced by an ordinary Docs & Retro Step in the seeded default Workflow, and by the run's own built-in **Complete** stage (commit, push, `gh pr create` with a summarized description, a final report) once every Step finishes. `GET /api/projects/:id/workflow-runs` / `GET /api/workflow-runs/:id` read a run's full stage/round history; `POST /api/workflow-runs/:id/{approve,request-changes,loop,retry-step,stop}` drive it. A Step's own session reports itself through a generalized version of the planning MCP relay below (`complete_step`/`skip_step`/`diff_summary`/`diff_file`, via `bin/step-task-mcp.mjs`). Full decision record: `docs/architecture.md`'s "Configurable task Workflows" entry.

**Quick look (task 5.008).** A WorkflowStep's `quickLook` (`none` | `code` | `diff` | `documents` | `commands`, absent = none) decides what the run view offers for that step. The reads are read-only and resolve the run's directory first (`projects/quickLook.ts`'s `resolveRunLocation`): its worktree while that is on disk, the Project's folder for a run started without a separate branch, otherwise `removed`. `GET /api/workflow-runs/:id/quick-look` returns `{ kind, branch, baseBranch }` (never the path). `GET …/quick-look/code/tree`, `…/code/file?path=`, `…/docs/tree` and `…/docs/file?path=` use the Code and Documents tabs' path guards and also refuse any `.git` segment (400); on a removed working copy they answer 410. `GET …/quick-look/diff` lists changed files (`added`/`modified`/`deleted`/`renamed`, +/− counts, `binary`): for a worktree, the merge base with `baseBranch` against the files on disk (uncommitted and untracked work included); after removal, the kept branch against its base, read from the Project's folder (410 if either branch is gone); for a project-folder run, HEAD against the working tree (409 without a repository). `GET …/quick-look/diff/file?path=` diffs only a path in that list (404 otherwise). `POST /api/commands/:id/run` and `POST /api/projects/:id/commands/run-adhoc` take an optional `workflowRunId` to run in that run's working copy; the run records `location` (`{ kind: 'main' }` or `{ kind: 'task', workflowRunId, planItemId, branch, taskRef }`). A saved command still has one running instance wherever it runs (409). A removed working copy gives 410 and a run of another Project gives 400; nothing is spawned in either case.

**Restart recovery:** a Task still `'developing'` when the process last stopped has lost its CLI session, and nothing is relaunched automatically on the next startup (`workerManager.resumeInterruptedTasks`, called from `src/index.ts`): a workflow step Task is reported `needs-attention` on its run, and any other Task is paused like a plain CLI exit (work committed, `'stopped'`, resumable by hand via `POST /api/tasks/:id/resume`), or failed if it never recorded a session id. Relaunching on startup re-triggered the same Tasks on every `npm run dev` (`node --watch`) reload. `'blocked'` Tasks need no recovery — they're a normal finished turn waiting on a human, not an interrupted one.

## Known simplifications (not yet built)

- **Approval-gated autonomy doesn't truly pause.** `autonomy: 'approval'` runs the CLI's default permission mode, which denies a gated tool call outright rather than pausing for one (see the spike notes in `docs/architecture.md`). A real `PreToolUse`/`defer` relay is future work.
- **Codex executors are listed, not runnable.** `server/executors.json` can name a `"kind": "codex"` entry so it shows up in the picker, but `workerManager` rejects starting a Task against one — Codex's headless CLI flags, output format, and permission model haven't been researched or implemented.
- **No Manager/sub-agent delegation yet** (Phase 2 in `docs/roadmap.md`).
- **No git worktrees** — one active Task per Project only, per the v1 scope decision.
- **The plan-item execution queue only advances on `done`/`failed`/stopped, never on `blocked`** — a queue-managed Task that ends up `blocked` still holds its Project's one queue slot until a person answers it (or stops it); nothing auto-skips ahead to the next queued item in the meantime. See "Sequential plan-item execution queue" above.
- **The live transcript (`'log'` WorkerEvent) is now consumed** by both the quick popup's `TaskChat` and the workspace's `TaskDetailsView` — no longer a gap; `GET /api/tasks/:id/transcript` remains the direct way to inspect the full turn history yourself.
- **A Command Run's stored output has no size cap or rotation**, and stdout/stderr are interleaved into one string in arrival order rather than kept separate — see `commands/commandRunner.ts` and `docs/architecture.md`'s "Project Commands" decision. A command can't be started twice concurrently (`CommandAlreadyRunningError`), but there's no queueing beyond that.
