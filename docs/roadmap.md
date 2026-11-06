# Roadmap


### Core Architecture & Orchestration
- [x] Confirmed headless `claude -p` process ending turn and resuming end-to-end.
- [x] The background daemon spawning and tracking a `claude -p` subprocess.
- [x] The central state store.
- [x] Manual project registration.
- [x] A small Catalog.
*Notes: What this proved and what it changed: [`docs/architecture.md`](architecture.md#confirmed-by-spike-2026-09-12). Full test log: [`docs/research/real-agent-orchestration-options.md`](research/real-agent-orchestration-options.md), "Empirical spike, 2026-09-12."*

### UI Base & Project Popover
- [x] A scene with one Building and the Home Base.
- [x] Hover tooltips.
- [x] The wave-and-popover-into-chat flow for questions.
- [x] The read-only terminal transcript.
- [x] Full-fledged Project Popover with detailed UI (tabs/sidebar) managing the project plan.
- [x] Dedicated sections for Specifications, Requirements, Tasks, Test cases, etc.
- [x] Persistent chat area at the bottom of the popover.
*Notes: Decisions along the way: [`docs/architecture.md`](architecture.md#project-plan-documents-and-the-tasks-breakdown) (the plan docs + Tasks breakdown data model), [`docs/architecture.md`](architecture.md#a-buildings-click-opens-its-full-project-workspace-directly) (why a building's click goes straight to the full workspace), and the amended [`docs/architecture.md`](architecture.md#read-only-terminal-transcript-in-version-1) entry (chat bubbles). Current implementation detail: [`docs/blueprint.md`](blueprint.md).*

### Task Execution & Planning

Planning conversations and unstarted tasks now share the first column of the Tasks board. See [Unified Planning board](unified-planning-board.md) for grouping, completion, restoration, and archive behavior.
- [x] Agent-authored blueprint written at task end.
- [x] Agent-driven Planning Phase (instructions default to modifying plan).
- [x] UI to execute a single task or a group of tasks sequentially.
- [x] Task details button to view history and output.
- [x] Detailed task info pop-up showing the agent's work.
- [x] Interactive task-specific chat within the details pop-up.
- [x] Surface task-specific clarifying questions from the agent directly in the details pop-up.
- [x] Milestones: agent-authored target states under `.docs/milestones/`, broken into real Tasks-breakdown items.
- [x] Cloning an existing repository auto-runs a Task that reads its existing docs and drafts the plan docs/first milestone from them, instead of leaving blank stubs.
*Notes: Relevant architecture decisions: [`docs/architecture.md`](architecture.md#agent-driven-planning-a-restricted-task-kind-not-a-separate-agent) (the planning-chat Task kind and its enforcement), [`docs/architecture.md`](architecture.md#follow-up-tasks-continue-a-session-not-mutate-a-finished-one) (replying to a Task after it's already finished), [`docs/architecture.md`](architecture.md#milestones-a-projects-target-states-broken-into-tasks) (Milestones), and [`docs/architecture.md`](architecture.md#cloning-a-repository-bootstraps-its-docs-from-what-already-exists) (the clone docs-bootstrap Task).*


### Chat Interface & Task Panel Enhancements
- [x] Ensure follow-up questions in the task panel continue the current task/session instead of starting a new one.
- [x] Remove the isolated "final response" section at the top of the task details; the final response should simply be the last message in the chat flow.
- [x] Restructure the chat message sequence to be purely sequential: User message -> Tool activity (e.g., "16 tools", status events) -> Agent response -> Follow-up question -> Follow-up tools activity -> Follow-up response.
- [x] Ensure a proper unified chat interface is maintained with consistent context from top to bottom.
- [x] Retain the same chat session (e.g., Claude, Codex, etc.) for the entirety of the task execution and follow-ups.
- [x] Declutter the task panel by removing redundant inline "add task" section. Instead, add an "Add task" button next to the "Execute selected" button. Clicking this should open a small modal/popup (with Title and Description fields) to manually add a task to the Planned Tasks list without needing the agent Planning phase.
- [x] The followup instructions message input box(textarea) should be displayed at the bottom of the chat panel, similar to other chat applications. The send button for the followup instructions should be to the right of the textarea. And it should be fixed to the bottom, so that only chat is scrollable.
- [x] Fix the task details panel, the bottom is fixed but the chat is visible behind it, seems like its transparent. Also the header of single task should have a single back arrow followed by name of the task in 2 lines, followed by status of the task. this should be the fixed header and chat messages should be scrollable in between header and footer. Do the same for single planning session, also no need to show start a new planning session on single planning session chat. Make sure the bottom fixed panel is exactly similar to start a new planning session section, which is fixed on bottom.
- [x] Each message in task/planning session should have a time it was sent. The listing of these should also show a start and end timestamp, if the date is same then show Date and then start and end time, also show duration of the session how long it lasted. When we have token information show the number of token consumed for that session. 
- [x] Bottom bar which is showing different coding agents and their limits, we can remove the 0 tokens, as we don't need to show tokens. Move the N sessions next to Name, also Rename the default claude to "Claude (no login)". This way we will have this in 2 lines, now sync its height with the left project, working and blocked box. to make them look regular.

### Global Status & Footer Bar Improvements
- [x] Keep the left side of the footer ("X projects, Y working, Z blocked").
- [x] Keep the left side of the footer ("X projects, Y working, Z blocked"). Remove unnecessary instructional text from the center ("drag to explore click a building..."). Remove the "live demon" indicator from the right side. Track and display the number of tokens consumed in each session. Display coding agent limits (e.g., 5-hour limit, 7-day limit remaining) in the footer. (Starting with Claude, but extensible to others as they are built). Make the agents limit section in the footer horizontally scrollable to accommodate multiple accounts/agents. Auto-sort coding agents in the footer: most used on the left, least used on the right.

### Project Popover Redesign
- [x] Convert the current left-side categories (Actions, Documents, Testing) into top-level tabs on the popover. Retain the left sidebar and right content section below the selected top tab. **Actions Tab**: Display Task Planning on the left sidebar. **Documents Tab**: Combine all project documents and display actual files in a tree format, instead of fixed generic categories like blueprint, specification, or requirement. **Testing Tab**: Display testing-related documents. **Code Tab (New)**: Introduce a new tab to explore and display the entire project codebase in a tree format.

### Delegation & Sub-agents
- [x] Implement Manager Templates that can delegate sub-tasks to native Claude Code sub-agents.
- [x] Implement the blocked-and-relay flow (detect blocked sub-agent, surface question to user via Manager, relay answer back).
*Notes: Detail: [`docs/architecture.md`](architecture.md#manager-and-sub-agent-flow-native-delegation-with-a-relay-for-questions).*

### Configurable Task Workflows
- [x] A Workflow Catalog (ordered Steps, each an agent/skills/executor/instructions, edit-code and approval flags, loop-back) — Catalog CRUD, a Project selecting one.
- [x] Requirement analysis happens in the planning session (no longer a Workflow stage or config), and the one-task-per-related-requirement planning rule.
- [x] The run engine: a WorkflowRun per executed PlanItem, its own branch/worktree, approvals, request-changes resume, review loops with round exhaustion handling, skip, retry, stop.
- [x] The built-in Complete stage: commit, push, a summarized PR description, and a final report — replacing the old docs-and-retro completion confirmation entirely.
- [x] Tasks tab regrouped by attention (Needs you / Running / Open-queued / Planning / Completed) with a per-row step-progress bar, and a full run detail view (stepper, per-stage summary/output/session, actions).
*Notes: Full decision record: [`docs/architecture.md`](architecture.md#configurable-task-workflows-replace-the-docs-and-retro-completion-step). New terms: [`docs/glossary.md`](glossary.md#workflow).*

### Scale Out & Multi-Project
- [x] Support multiple Projects registered and being worked on simultaneously. *(Already held architecturally — `withProjectLock`/`activeTaskId` are keyed per-Project and `runningProcesses` is a `Map<taskId, ChildProcess>` with no cross-project cap; confirmed with a regression test in `server/tests/workerManager.test.ts`. The remaining one-active-Task-per-Project limit below is scoped to a single Project and needs worktrees to lift.)*
- [x] Implement isolated git worktrees for concurrent Tasks on a single Project.
*Notes: Fixes the one-task-per-project limitation in [`docs/architecture.md`](architecture.md#concurrent-tasks-per-project) — see that section (amended 2026-09-14) for the actual scoped model built: a Project's first Task still uses its own directory directly, further concurrent Tasks each get an isolated `git worktree` + branch up to a small fixed cap, non-git Projects are unaffected (still strictly one Task), and a settled worktree Task's directory is cleaned up while its branch is left for a human to review/merge (never auto-merged) — following `claude-squad`/`crystal`'s per-agent-worktree pattern. No multi-Task management UI was built as part of this — the existing single-Task UI is untouched and still can't itself start a second concurrent Task; that remains open follow-up work.*
