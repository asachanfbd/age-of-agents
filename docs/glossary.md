# Domain glossary

Precise definitions for every term used throughout this project's docs, code, and UI. Source of truth: [`docs/spec.md`](spec.md), "Domain glossary."

## Agent

The underlying unit of work: a real, running `claude` CLI process, scoped to one project's working directory.

## Worker

The visual character in the scene representing one active Agent. A Worker exists only while its Agent process is running, and appears at the Building for the project it is working on.

## Manager Agent

An Agent Template flagged as able to delegate sub-tasks to native Claude Code sub-agents during its run. Only a Manager, being the top-level process, can natively surface a clarifying question to the user; its delegated sub-agents cannot. See [`docs/architecture.md`](architecture.md#manager-and-sub-agent-flow-native-delegation-with-a-relay-for-questions) for how blocked sub-agent questions get relayed.

## Template

An agent persona in the Catalog: a name, avatar, base system prompt and skill set, a manager flag, and a default autonomy setting. No live process is attached to a Template. Assigning a Template to a task spawns a real Worker; when that Worker's task ends, it reverts to being a Template again.

## Building

The visual representation of one registered Project. Clicking a Building is how a new task, and the Template(s) to run it, gets assigned. Every Building has a [Building Type](#building-type); a Project stored before types existed reads as a Software Building.

## Building Type

A kind of Building, written in code and registered in `server/src/buildings/registry.ts` (Software is the first; Notes is a developer skeleton). A type provides its identity and 3D look, its own workspace popup, its create inputs and validation, its data storage, its workflow slots with defaults, the agents it uses, the default [scheduled jobs](#scheduled-job) its Buildings start with, and the [capabilities and events](connections.md) it offers to linked Buildings. Types are coded, not configured: only the workflow behind each slot and the agent behind each workflow step can be changed from the Catalog, per type. See [`docs/architecture.md`](architecture.md#building-types-are-coded-not-configured).

## Capability

A named operation a [Building Type](#building-type)'s code offers to other Buildings, with declared inputs and outputs, whether it only reads or changes things, and whether a person must approve it. A Building calls a capability of a linked Building and gets a result or an error. See [`docs/connections.md`](connections.md).

## Event

A named fact a Building publishes ("report published"). A linked Building subscribes to it and each event starts one of its own [scheduled jobs](#scheduled-job).

## Link

What a person allows between two Buildings: A may use chosen capabilities and events of B, and nothing in the other direction. Without a link every call is refused. Shown in the Connections view and as a line between the Buildings in the 3D scene.

## Activity log

Every call and event a Building took part in, with who made it, the result and a link to the run, per Building and filterable.

## Scheduled job

A job of one Building that starts a run on its own: on a cron schedule, or when a watched folder, file or API response changes. It runs one of the Building type's workflow slots or a single agent prompt, under guardrails (overlap rule, missed-run policy, budgets, approval, auto turn-off). See the [scheduler contract](scheduler.md).

## Workflow slot

A named place where a Building Type uses a workflow, with a built-in default workflow (Software has "Build a feature or change" and "Fix a bug"). The Catalog can point a slot at another workflow and can pick an agent for each step of it; a workflow that is later deleted falls back to the default with a visible notice.

## Bulk data layer

The per-Building store for large data (metrics, link graphs, customer histories): one SQLite database file per Building under `server/data/buildings/<id>/`, accessed from a worker thread, queried and paginated in the store, with maintained roll-up tables for aggregates, a retention rule, size warning and backup-protected migrations. Software Buildings do not use it; the central JSON store keeps the small records. See [`docs/architecture.md`](architecture.md#bulk-data-layer-one-sqlite-file-per-building).

## Retention rule

A Building Type's declared window for raw bulk data (for example "search metrics older than 12 months are discarded"). The store applies it on a schedule or on demand and shows the rule to the person; nothing is dropped except under it.

## Read-only Building

A Building that can be listed and opened but not changed: its type is no longer registered ("type unavailable"), its data is newer than the running code, or its last migration failed and was restored from backup. Reads answer normally; every change answers 409 with the reason.

## Home Base

The central hub in the scene showing the full Catalog of available Templates and skills, with controls to add, remove, or disable them.

## Task

A freeform, user-written description of work assigned to one Template (which becomes a Worker) on one Project. Version 1 allows one active Task per Project at a time. A Task has a **kind**: `'execute'` (real coding work — the default for "Start a task" and running a Tasks-breakdown item) or `'plan'` (the Project Popover's persistent chat's default — restricted to editing the Project's Plan, never project source). Once a Task settles (`done`/`failed`), a **follow-up** starts a new Task that resumes the same session with a further instruction, rather than reopening the finished one — see [`docs/architecture.md`](architecture.md#follow-up-tasks-continue-a-session-not-mutate-a-finished-one).

## Plan

A Project's five fixed markdown documents (Specifications, Requirements, Test Cases, End-to-End Testing, Performance Testing) plus its **Tasks breakdown** — a list of proposed units of work (title, description, status), each runnable on its own or as part of a batch, which is what running one for real starts a WorkflowRun from (see Workflow below). A Tasks-breakdown item optionally belongs to a Milestone (see below). Edited by the Project Popover's chat (by default; see Task's `'plan'` kind above), directly in the Popover, or by hand on disk under `.docs/plan/`. See [`docs/architecture.md`](architecture.md#project-plan-documents-and-the-tasks-breakdown).

## Milestone

A target state for a Project, with its own definition of done, broken down into Tasks-breakdown items tagged with that Milestone's id. One plain markdown file per Milestone (`milestone-1.md`, `milestone-2.md`, ...) under a Project's `.docs/milestones/`, agent-authored the same way the Blueprint is — proposed and updated by a `'plan'`-kind Task, never hand-invented by a Worker mid-Task. See [`docs/architecture.md`](architecture.md#milestones-a-projects-target-states-broken-into-tasks).

## Workflow

An ordered list of Steps in the Catalog that every executed PlanItem runs through — each Step run by exactly one Catalog agent, getting every earlier stage's outputs as input (referenced by file path, not pasted). Steps that may edit code (Development, Docs & Retro in the seeded default) do; every other Step is read-only. Stored as `catalog/workflows/<id>.json`, the same CRUD/enable/disable shape as a Template or Skill. A Project selects one (`ProjectRecord.workflowId`; unset means the Catalog default). See [`docs/architecture.md`](architecture.md#configurable-task-workflows-replace-the-docs-and-retro-completion-step).

## Step

One stage of a Workflow: a name, the agent/skills/executor-override/instructions it runs with, whether it may edit code, whether it pauses the run for a human's approval, and an optional **loop back** to an earlier Step (a review-type Step whose `issues` verdict re-runs that earlier Step and everything after it, up to a fixed number of rounds, before the run needs a human decision). Requirement analysis is not a Step or any part of a Workflow: it happens in the planning session, whose output (each task's description) is the specification the first Step receives. **Complete** (commit, push, raise a PR) is not a Step either; it is always built in as the last stage.

## WorkflowRun

One live run of a Workflow against one PlanItem — in its own git branch/worktree (`createBranch: true`), or in place in the Project's own folder on its checked-out branch (`createBranch: false`), which it then keeps to itself until it settles. Snapshots its Workflow at creation, so a later Catalog edit never changes an in-flight run. A run branched off an earlier still-unmerged run in the same planning session is **stacked** on it. See [`docs/architecture.md`](architecture.md#configurable-task-workflows-replace-the-docs-and-retro-completion-step).

## StepRun

One attempt at one Step within a WorkflowRun — a summary, its output artifacts, and (for a loop-origin Step) a pass/issues verdict. A Step gets a new StepRun, a new **round**, each time it's resumed for a request-changes reply, replayed by a loop, or manually retried; every round is kept, never overwritten.

## Catalog

agent-visual-os's collection of agent (Template) and skill definitions, living in its own repo-root `catalog/agents/` and `catalog/skills/` — format-compatible with Claude Code's own agent-markdown / `SKILL.md` shape, but a fully separate folder — with game-only metadata (avatar, manager flag, default autonomy, enabled, triggers) in a sidecar `catalog/catalog-index.json`. A Template or Skill created in-game is game content only, never a real, invocable Claude Code subagent/skill, and this repo's own dev-tooling agents/skills never surface as Catalog entries. It does not read or modify this repo's own real `.claude/` or the *user's* real `~/.claude/` configuration. See [`docs/architecture.md`](architecture.md#catalog-lives-in-its-own-repo-root-catalog-folder).

## Blueprint

A project's auto-maintained `.docs/blueprint.md`, written and updated by the Worker itself at the end of each Task following a fixed structure, describing what was built and what is proposed next.

## Project

One folder on disk, either created empty or cloned from an existing repository, and either way managed entirely by agent-visual-os. Shown in the scene as one Building. Each Project keeps its own `.docs/` folder with its Blueprint, Milestones, plus notes, decision logs, tasks, and a roadmap, all as markdown. Cloning an existing repository auto-starts a `'plan'`-kind Task that reads whatever documentation the repository already has and uses it to fill in the Project's plan documents and first Milestone, rather than leaving them as blank stubs — see [`docs/architecture.md`](architecture.md#cloning-a-repository-bootstraps-its-docs-from-what-already-exists).

## Project Command

A user-defined shell command, scoped to one Project and run from that Project's own root directory on demand — a plain subprocess, not a Task: no Template, no Worker, no LLM involved. Defined and run from the Project Popover's Commands tab; up to 3 per Project can be **highlighted**, showing as one-click buttons on the Popover's header, with the rest reachable through a "⋯" menu. Each execution is a **Command Run** (status, exit code, streamed output), viewable live in a small log popup and, afterward, in Commands → History. See [`docs/architecture.md`](architecture.md#project-commands-user-defined-shell-commands-not-tasks).

## Test Suite

A logical category of tests in one Project: `unit`, `integration`, `e2e`, `performance`, `security`, `accessibility`, `contract` or `custom`. Declared in the Project's committed `.docs/testing/config.json` with a stable id. A suite has one or more Test Actions, and exactly one of them is its **primary** action, the one "Run all" runs. See [`docs/testing-contract.md`](testing-contract.md).

## Test Action

A named shell command that belongs to one Test Suite, identified by suite id plus action id. A **result** action produces a test outcome that may replace that suite/action's latest result. A **utility** action (for example "Update snapshots") keeps its log but never changes test status.

## Collector

A declaration on a Test Action that names one machine-readable report the command writes into its Test Run's artifact directory, along with the report's format: JUnit XML, LCOV, Cobertura XML, SARIF, or the Agent Visual OS result JSON. Collectors are the only way results reach agent-visual-os. The UI never parses a framework's own output.

## Test Run

One execution of one Test Action: `queued`, `running`, then `passed`, `failed` (a valid report said tests failed), `error` (no trustworthy result, e.g. a missing report or a daemon restart) or `stopped`. It gets its own daemon-created artifact directory, passed to the command as `AGENT_VISUAL_OS_TEST_ARTIFACTS_DIR`. A **manual** run uses the Project's primary working tree; an **agent** run uses its Task's worktree. Runs go through one queue per Project, one at a time. **Run all** queues every enabled suite's primary action as one batch. History and logs live in the daemon's central data directory, not in the Project's `.docs/`. See [`docs/testing-contract.md`](testing-contract.md#test-runs).

## Testing Setup

The Open Task behind the Testing tab's "Set up testing", "Reconfigure testing" or "Repair testing". An agent reads the repository read-only and writes a **setup proposal**: frameworks found, suites and actions, exact file and dependency changes, and costs such as install size, runtime, services and credentials. The task then waits for the person. Only an explicit approval of that proposal round lets it change the Project, and it counts as done only once every enabled suite's primary action has produced a result through the test tools. Feedback produces a revised proposal, still read-only; rejecting it stops the task with the Project unchanged. See [`docs/architecture.md`](architecture.md#testing-setup-an-approval-gated-open-task).

## Notification

One reported event raised through the app's shared notification primitive: a **kind** (what raised it — a Task needing input or failing or completing, a Project Command failing, a git-sync conflict, a Catalog skill install failing, and a couple of smaller producers), a fixed severity per kind, and a **subject** (what it's about and where clicking it goes — a Task's conversation, a Command, a Project, or a Catalog skill). Two independent timestamps replace a single status: `readAt` (has the user seen it — their call) and `resolvedAt` (is the condition that raised it still true — the system's call); resolving also marks read. Raising is an upsert keyed by kind + subject identity: a fresh occurrence of the same still-unresolved condition updates the existing Notification in place and marks it unread again, rather than piling up duplicates. Surfaced as a Building's rooftop dot (unread-and-unresolved only), a toast, and the Notifications drawer, with a one-click quick action (reply, retry, run again, sync) where one applies. See [`docs/milestones/milestone-5-notification-system.md`](milestones/milestone-5-notification-system.md).

## How the terms relate

```
Home Base ── shows ──> Catalog ── contains ──> Templates
                                                    │
                                          assign to a Task
                                                    │
                                                    v
                                                 Worker  <── real process ──  Agent
                                                    │
                                            appears at the
                                                    │
                                                    v
                                                Building  <── represents ──  Project
                                                                                 │
                                                                          writes .docs/
                                                                                 │
                                                                                 v
                                                                    Blueprint, Milestones
```

A Manager Agent's Worker can spawn native sub-agents mid-Task; those sub-agents are not separate Workers on screen (see [`docs/architecture.md`](architecture.md#manager-and-sub-agent-flow-native-delegation-with-a-relay-for-questions)).

Each Project also has its own Plan, opened from its Building's Popover; a Plan's Tasks breakdown is what "Execute" in that view turns into a real Task.
