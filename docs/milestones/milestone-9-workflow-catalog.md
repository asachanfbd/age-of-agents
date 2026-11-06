**Superseded — see 3.012.** The classify-kind/gates.json/rca-review/retro-FIFO-queue proposal below was not implemented; task 3.012 ("Configurable task workflows") shipped a different Workflow/WorkflowRun/StepRun design instead — see `server/src/catalog/workflowService.ts` and `server/src/worker/workerManager.ts`.

# Milestone 9: Workflow Catalog & the Start Screen

**Status: Plan.** This document is a proposal, not a build spec — nothing described here exists yet. Once reviewed and closed, `roadmap.md` gets a real section for it, `architecture.md` gets the actual architecture decisions made along the way, `glossary.md` gets the new/renamed terms, and implementation starts, tracked as ordinary Tasks-breakdown work against this milestone. Until then, treat every detail below as a draft open to revision.

This is a *feature the application ships to users managing their Projects* — not a milestone in this repo's own development sense beyond the fact that it lives in this folder (see [`README.md`](README.md) for that distinction). It should also not be confused with the per-Project `Milestone` feature this app already ships — a `WorkflowRun` (defined below) is a live, gated execution of one piece of work; a Milestone is a Project's own target-state narrative. The two are unrelated except that a Workflow's stages produce the kind of artifacts (Specifications, Tasks) a Milestone groups.

**Depends on [`milestone-7-bug-rca-workflow.md`](milestone-7-bug-rca-workflow.md)** for the `'rca'` Task kind and the Bug → RCA → fix chain the Bug Fix workflow below wraps. Does **not** depend on [`milestone-6-planning-hierarchy.md`](milestone-6-planning-hierarchy.md) or [`milestone-8-metrics-reports.md`](milestone-8-metrics-reports.md) — per Abhishek (2026-09-17), milestone-6 isn't being built as its own milestone, and this milestone is its enhanced superset. Rather than depending on it, this milestone absorbs the one piece of it it actually needs — `Project.category` — directly into its own scope (see "New domain concepts" and "Draft milestone task breakdown" below), and extends today's real `TaskRecord` (`server/src/domain/types.ts`) rather than a hypothetical milestone-6-extended one. (Milestone-7 still nominally cites milestone-6 for the `owner` enum and `Project.category`; that residual link is milestone-7's own document to resolve, not addressed here.) Also assumes the concurrent-Task plumbing has already landed (confirmed done, per Abhishek, 2026-09-17) — see "Depends on a lifted one-Task-per-Project constraint" under Architecture.

**Not written from a blank slate.** The gated review mechanism this milestone formalizes — stages, human Gates, an agent-decided "does this change ripple to an earlier stage" revision path, and a Retro step — was designed and reviewed interactively first, as a 7-stage "Software Feature" pipeline (Elaborate → UX/UI → Architecture → DB Schema → Data migration → Dev → Retro), with a working UI mockup at [`../gated-feature-pipeline.html`](../gated-feature-pipeline.html). That mockup is the reference for what a Gate review screen looks like and how it behaves; this document's job is different and narrower: generalize that one fixed pipeline into a **Workflow** — one of several named, selectable shapes of work — and define the **Start** screen where a piece of work begins before any Project-scoped mechanism runs. Read the mockup for the review-screen UI; read this document for the data model, the classification step, and where the Start/Gate-review screens actually live in the app.

## Why

Today, starting work on a Project means already knowing the system's two fixed shapes: "Start a task" always creates one freeform `'execute'`-kind Task, and the Project's persistent chat always defaults to one `'plan'`-kind Task. Neither has any notion of a multi-step, gated process, and there is no way to say "this piece of work should go through Elaborate → UX → Architecture → DB Schema → Migration → Dev → Retro" versus "this is a bug, go straight to RCA" versus a still-different shape for SEO or content work — every request is forced through the same two undifferentiated Task kinds, and the person has to already know which one applies before they can act.

This milestone introduces the **Workflow**: a named, reusable, ordered sequence of gated Stages (the pipeline already designed is Workflow #1, "Software Feature"), and the **Start** screen — the first tab a Project's workspace shows — where a person describes a piece of work in plain language and the system classifies it into the right Workflow (or a plain single-stage fallback) before anything Project-scoped begins.

## Scope for this milestone (v1)

**In scope:**
- A **Workflow** definition format: an ordered list of **Stages**, each naming a Task kind, whether it pauses for a human **Gate** or runs straight through, its pre-stage questions, and (for a Bug Fix workflow's RCA stage) which existing Task kind it reuses.
- A small, seeded Workflow catalog — **Software Feature** (the 7-stage pipeline already designed and mocked up, ending in Retro), **Bug Fix** (a 4-stage wrapper: RCA, then an always-autonomous `rca-review` scoring step, then Dev — gated only when that score comes back below the confidence threshold, per the confirmed answer — then an automatically-triggered Retro; reuses [`milestone-7`](milestone-7-bug-rca-workflow.md)'s Bug → RCA → fix chain for RCA and Dev), and **Freeform Task** (today's plain `'execute'` Task, unchanged, as a 1-stage, ungated passthrough) — enough to prove the mechanism without hand-building a Workflow per Project category up front.
- A new, restricted **`'classify'`** Task kind — reads a freeform brief and the Project's category, and picks one Workflow id from the closed catalog (or none, meaning fall back to Freeform Task) — following the exact structured-decision, no-Worker-representation pattern [`milestone-5`](milestone-5-notification-system.md)'s Notification Agent and [`milestone-7`](milestone-7-bug-rca-workflow.md)'s `'rca'` kind already established.
- A `WorkflowRun` record: one in-progress or completed traversal of a Workflow's Stages, for one Project, holding the original brief and which Stage is current.
- A `Gate` record: one human decision checkpoint against one Stage's Task, with the structured payload that Task's turn produced (decision items, risk flags, open questions) — the data-layer counterpart of the review screen already designed in the mockup.
- Reusing **follow-up Tasks** (already built, see `docs/architecture.md`'s "Follow-up Tasks continue a session, not mutate a finished one") as the resume mechanism for both "changes requested" on the current Stage and an agent-initiated upstream revision on an earlier one — no new session-tracking concept needed; see "No separate StageSession" under Architecture.
- The **Start** screen itself, replacing today's default landing tab, per the UI spec below.

**Deliberately deferred (open follow-up work, not this milestone):**
- Authoring new Workflows through the UI. v1 ships the 3 catalog entries above as hand-authored static files under `catalog/workflows/`, the same way Templates and Skills are hand-authored under `catalog/agents/`/`catalog/skills/` today. A "define your own Workflow" builder is real, wanted, future work — not this milestone.
- SEO/Website-category-specific Workflows. This milestone's own `Project.category` field and [`milestone-7`](milestone-7-bug-rca-workflow.md) both already flag that non-software categories may need a genuinely different shape; this milestone gives the mechanism those workflows would plug into, but doesn't design them.
- Cross-Project classification. The Start screen lives inside a Project's own workspace (see Frontend), so the Project is already chosen by the time a brief is typed — `'classify'` only ever picks a Workflow, never a Project. A global, Project-agnostic "just tell me what you want and I'll figure out where it goes" entry point is a different, larger feature, not this one.
- A Workflow-authoring or Workflow-editing agent. The catalog is read-only application data in v1, exactly like Templates and Skills are today.

## New domain concepts

- **Workflow** — a named, ordered list of Stages a piece of work goes through. Static catalog data, not a runtime record — see Architecture.
- **Stage** — one step of a Workflow: a Task kind to run, whether it's gated (pauses for a human decision) or autonomous, and any questions to ask before it starts.
- **WorkflowRun** — one live traversal of a Workflow's Stages, for one Project, starting from one freeform brief.
- **Gate** — one human decision checkpoint on a gated Stage's Task, carrying that Task's structured output and the decision made against it.
- **Classify** (Task kind) — a restricted, structured-output-only Task that maps a brief to a Workflow id.
- **RCA Review** (Task kind, confirmed under Open questions) — an autonomous Task that always runs right after RCA settles, scoring the RCA's confidence; that score decides, per `Stage.gateCondition`, whether Bug Fix's `dev` Stage needs a human Gate at all.
- **Project category** — `'software' | 'seo' | 'website'`, a plain enum field this milestone adds directly to `Project` (`server/src/domain/types.ts`'s `ProjectRecord`). Originally proposed by milestone-6; introduced here instead since milestone-6 isn't being built as its own milestone — see "Depends on" above. In v1 it's used only as a classification hint for `'classify'` (see the "not wired together in v1" open question below).

## Data model

### Workflow (catalog data — not a database record)

| Field | Notes |
|---|---|
| id | slug, e.g. `software-feature`, `bug-fix`, `freeform-task` |
| name | shown on a `WorkflowRun`'s card once classified |
| description | one line, used both for the person and inside the `'classify'` Task's prompt |
| appliesTo | free-text hints/keywords the `'classify'` Task's prompt is given — a hint, not a hard rule engine; classification is a model decision, not a keyword match |
| stages | ordered list of Stage definitions (below) |

### Stage (part of a Workflow definition)

| Field | Notes |
|---|---|
| id | slug, unique within its Workflow, e.g. `elaborate`, `ux`, `architecture`, `db-schema`, `migration`, `dev`, `retro` |
| name | display name |
| taskKind | which existing `Task.kind` this Stage runs as — see "Reusing `'plan'` instead of five new kinds" under Architecture |
| gated | boolean — pauses for a `Gate` (every Stage except Dev's internal implement/test/review sub-steps, which stay autonomous behind the one `dev` Stage) |
| gateCondition | optional; when set, `gated` is decided at runtime instead of being fixed — e.g. Bug Fix's `dev` Stage has `{ field: 'confidenceScore', from: 'rca-review', lessThan: 90 }`, so it's only gated when the preceding `rca-review` Stage's score falls below the threshold. Absent means `gated` is used as-is |
| preQuestions | optional list of `{ prompt }` questions asked and answered before the Stage's Task is even created |
| canRequestUpstreamRevision | boolean — whether this Stage's Task is allowed to open a follow-up Task against an *earlier* Stage's Task (the ripple mechanism mocked up in `gated-feature-pipeline.html`) |

### WorkflowRun (new collection, `workflow-runs.json`)

| Field | Notes |
|---|---|
| id | |
| projectId | |
| workflowId | nullable until the `'classify'` Task settles |
| brief | the original freeform text typed into the Start screen |
| status | `classifying \| needs-input \| running \| paused-gate \| completed \| abandoned` — reaches `completed` once the last *blocking* Stage (e.g. `dev`) is approved; per the confirmed answer, Retro is asynchronous and never gates this |
| currentStageId | |
| retroStatus | separate from `status`, since Retro trails behind delivery: `not-started \| queued \| running \| gate-pending \| nothing-to-propose \| applied` |
| createdAt / updatedAt | |

### Gate (new collection, `gates.json`)

| Field | Notes |
|---|---|
| workflowRunId | |
| stageId | |
| taskId | the specific Task instance (see below) whose structured final output this Gate reviews — a follow-up Task that revises the same Stage gets its own new Gate, pointing at the new Task |
| section | nullable; `'project' \| 'global'` for the `retro` Stage only. Per the confirmed answer that changes can be requested on either independently, a Retro turn with proposals in both scopes creates **two** Gate rows (same `taskId`, different `section`), each decided on its own — a section with nothing proposed simply gets no row rather than an empty one. Null for every other Stage, which still gets exactly one Gate |
| status | `pending \| approved \| changes-requested` (no `rejected` — see the mockup's action-button rule: Approve or Request changes only, computed from whether the reviewer left a comment, with `pending`-questions taking precedence when the Task's output includes unanswered open questions) |
| payload | the Task's structured final-turn JSON — decision items, risk flags, any open questions — schema is Stage-specific, same "each kind defines its own JSON schema" pattern `'plan'`/`'rca'`/`'notification'` already use |
| decidedBy | `'human' \| 'system'` — per the confirmed answer, an `'rca-review'`-driven auto-skip (score ≥ threshold) still creates an `approved` Gate row, `decidedBy: 'system'`, with the score recorded in `comment` (e.g. "auto-approved — confidence 94%"), so the Gate-history timeline stays a complete audit trail even when no human looked at it |
| comment | the reviewer's freeform text, if any |
| decidedAt | |

### Task (extension of today's `TaskRecord` and [`milestone-7`](milestone-7-bug-rca-workflow.md)'s record)

| Field | Notes |
|---|---|
| workflowRunId | nullable; set when this Task is one Stage of a `WorkflowRun` |
| stageId | nullable; which Stage, when `workflowRunId` is set |

Note this is additive, not exclusive, against milestone-7's existing origin link: a Bug Fix workflow's Dev-stage Task has **both** `linkedRcaId` ([`milestone-7`](milestone-7-bug-rca-workflow.md), since it's a bug fix) **and** `workflowRunId`/`stageId` (since it's also a Workflow stage) set at once. (Milestone-6's proposed `linkedRequirementId`, reserved for a Task started directly off a Specification's Tasks breakdown, doesn't exist in this milestone's scope — no Specification record is built here; only relevant if milestone-6 is ever built later.)

## Architecture (sketch — needs a real pass before build)

**Reusing `'plan'` instead of five new Task kinds.** Elaborate, UX/UI, Architecture, DB Schema, and Data migration are all "produce a decision/artifact, touch no project source" work — exactly what the existing `'plan'` kind already is (`--disallowed-tools Bash,BashOutput,KillShell`, writes restricted to docs, not code). Rather than inventing five new kinds, all five Stages run as `'plan'`-kind Tasks; which Stage-specific prompt and JSON schema applies is selected by the Stage definition (via the Task's `stageId`), not by the Task's `kind`. Only two genuinely new kinds are needed: **`'classify'`** (this milestone) and **`'retro'`** (see below). Only `dev` uses `'execute'` — real coding, same as today.

**No separate StageSession — follow-up Tasks already do this job.** The mockup's "resume the same stage's session" behavior (for both "changes requested" and an upstream ripple) is not a new mechanism to build: it is an ordinary follow-up Task (`docs/architecture.md`'s "Follow-up Tasks continue a session, not mutate a finished one" — `workerManager.ts`'s `followUpTask`, `--resume`, full prior context), against that Stage's own Task, carrying the reviewer's comment (or the downstream Stage's ripple reason) as the new instruction. A Stage's current "session" is simply the most recent Task sharing its `(workflowRunId, stageId)` pair — the exact same "several follow-up Tasks read as one continuous thread" relationship a `PlanItemRecord`'s Tasks already have today. This was a real simplification from the interactive design pass, which had sketched a parallel `StageSession` concept before this write-up noticed it would just duplicate an existing mechanism.

**The upstream ripple, concretely:** a Stage's `'plan'` Task, if `canRequestUpstreamRevision` is true and it decides an earlier Stage's decision no longer holds, ends its turn naming the target `stageId` and a reason instead of (or alongside) its own output. The daemon creates a follow-up Task against that earlier Stage's own most recent Task, carrying the reason. That Stage's session judges materiality itself — a real change opens a new `Gate` (`revision: true`, reason attached, exactly as the mockup shows on the DB Schema stage); a non-material one just updates its own artifact and reports back, no new Gate. Once the upstream Stage settles, every Stage between it and the one that raised the ripple is itself given a follow-up Task carrying "what changed and why," in order, before the originating Stage's own Task is resumed and continues.

**`'classify'` Task kind.** Given the brief plus the catalog's `{id, name, description, appliesTo}` list, returns `{ workflowId: string | null, confidence, reasoning }` — mirrors the Notification Agent's "a small, closed, predefined set of actions" constraint ([`milestone-5`](milestone-5-notification-system.md)): it picks an existing catalog id, it never invents one. `workflowId: null` means Freeform Task, always, so classification can never dead-end. Read-only, no Building/Worker representation, same treatment as `'rca'`. Per the confirmed answer, "optional" isn't the right frame: below the confidence threshold it always asks a clarifying question before picking; at or above it, it never asks.

**`'rca-review'` Task kind (confirmed under Open questions).** Runs automatically the moment an RCA settles — never optional, never skipped. Structured output is just `{ confidenceScore: number }`. Bug Fix's `dev` Stage reads that score against its `gateCondition` (see Stage table) to decide whether it needs a human Gate at all; either way, a Gate row is written (see Gate's `decidedBy`), so the decision is always visible in the run's history even when no human made it.

**`'retro'` Task kind needs to write outside its own Project.** Every other Stage's Task is an ordinary Worker, scoped to its one Project's working directory. Retro is not: it reads one Project's Gate/RCA history but proposes edits to agent-visual-os's own shared `catalog/` — a different repository entirely from any managed Project. This breaks the Worker definition's "scoped to one Project's own working directory" assumption. The closer precedent is [`milestone-5`](milestone-5-notification-system.md)'s Notification Agent — "not a Template/Worker in the existing sense... never appears as a character in the scene" — Retro should likely be run the same way: a daemon-invoked agent process, not a Project-scoped Worker, even though it's triggered by one Project's history. Flagged here, not resolved — see Open questions.

**Retro's trigger is now resolved: it's an ordinary final Stage, not a separate batched concept.** Confirmed under Open questions: Retro automatically starts the moment the prior Stage's Gate is approved (Dev, for both Software Feature and Bug Fix) — not "after N Bug Fix `WorkflowRun`s close" as first speculated. That removes the original objection that it "doesn't cleanly belong to one `WorkflowRun`": it now does, exactly like every other Stage — an ordinary `Gate` on `(workflowRunId, stageId: 'retro')` (or two, see Gate's `section` field), no separate `RetroRun` collection needed. What's still genuinely different about it, per the confirmed answers, is:
- **Asynchronous, non-blocking.** `WorkflowRun.status` reaches `completed` off Dev's approval alone; Retro runs and settles afterward, tracked on the separate `retroStatus` field (see WorkflowRun) so "my feature shipped" is never held up by "the retro hasn't finished."
- **Two independently-decidable sections**, not one payload. It can propose Project-level changes (this Project's own docs) and global changes (agent-visual-os's shared `catalog/`); a person can request changes on either without touching the other, since each is its own `Gate` row (`section: 'project' | 'global'`).
- **Nothing-to-propose skips the Gate entirely.** If a Retro turn concludes there's nothing worth changing in a section, that section gets no Gate row at all — not an empty one waiting for a rubber-stamp. If *neither* section has anything, `retroStatus` goes straight to `nothing-to-propose` and the run needs no further attention.
- **Globally serialized, one at a time.** Since any Retro can touch the same shared `catalog/`, every Project's Retro Task is pushed onto one FIFO queue, daemon-wide, with exactly one running at a time — never two Retros racing to edit the same catalog file. A queued Retro reads `catalog/` fresh at the moment it actually runs, not at the moment it was queued, so it always sees the live state (consistent with the catalog-versioning answer below).
The `chat-and-apply-on-approve` behavior from the mockup (no separate manual-apply step) still stands, now per-section: approving a section applies just that section's diffs.

**Workflow catalog has no version pinning.** Confirmed under Open questions: a `WorkflowRun` paused mid-pipeline picks up whatever `catalog/workflows/<id>.md` says the moment it resumes/advances, not a version snapshotted at start. No `workflowVersion` field on `WorkflowRun` is needed as a result — simpler than the alternative, at the cost of a live-edited Stage definition being able to change what an already-running Workflow does mid-flight (see the new "editing a Workflow definition" question below).

**Depends on a lifted one-Task-per-Project constraint.** `docs/architecture.md` still documents v1 as one active Task per Project; a multi-stage `WorkflowRun` with follow-up chains per Stage needs more than one Task-lineage alive for a Project at once (e.g., DB Schema's follow-up chain sitting paused-for-gate while Migration's is queued behind it, or, before the ripple resolves, potentially two Stages' Tasks both wanting attention). Per Abhishek (2026-09-17), the concurrent-Task plumbing this needs has already been built. This milestone leans on that being true and doesn't re-derive it — but `docs/architecture.md`'s "One Task per Project in v1" section is now stale and should be corrected in whichever milestone actually shipped that change, ideally before this one is implemented.

**Storage** otherwise follows the existing `FileDatabase<T>` pattern exactly: `workflow-runs.json` and `gates.json`, one collection per new record type under `server/data/` (no separate `retro-runs.json` — see the resolved Retro-trigger note above). The Workflow catalog itself is not a database collection — static files under `catalog/workflows/<id>.md`, parsed the same way `catalog/agents/*.md` and `catalog/skills/*/SKILL.md` already are, listed in `catalog/catalog-index.json` alongside `agents`/`skills` under a new `workflows` key.

## Frontend (sketch)
- The UI/UX is already planned, [`gated-feature-pipeline.html`](../gated-feature-pipeline.html) will go inside the project popup under a new tab labeled as "Start".
- `web/src/ui/ProjectWorkspaceModal.tsx`'s `TOP_TABS` gains a new **first** entry — `{ key: 'start', label: 'Start' }`, ahead of Actions/Documents/Testing/Code/Commands — and the modal's initial `topTab` state changes from `'actions'` to `'start'`, so opening a Project's workspace lands here first. "Start" was chosen over "New"/"Home"/"Kickoff" for reading as a verb-first entry point while staying a single word, consistent with every existing top-tab label.
- The Start tab has no `ACTIONS_ITEMS`-style left sidebar — one content pane, two states:
  - **Empty state** — a Project with zero non-`completed`/non-`abandoned` `WorkflowRun`s shows one large, vertically-and-horizontally centered input (textarea + submit), placeholder along the lines of "Describe what you want to build, fix, or change…".
  - **List state** — any pending/active `WorkflowRun` switches the pane to a list: a **"+ New workflow"** card with a dashed border, pinned to the top, above every `WorkflowRun` card below it. Clicking the dashed card expands it in place into the same input from the empty state (list stays visible underneath, pushed down) — no full-screen mode switch, so starting a second piece of work never loses sight of what's already running.
  - Each `WorkflowRun` card shows: the Workflow's name (once classified — a `classifying` run shows a small spinner instead), a one-line excerpt of the brief, the current Stage's name, and a status badge reusing the exact vocabulary already validated in the mockup (`needs review`, `revision pending`, `needs your input`, `running…`, `auto-triggered` for the Retro preview).
  - Clicking a `WorkflowRun` card opens the Gate-review stepper + panel exactly as designed in [`gated-feature-pipeline.html`](../gated-feature-pipeline.html), scoped to that run — this resolves the mockup's own open question about where that screen actually lives: it's not a tab of its own, it's the detail view a Start-tab list item opens into.
- Submitting the input (from either state) immediately creates a `WorkflowRun` with `status: 'classifying'`, adds its (spinner) card to the top of the list, and kicks off the `'classify'` Task; when it settles, the card updates in place to the chosen Workflow's first Stage — either its `preQuestions` form (if any) or straight into `running`.

## Draft milestone task breakdown

(Becomes real Tasks-breakdown items tagged to this milestone's Specification once the plan closes — sizing only, not a final breakdown.)

1. Data model + collections: `workflow-runs.json`, `gates.json`; extend `Task` with `workflowRunId`/`stageId`; add `Project.category: 'software' | 'seo' | 'website'`; Workflow catalog file format under `catalog/workflows/` + `catalog-index.json` wiring.
2. The `'classify'`-kind Task: prompt, disallowed-tools, structured output schema, closed catalog-id choice, `null` → Freeform Task fallback.
3. `WorkflowRun` lifecycle: create from a brief, advance on Gate approval, resolve `preQuestions` before a Stage's Task is created.
4. `Gate` decide endpoint: approve → advance; changes-requested → follow-up Task against the current Stage; the upstream-ripple follow-up-Task path for Stages with `canRequestUpstreamRevision`.
5. Seed the 3 v1 Workflow catalog entries: Software Feature (7 stages, reusing `'plan'`×5 + `'execute'` + `'retro'`), Bug Fix (4 stages: `'rca'` + `'rca-review'` + `'execute'` (conditionally gated) + `'retro'`), Freeform Task (`'execute'`, ungated, 1 stage).
6. The `'retro'`-kind agent's actual run mechanism (daemon-invoked, catalog-write access, the global FIFO queue) — needs its own real design pass per the open question below, not just the data model.
7. Frontend: Start tab (empty/list states, dashed new-workflow card), wiring `WorkflowRun` cards to the existing Gate-review screen design, `TOP_TABS` reorder; the Retro detail view specifically needs its two-section layout, each with its own approve/request-changes control.

## Open questions / risks

- **How does `'retro'` actually run, given it needs to write outside any Project's directory?** Flagged under Architecture as "closer to the Notification Agent than a Worker" — that's a direction, not a resolved mechanism. Needs its own design pass before Task 6 above can be sized for real. 
  - Answer: A retro will run once user approves the task/bug fix, it will be the last step, it will automatically start as the previous step completes. 
- **Does a `RetroRun`'s Project-scoped-but-cross-run nature belong in this milestone at all**, or is it better split out as its own follow-up milestone once Bug Fix workflows exist in enough volume to trigger one? Included here for completeness since the mockup already committed to showing it in the same stepper, but it's the one piece of this milestone that doesn't fit the `WorkflowRun`/`Gate` model the rest of it is built on.
  - Answer: It is not project scoped, it can make changes on the global level as well as on project level, but in human review, both the changes should be crealy highlighted by creating 2 separate sections for each.
- **Low-confidence classification: guess-and-flag, or ask first?** v1's `'classify'` always resolves to some Workflow (falling back to Freeform Task) rather than blocking with a clarifying question, favoring "never dead-end" over precision. Worth revisiting if misclassification into the wrong Workflow — e.g., a bug report classified as a Software Feature — turns out common in practice.
  - Answer: Classification can be asked in case of low confidence, but it should be optional.
- **Bug Fix's RCA → Dev gap now has an explicit human Gate that [`milestone-7`](milestone-7-bug-rca-workflow.md) didn't originally specify.** That milestone creates the fix Task automatically "once the RCA settles," with no stated approval step; wrapping RCA in a gated Stage here adds one, for consistency with every other Workflow having at least one human decision point. Confirm that's actually wanted rather than over-gating what milestone-7 intended as a fast path — if not, Bug Fix could instead be modeled with `gated: false` on its RCA stage, matching milestone-7 exactly.
  - Answer: Before deciding get another AI agent review the RCA and if the review agent gives a confidence scope above 90, start the development, if the score is below 90 ask for human review.
- **DB Schema and Data migration Stages have nowhere structured to land beyond `Gate.payload`.** Without a Specification record (milestone-6's concept, not built here since milestone-6 isn't being built standalone), these two Stages' structured decisions live only inside their own `Gate.payload` and doc output — there's no separate cross-Project "current schema" record they feed. Acceptable for v1.
  - Answer (from when this was still framed as a milestone-6 gap): "It should have its own place." Moot now that milestone-9 doesn't depend on milestone-6 — kept for history in case a Specification-like record is ever built later and this milestone should wire into it.
- **`Project.category` and Workflow selection aren't wired together in v1.** `'classify'` is given the category as a hint, but nothing stops it picking Software Feature for an SEO Project. Fine for v1's software-only catalog; becomes a real correctness question the moment an SEO- or Website-specific Workflow is added.
  - Answer: We can handle that later.
- **Catalog growth.** Hand-authored static Workflow files mirror Templates/Skills and are fine for 3 entries; if each `Project.category` eventually needs its own Workflow (or several), a "define your own Workflow" authoring surface may be needed sooner than "deliberately deferred" above assumes.
  - Answer: Workflows will be limited and they will evolve overtime.

### New questions, raised by the answers above

- **Does Retro run after literally every approved Dev stage, even when it finds nothing worth changing?** The confirmed answer auto-starts it the moment the prior Stage's Gate is approved, with no batching condition — every single Software Feature or Bug Fix run spawns a Retro turn. If it usually has nothing to propose, does that still produce a Gate the human has to look at and dismiss, or does an empty result auto-close with no card at all? Left open; "no reject button, always approve or request changes" (the mockup's rule) doesn't obviously have a third "nothing to review" state today.
  - Answer: No, if there is nothing to update just complete the work and move the work to completed/archived.
- **Does the underlying work ship before or after Retro's Gate is decided?** If Dev's approval is what a person actually cares about ("my feature/fix is done"), does the `WorkflowRun` — and whatever it produced (a merged branch, a deployed fix) — count as complete at that point, with Retro trailing along asynchronously, or does the whole run stay "not complete" until Retro also resolves? Affects what "done" means anywhere else in the app that reads `WorkflowRun.status`.
  - Answer: yes, retro will be asynchronous and work will be delivered before retro finishes.
- **Is a Retro Gate one atomic decision, or two?** The confirmed answer requires the project-level and global-level changes to be shown in clearly separated sections — but does approving mean approving both together, or can a person approve the project-level section while requesting changes on the global one (or vice versa)? A single `Gate.status` (per the Data model above) can't represent two independent decisions without a change to that record.
  - Changes can be asked on any one of them.
- **Concurrent Retros across different Projects write to the same shared `catalog/`.** Since Retro is explicitly not Project-scoped (confirmed answer), two Projects finishing a Dev stage around the same time could each propose a diff against the same catalog file. Nothing above says how overlapping/conflicting proposals are serialized, queued, or reconciled — worth a real answer before more than one Project can trigger this concurrently.
  - Answer: Always Queue the retro tasks and only run 1 at a time in FIFO, so that they don't udpate the same thing.
- **What "optional" means for a low-confidence classification prompt, concretely.** The confirmed answer allows asking a clarifying question when confidence is low, but leaves open whether that's a skippable inline question (person can dismiss it and let `'classify'`'s best guess stand) or a soft, non-blocking suggestion shown alongside a Workflow already picked. Also open: what confidence threshold triggers it, and whether that number is a fixed constant or configurable per Project.
  - Answer: Ignore the optional, if low confidence it will ask for the review, if it is confident it will not ask.
- **The RCA confidence-gate needs a schema and a mechanism that don't exist yet anywhere.** The confirmed answer ("another AI agent reviews the RCA; ≥ 90 skips straight to Dev, below asks for human review") introduces: a `confidence` field the RCA record doesn't have today (not in [`milestone-7`](milestone-7-bug-rca-workflow.md)'s schema, not added here), and a second, independent reviewing agent — is that a new Task kind (e.g. `'rca-review'`), or folded into the same `'rca'` Task's own final output? Also unresolved: does this same "confidence ≥ threshold skips the human Gate" pattern generalize to other gated Stages, or is it deliberately special-cased to Bug Fix's RCA → Dev transition only? If it generalizes, `Stage.gated` (a plain boolean today) would need to become a threshold rule instead.
  - Answer: Create a new rca-review, it should run only after rca completion and should always provide a confidence score. 
- **Auto-skipped Gates still need to be visible.** When RCA's confidence clears the threshold and the human Gate is skipped, does the Gate row still get created (`status: approved`, with the reviewing agent's score recorded) so the Gate-history timeline stays a complete audit trail, or does the run simply jump straight to Dev with no Gate record at all? The mockup's per-stage "Gate history" panel assumes every Stage has one.
  - Answer: It should be there in audit trail, stating auto-approved by reviewer as confidence score was n%.
- **Workflow catalog versioning against an in-flight `WorkflowRun`.** Now that "Workflows will be limited and evolve over time" is confirmed, what happens when someone edits `catalog/workflows/software-feature.md` while a `WorkflowRun` is paused mid-pipeline — does that run stay pinned to the Workflow definition it started with, or pick up the live edit the next time a Stage advances? No answer above addresses this, and it's the kind of thing that silently breaks a long-running run if left unspecified.
  - Answer: It will pick the live edit, since the WorkflowRun will be paused, when user resumes it, it will pick the live edit. 
- **[`gated-feature-pipeline.html`](../gated-feature-pipeline.html)'s Retro sample data is now stale.** It shows a batched "triggered after 3 bug-fix tasks closed" trigger and a single, undivided diff list — both superseded by the confirmed per-run auto-trigger and the project/global two-section split. Worth refreshing before that mockup is used as a literal build reference for Retro specifically (the rest of the mockup — stepper, Gate mechanics for ordinary Stages — is unaffected).
  - Answer: Yes it is stale, update the mockup accordingly.
- ~~File this back against milestone-6 as a concrete ask, not just a noted gap.~~ No longer applicable — milestone-9 doesn't depend on milestone-6 (per Abhishek, 2026-09-17); DB Schema/Data migration Stage output stays inside `Gate.payload` only, not a future Specification field, unless milestone-6 is built later.

### New questions, round 2 — raised by the round-1 answers

- **A queued Retro backlog has no depth limit or staleness policy.** Retros are globally serialized to one at a time; if several Projects finish Dev around the same time, later ones simply wait. If a Project starts and finishes a *second* `WorkflowRun` while its first Retro is still queued behind other Projects', does the queue collapse to one Retro turn per Project (covering both), or do they queue as two separate entries that could apply diffs out of order relative to each other?
  - Answer: If we can combine all the retro diffs of a project into one, then it is fine. Else, we will have to maintain a queue of retro diffs.
- **A Retro Gate with only one populated section still needs a "nothing here" affordance for the other.** Given a section with nothing proposed gets no Gate row at all (confirmed), does the review screen show the empty section as absent entirely, or explicitly as "no project-level changes this run" so it doesn't read as a bug in the UI? Purely a Frontend-sketch gap, not a data-model one — the data model already supports it.
  - Answer: Just show a message - No changes this run.
- **What happens if `'rca-review'` itself fails or times out?** It's now load-bearing for whether Dev gets a human Gate at all (`gateCondition` reads its score). If the scoring Task errors out rather than returning a score, does Dev default to gated (fail safe) or ungated (fail open)? Not specified by the confirmed answer, and the two defaults have very different risk profiles.
  - Answer: We should have retry mechanism for 3 times, after that we should default to fail safe.
- **Editing a live Workflow definition can change what an in-flight run does next, with no warning.** Confirmed: a paused `WorkflowRun` picks up whatever the catalog file says on resume, not a pinned version. If someone edits `catalog/workflows/bug-fix.md` to add a Stage while a run is paused mid-pipeline, does that run silently pick up the new Stage the next time it advances, or does inserting/removing Stages need different handling than editing an existing Stage's prompt/threshold in place (which is unambiguous — the same Stage, just a different rule)?
  - Answer: It picks the live edit, there is no concept of pinned version of the workflow.
- **`gateCondition` is Bug Fix-specific today but reads as a general Stage capability.** Now that one Stage's gating can depend on another Stage's structured output, is this expected to stay a one-off for `rca-review` → `dev`, or should Software Feature's own Stages (e.g., skip Architecture's Gate if its own confidence is high enough) eventually use the same mechanism? Not asked, but the schema as written doesn't prevent it — worth an explicit yes/no before other Workflows start relying on (or avoiding) it.
  - Answer: It is a general capability of the stage.

**Note:** Also consider that coding agents have a 5h and 7d token limits, if a session's token got exhausted in the middle of a workflow run, we should hold that task there with a wait for token renewal and it should automatically restart as soon as tokens are renewed. This will not be marked as error, just that it is waiting for token renewal. 
 