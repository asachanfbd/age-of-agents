# Workflow & command-center gap analysis

**What this is**: a one-time analysis, not a living doc — unlike `blueprint.md`/`architecture.md`, this file is a snapshot of findings and decisions as of 2026-09-17 and won't be kept in sync as the app changes. Originally written to work out what a person running most of their development through AI agents, coordinated via markdown context files, actually needs to see and do at any given moment, then checked against this app. **Reviewed by the user on 2026-09-17** — every item below reflects that review: rejected ideas were removed outright rather than kept as "considered and declined" clutter, accepted ideas were sharpened with the user's own specifics, and a new area (staging/production environment visibility) was added at the user's direction. No code was changed for this — findings only.

Method: read `docs/architecture.md`, `docs/blueprint.md`, `docs/glossary.md`, `docs/roadmap.md`, `docs/risks.md`, `server/README.md`, `docs/claude-usage.md`, `docs/codex.md`, `docs/notify.md`/`notify.sh`, and the source under `server/src/` and `web/src/` (`worldStore.ts`, `TopBar.tsx`, `SettingsPanel.tsx`, `ProjectWorkspaceModal.tsx`, `buildingVisualStatus.ts`, `agentActivity.ts`, and related lib files).

---

## 1. What a "command center" for this workflow needs to answer at any moment

- **In flight** — what's actively running, what's queued behind it, and on what branch/worktree?
- **What happened** — a readable history of what an agent did, what changed in the code (a real diff, not just "open the file tree"), and what got committed/pushed where.
- **What's next** — the backlog (Tasks breakdown / Milestones) and enough confidence in it to hand off a batch of work unattended.
- **Can I act from here** — answer a blocked question, stop a task, merge a worktree branch, revert a bad commit, re-run a failed step — without leaving the one view.
- **Tell me, and let me answer back, even when I'm not looking** — a two-way channel: the app reaches the user (mobile), and the user can reach back into a specific project (e.g. answer a blocked question) without opening the browser.
- **Is it actually live** — for a project with staging/production environments, is production up right now, what's deployed there, and did a recent task's change just break it?

## 2. What's already built and covers this well

- Per-project attention state (blocked/failed/out-of-sync) exists and is visually distinct on the rooftop dot and the workspace's attention banner (`web/src/lib/buildingVisualStatus.ts`).
- Full transcript history per task, grouped into chat-style turns with tool activity collapsed but inspectable (`ProjectWorkspaceModal.tsx`'s `TaskDetailsView`).
- Sequential per-project execution queue with auto-advance (`server/src/worker/workerManager.ts`, "Sequential plan-item execution queue").
- Multi-provider quota tracking (Claude + Codex) in the footer with reset countdowns and staleness handling (`docs/claude-usage.md`, `docs/codex.md`, `ExecutorLimitStatus.tsx`).
- Background git-sync polling that flags a branch falling behind/diverging without a webhook (`gitSyncPoller.ts`) — the pattern to reuse for environment health polling (see section I).
- Isolated git worktrees for limited concurrent tasks per project, with automatic cleanup (`architecture.md`, "One task per project in version 1," amended).
- Agent-authored Blueprint + Milestones + a structured Tasks breakdown, so the markdown-context-file workflow the user already uses is native to the tool, not bolted on.

## 3. Gaps and decisions

### A. Two-way communication (replaces the earlier one-way notification idea)

- **A one-way outbound notification (e.g. the dormant `docs/notify.sh` WhatsApp script) isn't enough — two-way is the actual requirement.** The user needs to both be *told* something needs attention and be able to *act on it* from the same channel (at minimum: answer a blocked task's question) without opening the app. This means the notification integration needs an inbound leg too: something that receives a reply (WhatsApp, Telegram, SMS — whatever channel is chosen) and routes it back to the right blocked Task's `answerTask`/`followUpTask` call, not just an outbound send. A cross-project attention feed, a generic notification-rules/mute system, and a general remote-access/auth layer for a full mobile UI were all explicitly ruled out — this is scoped tightly to "notify me, and let me reply," not a second UI surface.
- **Review state isn't persisted.** `reviewedTaskIds` (`web/src/store/worldStore.ts:245`) lives only in in-memory zustand state — never written to the server or `localStorage`. Reloading the browser tab forgets every "already looked at this completed task" mark, so completed tasks resurface as needing attention on every refresh. This also matters for the two-way channel above: an answer given over WhatsApp needs to mark the same server-side state the web UI would, so the two never disagree about what's still outstanding.

### B. Oversight & control

- **Approval-gated autonomy should be removed, not fixed.** `autonomy: 'approval'` never actually paused for a decision — it silently denies gated tool calls (`server/README.md`, "Known simplifications"). Rather than building the real pause/relay this would need, the decision is to drop the approval-gated mode and its UI (the "Autonomy" picker in the chat composer, the `autonomy` field's second value) entirely, since it doesn't do what it claims and isn't wanted as a feature going forward.
- **No diff view of what a task changed.** The Code tab (`fileTree.ts`) is a static, read-only snapshot of the whole repo — no per-Task diff, no before/after.
- **No in-app merge/review flow for worktree Task branches.** Concurrent worktree Tasks each land on their own branch and are explicitly never auto-merged (`architecture.md`, "Cleanup policy") — there's no UI to review or merge them today.
- **No revert/undo action** against a Task's own commit from inside the app.
- **Multi-Task-per-Project concurrency has no UI at all.** The backend supports up to `MAX_CONCURRENT_TASKS_PER_PROJECT` worktree'd Tasks, but per `blueprint.md`'s own admission, "no such UI was built" — reachable only by calling the API directly.

### C. Cross-project relationships

- **No relationship model between projects.** The user wants to explicitly define how projects connect — e.g. "this frontend talks to that backend," "service A and service B are connected" — and have agents working on one aware of the connection. Concretely this means:
  - A way to declare a link between two Projects (directional or not, with a label — "depends on," "shares an API contract with," etc.).
  - An agent working a Task on Project A should be able to **read files from Project B** when the link says they're connected (e.g. a frontend task reading the backend's route definitions or shared types) — today each Worker's tools are scoped to its own Project's working directory only, so this needs a deliberate widening (e.g. exposing the linked Project's path as an extra allowed read root) rather than something that falls out of existing behavior.
  - Worth deciding up front whether cross-project access is **read-only by default** — a Task assigned to Project A changing files inside Project B by surprise is a sharper version of the exact conflict-of-writers problem worktrees already exist to prevent within one Project.
  - A natural follow-on once links exist: flagging when a change on one side of a link (a backend route, a shared schema) might affect the other side — not required now, but worth keeping in mind as the reason to model this as a real relationship rather than just a free-text note.
- **No global search.** Nothing searches across all projects' blueprints, plan docs, milestones, code, or transcripts at once. This becomes more valuable once projects are explicitly linked — searching "where else is this endpoint referenced" should span connected projects, not just the current one.

### D. Usage trends

- **No historical/trend view of usage.** The footer shows a live quota snapshot only — no chart of token usage or task duration over days/weeks. This matters for catching a regression (a task quietly taking 5x the tokens or 5x the time it used to) even without tracking dollar cost or setting budgets, neither of which is wanted.

### E. Automation / scheduling

- **Nothing runs on a schedule.** Every Task, Project Command, and planning session is triggered by a click — no cron-style "run this nightly," no auto-retry for a failed Task, no way to wire a Project Command to a git event. This is the largest lever for the user's stated goal of reducing manual clicking: the app already models real automation (queues, restart recovery); every entry point into it is still manual.
- **No external trigger surface.** No webhook endpoint for something outside the tool (a GitHub push, a Linear ticket) to kick off a Task.
- Once built, this same scheduling machinery is also the natural way to run the environment health checks in section I below, rather than a separate poller.

### F. Docs/process integrity — flagged as a significant, standalone problem

- **`server/README.md` is already stale**, and by the user's own read this is a big problem worth solving properly, not a footnote. It currently states "No git worktrees — one active Task per Project only" and "Codex executors are listed, not runnable" under "Known simplifications" — both superseded by real, shipped features documented elsewhere in the same repo (`architecture.md`'s worktree section, `docs/codex.md`). Nothing catches this kind of drift automatically, and the user's entire workflow depends on markdown files staying trustworthy context for an agent to read — this is a live example, inside the tool's own repo, of exactly the failure mode the tool exists to help manage for other projects. Worth treating as its own piece of work: some mechanism (agent-driven doc audit, a periodic "does this doc still match the code" check) that catches a stale doc before it misleads the next agent that reads it for context.
- **No automated consistency check** between a managed Project's agent-authored docs (`.docs/blueprint.md`, plan docs) and its actual code state — relies entirely on the Worker's own end-of-Task discipline.

### G. Smaller items, sharpened

- **A failed/crashed state needs to be pinpointed, not just flagged.** Keep the building's single rooftop dot as-is (still one summary signal at the town level), but inside the Project Workspace popup, the red "needs attention" marker should move onto the *specific* item with the problem — the failed Task row, the out-of-sync branch control, and (once section I exists) the specific environment that's down. If the problem item lives inside a tab that isn't currently open, the tab/nav entry on the path to it should itself show a red dot, so opening the popup always tells you which tab to click, not just that *something* is wrong somewhere. This same pattern should extend to production-down state once environments exist (see section I).
- **The Testing tab needs to become a real testing surface, not just markdown.** Concretely: test cases and their pass/fail state as a table, current coverage, a button to actually run the tests, a diff view for a failing test's output, a history of *when* a given test started failing (not just its current state), an execution graph (what ran, in what order, how long each step took), and a test-dependency graph (what depends on what). This is a substantial feature on its own, not a small tweak to the existing plan-doc panel.
- **Local environment variables need their own place.** The Project popup should get an **Environment tab** for the project's local `.env`/secrets — today nothing in the tool manages these at all; they're just whatever already exists in the Project's working directory. (See section I for how this tab likely extends to staging/production, not just local.)
- **Command Run output needs a cap.** Keep only the most recent ~500 lines (or similar bound) per run rather than an unbounded string — today a long-lived command (`npm run dev`) can grow `server/data/command-runs.json` without limit.

### H. Staging & production environment visibility — new

The app currently only ever looks at a Project's own working directory and git state. It has no concept of *where that code actually runs* once deployed, which the user explicitly wants visibility into — if production is down, that should be visible on that project, not something discovered elsewhere.

Breaking down what "keeping an eye on staging/production" actually implies once you think through it:

- **Environments as a first-class concept per Project.** Not just "staging" and "production" as fixed labels — a Project should be able to define however many named environments it actually has (local/staging/production, or per-branch preview environments for something like Vercel/Netlify), each with at minimum a URL and a way to check health.
- **Health polling, following the same pattern as git-sync.** A background poller (structurally like `gitSyncPoller.ts`) hitting each environment's health-check URL on an interval, landing on an `up`/`down`/`degraded`/`unknown` state, pushed live over the existing `/ws` connection — not a webhook, since there's no public endpoint for a third party to call, same reasoning as the git-sync decision.
- **What's actually deployed where.** Track which commit/branch is currently live on each environment (even if just hand-recorded at deploy time initially), so "production is down" can be immediately followed by "and here's what's on it" and, ideally, "and here's the Task that produced that commit" — turning an incident straight into the right starting point for a fix, rather than a separate investigation.
- **A deploy action, not just a status.** If there's a known deploy command for an environment, it's a natural fit for the existing Project Command mechanism (`commands/commandRunner.ts`) rather than a new subsystem — a "Deploy to staging" command scoped to an environment, with its run tracked the same way any Command Run already is.
- **Surfacing it where the other "needs attention" signals live.** A down production environment should follow the same pinpointing rule as section G above: don't invent a second, separate alert surface — light up the Environment tab (and its nav entry, if not the active tab) the same way a failed Task or an out-of-sync branch does, and (once the two-way channel in section A exists) it's exactly the kind of event that should push a notification.
- **Rollback ties back to section B.** Once there's a revert/undo action against a Task's commit, "production just broke and here's the commit that broke it" and "roll it back" are the same underlying capability, just triggered from the environment's context instead of the Task list.
- Deliberately not scoping in for now unless it comes up later: pulling in a third-party log/error-tracking service's error feed, or SSL/domain-expiry monitoring — both are natural extensions of "environment health" but are their own integrations, not implied by the ask as stated.

## 4. Where to look first

Ranked by how directly each maps to what actually got prioritized above — reducing manual work, tightening oversight of what an agent changed, and knowing when something real (a blocked task, a broken production environment) needs the user's attention:

1. **Fix docs drift** (section F) — the user flagged this as a big problem in the tool's own repo, and it undermines the trust the whole markdown-context workflow depends on.
2. **Environments: define them, poll health, surface status on the project** (section H) — the newly-identified, explicitly-wanted capability with no existing foundation to build on yet.
3. **The two-way notification/reply channel** (section A) — turns "I have to keep checking the app" into "the app tells me and I can respond from my phone," which is the user's stated end goal.
4. **A per-Task diff view + in-app worktree merge/revert** (section B) — the core "trust but verify what the agent actually did" loop, and a prerequisite for the environment rollback idea in section H.
5. **Project relationships** (section C) — unlocks agents working correctly across a frontend/backend split, which the current single-Project-directory sandboxing actively prevents today.
6. **Basic scheduling** (section E) — the mechanism both "run this nightly" and the environment health polling in section H want to lean on; worth building once, not twice.
