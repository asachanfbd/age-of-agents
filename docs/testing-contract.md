# Project testing contract (v1)

The contract every Testing-tab feature builds on: the config file and how it is validated, the environment a test command receives, the Agent Visual OS result format, how each Collector format is normalized, and how the daemon runs Test Actions and keeps their history. The Testing tab UI (`web/src/ui/project-popup/TestingPanel.tsx`, task 2.006) consumes exactly this normalized model and nothing framework-specific — see "The Testing tab UI" below. For why the contract is shaped this way, see [`architecture.md`](architecture.md#project-testing-contract-one-framework-neutral-config-per-project). For the terms, see [`glossary.md`](glossary.md#test-suite).

Code: `server/src/testing/` (`types.ts` is the source of truth for the config and result shapes; `config.ts` loads and validates; `result.ts` validates the result format; `artifacts.ts` resolves Collector paths; `collectors.ts` parses reports; `runLog.ts` bounds logs; `runFiles.ts` stores each run's log and result; `testRunner.ts` queues and runs actions). `TestRunRecord` is in `server/src/domain/types.ts`. The client mirror is in `web/src/lib/serverApi.ts`.

## Where things live

| What | Where | Owner |
| --- | --- | --- |
| Testing config | `<project>/.docs/testing/config.json` | The Project. Committed and edited by agents or people. The daemon reads it fresh on every request and never writes it. |
| Test Run history | the daemon's central data directory (`server/data/test-runs.json`) | The daemon |
| A run's log and full result | `server/data/test-runs/<run id>.log` and `<run id>.result.json` | The daemon |
| A run's report files | a per-run artifact directory the daemon creates | The daemon creates it; the test command writes into it |

## Config file

```json
{
  "schemaVersion": 1,
  "suites": [
    {
      "id": "unit",
      "label": "Unit tests",
      "kind": "unit",
      "description": "Fast, isolated tests for the API package.",
      "primaryActionId": "run",
      "actions": [
        {
          "id": "run",
          "label": "Run unit tests",
          "purpose": "result",
          "workingDirectory": "packages/api",
          "command": "npm test -- --reporter=junit --output=\"$AGENT_VISUAL_OS_TEST_ARTIFACTS_DIR/junit.xml\"",
          "collectors": [
            { "id": "cases", "format": "junit-xml", "path": "junit.xml" },
            { "id": "coverage", "format": "lcov", "path": "coverage/lcov.info" }
          ]
        },
        {
          "id": "update-snapshots",
          "label": "Update snapshots",
          "purpose": "utility",
          "workingDirectory": "packages/api",
          "command": "npm test -- --update-snapshots"
        }
      ]
    },
    {
      "id": "load",
      "label": "Load test",
      "kind": "performance",
      "primaryActionId": "k6",
      "actions": [
        {
          "id": "k6",
          "label": "Run k6 smoke load",
          "command": "k6 run load/smoke.js && node scripts/k6-to-avos.mjs > \"$AGENT_VISUAL_OS_TEST_ARTIFACTS_DIR/result.json\"",
          "collectors": [{ "id": "summary", "format": "avos-result", "path": "result.json" }]
        }
      ],
      "metrics": [
        { "key": "p95-latency", "label": "p95 latency", "unit": "ms", "direction": "lower-is-better" }
      ]
    }
  ]
}
```

A fuller example with pytest (JUnit + Cobertura), Semgrep (SARIF) and a disabled custom PHP suite is at `server/tests/fixtures/testing/config.json`.

### Fields

**Top level**

| Field | Type | Rules |
| --- | --- | --- |
| `schemaVersion` | number | Required, must be `1`. Any other value (or none) stops validation with `unsupported-schema-version`. |
| `suites` | array | Required. May be empty. |

**Test Suite** (`suites[]`)

| Field | Type | Rules |
| --- | --- | --- |
| `id` | id | Required, unique across suites. |
| `label` | string | Required. |
| `kind` | enum | Required: `unit`, `integration`, `e2e`, `performance`, `security`, `accessibility`, `contract` or `custom`. |
| `description` | string | Optional. |
| `enabled` | boolean | Default `true`. |
| `primaryActionId` | id | Required. Must name a `result` action in this suite, and that action must be enabled while the suite is. "Run all" runs this action. |
| `actions` | array | Required, at least one. |
| `metrics` | array | Optional display metadata for metrics a Collector reports (see below). |

**Test Action** (`actions[]`)

| Field | Type | Rules |
| --- | --- | --- |
| `id` | id | Required, unique within its suite. An action is identified by `suiteId` + `actionId`. |
| `label` | string | Required. |
| `purpose` | enum | `result` (default) or `utility`. A `result` action's run may replace that suite/action's latest result. A `utility` action ("Update snapshots", "Clear cache") keeps its log but never changes test status, and cannot declare collectors. |
| `command` | string | Required. A shell command line. |
| `workingDirectory` | relative path | Default `.` (the Project root). Normalized to POSIX form. |
| `enabled` | boolean | Default `true`. |
| `collectors` | array | Optional. |

**Collector** (`collectors[]`)

| Field | Type | Rules |
| --- | --- | --- |
| `id` | id | Required, unique within its action. |
| `format` | enum | `junit-xml` (cases and counts), `lcov` or `cobertura-xml` (coverage), `sarif` (security findings), `avos-result` (the result format below). Anything else is `unsupported-format`. |
| `path` | relative path | Required. Relative to the run's artifact directory, and must name something inside it. |

**Metric display** (`metrics[]`)

| Field | Type | Rules |
| --- | --- | --- |
| `key` | id | Required, unique within the suite. Matches a result metric's `key`. |
| `label` | string | Required. |
| `unit` | string | Optional (`ms`, `req/s`, `%`). |
| `direction` | enum | `lower-is-better`, `higher-is-better` or `neutral` (default). |

An **id** is 1–64 characters of lowercase letters, digits, `-` and `_`, starting with a letter or digit. Unknown keys are ignored, so a later minor addition doesn't break v1 readers.

### Paths

A `workingDirectory` or collector `path` is rejected with `unsafe-path` when it:

- is absolute (`/x`, `C:\x`, `c:/x`, `\\server\share`),
- has a `..` segment anywhere, even one that would cancel out (`a/../b`),
- contains a NUL byte,
- for a collector path only, resolves to the artifact directory itself (`.`, `./`).

Backslashes are treated as separators. On top of these syntax checks, reading a report goes through `resolveCollectorArtifactPath`, which also resolves symlinks and refuses any target outside the run's artifact directory. The config file is read the same way: a `config.json` symlinked to a file outside the Project comes back as `unsafe-path`.

## Reading the config: `GET /api/projects/:id/testing/config`

Returns 200 with one of three states for a known Project, and 404 for an unknown one:

```json
{ "state": "absent", "path": ".docs/testing/config.json" }
```

```json
{ "state": "valid", "path": ".docs/testing/config.json", "config": { "schemaVersion": 1, "suites": [ ... ] } }
```

```json
{
  "state": "invalid",
  "path": ".docs/testing/config.json",
  "issues": [
    { "code": "duplicate-id", "path": "suites[1].id", "message": "duplicate suite id \"unit\"" },
    { "code": "unsafe-path", "path": "suites[0].actions[0].workingDirectory", "message": "workingDirectory \"../x\" must be a relative path that stays inside its base directory" }
  ]
}
```

- `absent` is a normal state: the Project hasn't set up testing yet.
- A `valid` config has every default filled in, so consumers never apply defaults themselves.
- `invalid` lists every issue found in one pass, for a "Repair testing" flow. Issue codes: `unreadable`, `malformed-json`, `unsupported-schema-version`, `unsupported-format`, `invalid-value`, `invalid-id`, `duplicate-id`, `unsafe-path`, `missing-primary-action`. An issue's `path` points into the document (`suites[0].actions[1].id`). It is empty when the problem is the whole file.

## The run environment

The daemon creates one empty artifact directory per Test Run and pass its absolute path to the command as **`AGENT_VISUAL_OS_TEST_ARTIFACTS_DIR`** (`TEST_ARTIFACTS_DIR_ENV` in `types.ts`). Commands write their reports there. Collector `path`s are relative to it. The command runs through the shell from `workingDirectory`.

## Agent Visual OS result format (`avos-result`, v1)

For results the standard formats can't express, such as performance numbers, custom scores, or a tool with no JUnit output, a command writes this JSON into its artifact directory. It doesn't assume any language or framework.

```json
{
  "format": "agent-visual-os.test-result",
  "schemaVersion": 1,
  "outcome": "failed",
  "durationMs": 61234,
  "counts": { "total": 3, "passed": 2, "failed": 1, "skipped": 0 },
  "metrics": [
    { "key": "p95-latency", "label": "p95 latency", "value": 412.5, "unit": "ms",
      "threshold": { "operator": "lte", "value": 300 }, "status": "fail" }
  ],
  "findings": [
    { "id": "slow-checkout", "ruleId": "latency-budget", "severity": "medium",
      "title": "Checkout exceeds latency budget", "location": { "path": "load/smoke.js", "line": 42 } }
  ],
  "cases": [
    { "name": "POST /checkout", "group": "smoke", "outcome": "failed", "message": "p95 412.5ms > 300ms" }
  ]
}
```

| Field | Rules |
| --- | --- |
| `format`, `schemaVersion` | Required: exactly `"agent-visual-os.test-result"` and `1`. |
| `outcome` | Required: `passed`, `failed`, `error` or `skipped`. |
| `durationMs` | Optional, non-negative. |
| `counts` | Optional object of non-negative whole numbers: `total`, `passed`, `failed`, `errored`, `skipped`. |
| `metrics[]` | `key` and finite `value` required; optional `label`, `unit`, `threshold` (`operator`: `lt`/`lte`/`gt`/`gte`/`eq`, plus `value`), and `status` (`pass`/`warn`/`fail`), which is the producer's own verdict against its threshold. |
| `findings[]` | `severity` (`critical`/`high`/`medium`/`low`/`info`) and `title` required; optional `id`, `ruleId`, `description`, `location` (`path`, `line`). |
| `cases[]` | `name` and `outcome` required; optional `id`, `group`, `durationMs`, `message`. |

The complete example is `server/tests/fixtures/testing/avos-result.json`. `parseAvosResult` in `server/src/testing/result.ts` validates a document and returns it normalized or with its issues, using the same issue shape as the config.

## Collectors: how each format is normalized

Every Collector's report becomes the same normalized result (the `avos-result` shape without `format`/`schemaVersion`). An action with several Collectors gets one merged result: the worst outcome wins (`error` > `failed` > `passed` > `skipped`), counts are summed, `durationMs` is the largest, and metrics, findings and cases are concatenated. A metric with `status: "fail"` fails the merged result.

| Format | What is read | Outcome |
| --- | --- | --- |
| `junit-xml` | Every `<testcase>`: `name`, `classname` (as `group`), `time`, and a `<failure>`/`<error>` message or `<skipped>`. Counts come from the cases. Root `time` becomes `durationMs`. | `failed` if any case failed or errored, `skipped` if none passed, else `passed`. |
| `lcov` | `LF/LH`, `BRF/BRH`, `FNF/FNH` summed over all files, reported as `line-coverage`, `branch-coverage` and `function-coverage` metrics in `%`. | Always `passed`. Put coverage thresholds in an `avos-result`. |
| `cobertura-xml` | The root `<coverage>` element's `line-rate` and `branch-rate`, as `line-coverage` and `branch-coverage` in `%`. | Always `passed`. |
| `sarif` | Every unsuppressed result in every run, as a finding with its rule id, message and first location. Severity comes from a numeric `security-severity` on the result or its rule (≥9 critical, ≥7 high, ≥4 medium, >0 low, 0 info), else from `level` (`error` high, `warning` medium, `note` low, `none` info). | `failed` if any finding is critical or high, else `passed`. |
| `avos-result` | The document as validated by `parseAvosResult`. | Its own `outcome`. |

A report that isn't recognizably its format (no `<testsuite>`, no `SF:` record, no `<coverage>`, no `runs` array, an invalid `avos-result`) is **malformed**. As a sanity limit against a pathological report, a run stores at most 20,000 cases (non-passing kept first) and 5,000 findings (most severe first). When anything is dropped the run gets a `truncated` diagnostic; counts still reflect the full report.

## Test Runs

A Test Run is one execution of one Test Action. Its record is stored centrally in `server/data/test-runs.json` (`TestRunRecord` in `server/src/domain/types.ts`) and stays small: status, metadata, diagnostics and a result **summary** (outcome, duration, counts, metrics, and finding counts by severity). Its log and full result (every case and finding) are in their own files, `server/data/test-runs/<run id>.log` and `<run id>.result.json`, because the database file is held in memory and rewritten on every change. It keeps a snapshot of the suite (`id`, `label`, `kind`) and action (`id`, `label`, `purpose`, `command`, `workingDirectory`, `collectors`), so history stays readable after the config renames or removes them.

### Lifecycle

| Status | Meaning |
| --- | --- |
| `queued` | Waiting for the Project's test queue. |
| `running` | The command is running. |
| `passed` | A valid report passed, or (no Collectors / utility action) the command exited 0. |
| `failed` | A valid report says cases or thresholds failed, or the command exited nonzero with no Collectors. A report that passed while the command exited nonzero is also `failed`, with an `exit-code-mismatch` diagnostic. |
| `error` | No trustworthy result: the command couldn't start (`spawn-failed`), a declared report is missing, unreadable or outside the artifact directory (`artifact-missing`, `artifact-malformed`, `artifact-unsafe-path`), the report's own outcome is `error`, the action vanished from the config before it started (`config-unavailable`), its working directory escapes the tree (`unsafe-working-directory`), or the daemon restarted mid-run (`interrupted`). |
| `stopped` | Someone stopped it. It has no verdict. |

A run always keeps both its `exitCode` and its normalized result: a failing test runner usually exits nonzero, and its report is still parsed. Every problem is kept in `diagnostics` (`{ code, message, collectorId? }`).

A **utility** action's run records `passed`/`failed` from its exit code and keeps its log, but has no result and never counts as a latest result.

### Latest results

The latest result for a suite, or one action of it, is its newest `passed`, `failed` or `error` run of a `result` action **on the Project's primary working tree**. Utility runs, stopped runs, queued/running runs, and agent runs in a Task's worktree never replace it. An agent's worktree run is often red partway through a change, and it says nothing about the primary tree; it still appears in History and in the queue.

### Where and how a run executes

- The config is read again when the run leaves the queue, from its execution root. What actually ran is what the snapshot records.
- **Manual runs** (from the UI or REST without a `taskId`) run against the Project's primary working tree.
- **Agent runs** pass a `taskId`: they run in that Task's own cwd (its worktree if it has one), record `trigger: "agent"` and the Task id, and read the config from that tree.
- The command runs through the shell (`spawn(command, { shell: true })`, as Project Commands do) from `workingDirectory` resolved under the execution root, symlinks included. It runs in its own process group so Stop reaches the whole tree: SIGTERM, then SIGKILL after 5 seconds.
- A run settles when the command exits and its output pipes close. If the command exits but a background process it started (`node server.js & npm test`) keeps the pipes open, the run waits 2 seconds, stops the rest of the process group, and settles on the command's own exit code with a `background-processes-stopped` diagnostic. Otherwise one leftover server would block the Project's queue indefinitely.
- Runs from different Projects share a global limit (default 2, `AGENT_VISUAL_OS_TEST_MAX_CONCURRENT_RUNS`); the rest stay `queued` until a slot frees. A run still going after 15 minutes (`AGENT_VISUAL_OS_TEST_RUN_TIMEOUT_MS`) is stopped and settles as `error` with a `timed-out` diagnostic, so a hung suite cannot hold its slot or its Project's queue forever.
- Because test commands have their own process groups, a Ctrl-C to the daemon wouldn't reach them on its own. The daemon sends SIGTERM to every running test on SIGINT, SIGTERM or a normal exit. A process that ignores SIGTERM, or one still running after a hard crash (SIGKILL, power loss), can outlive the daemon.
- `branch` and `commit` come from `git rev-parse` in the execution root and are `null` outside a repository or on a detached HEAD.
- A fresh artifact directory is created under the OS temp directory for each run, passed as `AGENT_VISUAL_OS_TEST_ARTIFACTS_DIR`, parsed after the process exits and always removed afterwards. A failed removal adds an `artifact-cleanup-failed` diagnostic.

### Queue

Each Project has one test queue, so heavy suites never overlap: one run at a time, in the order they were queued. **Run all** queues every enabled suite's primary action in config order, groups them under one `batchId`, and keeps going after a failure. An action can't have two queued/running copies on the same working tree (an agent's worktree copy doesn't block a manual one); **Run all** skips those suites and lists them under `skipped`. It fails with 409 if nothing could be queued.

A queued run can be removed (it leaves no history). A running run can be stopped; the next queued run starts once its process has exited. Stop has no effect once the command has already ended: a run that is only finishing up (parsing reports, saving) keeps its verdict.

When the daemon starts, any run still `queued` or `running` from the previous process becomes `error` with an `interrupted` diagnostic, and its artifact directory is removed. Its result can't be collected any more, whether or not a leftover process is still running.

Deleting a Project first drops its queue, stops its running test and waits up to 6 seconds for it to exit, then deletes all of its run records and log/result files before the Project's folder is removed. No Notification is raised for the stopped run.

The step that saves a finished run can't wedge the queue. If part of it fails, the run keeps its verdict with a diagnostic (for example, a result file that couldn't be written). The next run still starts, and never alongside another one.

### Logs and retention

Combined stdout and stderr are appended to the run's log file as they arrive. Only a runaway command is cut (`runLog.ts`): once the file holds 5,000,000 characters, the rest is kept as a rolling 200,000-character tail in memory and appended when the run ends, behind a line saying how many characters were left out. So both the start (setup errors) and the end (the runner's summary and failures) survive, and `outputTruncated` says whether anything was left out. `GET /api/test-runs/:runId` returns the live log while a run is going, tail included. The live `testRunLog` WebSocket events carry every chunk. If the log file can't be written (a full disk, say), the run still finishes and gets a `log-write-failed` diagnostic.

Each Project keeps its newest 100 finished runs (`AGENT_VISUAL_OS_TEST_RUN_RETENTION`); pruning a run deletes its log and result files too. Queued and running runs are never pruned.

A manual run that ends `failed` or `error` raises a `warning` Notification with `originFeature: "testing"`. Agent runs don't, since failing tests are a normal step while an agent works.

### REST

| Method and path | Does |
| --- | --- |
| `GET /api/projects/:id/testing` | Overview: `{ config, suites, queue }`. `config` is the config state above. `suites` (empty unless the config is valid) lists each suite's `latestResult` and, per action, `latestResult` (always null for utility actions), `latestRun` (newest finished run of any status) and `activeRun` (queued/running), all on the primary working tree. `queue` is the running run followed by the queue, in order. |
| `GET /api/projects/:id/test-runs` | History, newest first: `{ runs, total, limit, offset }`. Filters `suiteId`, `actionId`, `status`. `limit` 1–100 (default 25), `offset` default 0. Runs come as records, with `summary` but no log or full result. |
| `GET /api/test-runs/:runId` | One run with `output` (its log) and `result` (the full normalized result, or null), read from its files. |
| `POST /api/projects/:id/test-runs` | Body `{ suiteId, actionId, taskId? }`. Queues one action. 201 with the run. |
| `POST /api/projects/:id/test-runs/run-all` | Body `{ taskId? }`. 201 with `{ batchId, runs, skipped }`. |
| `POST /api/test-runs/:runId/stop` | Stops a running run (a finished one is returned unchanged). 409 for a queued run. |
| `DELETE /api/test-runs/:runId` | Removes a queued run. 204, or 409 if it isn't queued. |

Errors: 400 for a malformed body or query, 404 for an unknown project, run, suite, action or Task, 409 for a missing or invalid config, a disabled suite or action, a duplicate queued/running copy, or an empty Run all.

### WebSocket events

Broadcast on `/ws` next to the Command Run events:

- `{ type: "testRun", run }`, the run record (with `summary`, no log or full result), on every status change (queued, running, finished, stopped)
- `{ type: "testRunLog", runId, projectId, chunk }`, each output chunk as it arrives
- `{ type: "testRunRemoved", runId, projectId }`, when a queued run is removed

## The Testing tab UI (task 2.006)

`web/src/ui/project-popup/TestingPanel.tsx` is the only framework-aware-looking surface in the app that is, in fact, entirely framework-neutral: every piece of it is built from the config/result shapes above, never from a specific test runner's own output. The view-model helpers that decide wording/state from that data (and nothing else) live in `web/src/lib/testingPanel.ts`, unit-tested in `web/tests/testingSetup.test.mjs` without a DOM; `web/tests/testingIntegration.test.mjs` exercises the whole client (`serverApi` + the store) against `web/tests/serverStub.mjs`'s in-memory testing routes end to end (no config → start setup → approve → valid config → run a suite → history).

- **Config state → entry point.** `absent` shows "Set up testing"; `invalid` shows its `ContractIssue`s and "Repair testing"; `valid` shows "Reconfigure testing". All three start the same testing-setup PlanItem (task 2.005); the config itself stays editable through Documents for manual/advanced use.
- **Stat cards.** Exactly three — Passed, Failed, Coverage — computed only from enabled suites' latest *result*-producing primary actions. A suite that hasn't reported counts yet reads "Not reported", never "0" (`statCards`/`overviewStats`'s `countsReported`). Findings never get a 4th card: a security/performance finding is not a test case, so they surface on their own suite row and in a run's detail view instead.
- **Suite rows.** One per suite in the *current* config (kind, latest badge, counts/metric summary, duration, relative time, trigger, branch/Task). Since a row only ever exists for a suite the current config still has, a suite row can never be "stale" — only a *kept run* (history, queue, detail) can reference a suite/action the config has since dropped (`runStaleness`), which is where the stale warning actually shows.
- **Run all / per-suite actions.** "Run all" enqueues every enabled suite's primary action, guarded (`runAllGuard`) against enqueuing a second full batch while the first is still entirely in flight; each suite also offers its configured alternates (smoke/full/with-coverage, …) and utility actions (e.g. "Update snapshots" — log-only, never changes latest status) via its own menu.
- **Run detail.** Renders by what the result actually carries — `cases`/`metrics`/`findings` independently (`resultSections`), not a hardcoded switch on suite `kind` — so one result can show more than one section (e.g. a coverage run that also reports cases). The log tab renders ANSI color codes via `lib/ansi.ts`'s `parseAnsi` (never `dangerouslySetInnerHTML`) and streams live over the `testRunLog` WS event; the result tab refetches once a run settles, to pick up the full result a status-only event doesn't carry.
- **Approval gate, inline.** At `awaiting-approval`, the tab shows the same read-only notice and round-aware Approve/Request changes/Reject controls as the run detail view's own gate — both render `SetupProposalDecision.tsx`, so there is exactly one implementation of "decide on a setup proposal," not two copies that could drift.
- **Not yet implemented:** execution/dependency graphs (explicitly out of scope — frameworks don't expose consistent instrumentation for it); "load more" pagination on run history (`listTestRuns` already supports `offset`; the tab just doesn't offer a control for it yet).
- **Known limitation: Task links aren't always clickable.** `TaskContextLink` (in `TestingPanel.tsx`) renders a real "Task <id>" link only when that Task's `workflowRunId` is already known client-side (`tasksById`) — true for a Task running as a workflow step (e.g. testing-setup), not for an ordinary freeform/execute Task, since `TasksPanel`'s `initialRunId`/`useCardDetail` only resolves WorkflowRun ids, not arbitrary Task ids. An agent-triggered run on a plain Task shows non-clickable "Task <id>" text instead. Fixing this fully needs a new "open Task by id" prop threaded through `ProjectWorkspaceModal`/`TasksPanel`.
