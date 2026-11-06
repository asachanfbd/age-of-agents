# Milestones

This folder tracks **agent-visual-os's own development milestones** — the stages this repository itself has gone through and is going through.

This is a different concept from the per-project **Milestone** this application builds *for the Projects it manages* (a target state under a managed Project's own `.docs/milestones/milestone-N.md` — see [`../glossary.md`](../glossary.md#milestone) and [`../architecture.md`](../architecture.md#milestones-a-projects-target-states-broken-into-tasks)). Same word, two different things: one is this repo's own roadmap, the other is a feature this repo ships to users. Don't confuse a file in here with a file under `projects/<slug>/.docs/milestones/`.

`roadmap.md` remains the detailed, canonical feature checklist; a milestone here is the coarser grouping that checklist's work is organized under. A milestone gets its own file once it's substantial enough to need one (a real design, open questions, a multi-step build) — small roadmap items still just live as a bullet list in [`../roadmap.md`](../roadmap.md).

| # | Name | Status | Detail |
|---|------|--------|--------|
| 0 | Spike | Done | [`spec.md`](../spec.md#phased-scope) |
| 1 | MVP | Done | [`blueprint.md`](../blueprint.md), [`roadmap.md`](../roadmap.md) |
| 2 | Delegation & Sub-agents | Done | [`roadmap.md`](../roadmap.md), [`architecture.md`](../architecture.md#manager-and-sub-agent-flow-native-delegation-with-a-relay-for-questions) |
| 3 | Scale Out, Catalog UI & Autonomy | Done | [`roadmap.md`](../roadmap.md) |
| 4 | Worktrees & Live Terminal | Worktrees done; live PTY terminal deferred | [`roadmap.md`](../roadmap.md), [`architecture.md`](../architecture.md#concurrent-tasks-per-project) |
| 5 | [Notification System](milestone-5-notification-system.md) | **Plan** | this folder |
| 6 | [Roadmap → Plan → Specification → Task Hierarchy](milestone-6-planning-hierarchy.md) | **Superseded** — not being built standalone; see note | this folder |
| 7 | [Bug Reporting & RCA Workflow](milestone-7-bug-rca-workflow.md) | **Plan** | this folder |
| 8 | [Metrics & Reports](milestone-8-metrics-reports.md) | **Plan** | this folder |
| 9 | [Workflow Catalog & the Start Screen](milestone-9-workflow-catalog.md) | **Plan** | this folder |

Milestones 6-8 were originally drafted as one combined proposal, then split after review found the three pieces only loosely coupled — see the "Split from a single combined proposal" note at the top of milestone-6.

**Milestone 6 is not being built as its own milestone** (per Abhishek, 2026-09-17) — milestone-9 is its enhanced superset and absorbs the one piece of it milestone-9 actually needs (`Project.category`) directly into its own scope. Milestone-6's doc is kept for reference only; milestone-7 still nominally cites it for the `owner` enum and `Project.category`, a residual link not yet resolved.

Milestone 9 generalizes the fixed 7-stage pipeline first designed and reviewed as an interactive mockup (`../gated-feature-pipeline.html`) into a selectable **Workflow** catalog. It depends only on milestone-7 (the `'rca'` Task kind, which its Bug Fix workflow wraps) — it does not depend on milestone-6.

Milestones 0-4 predate this folder and are fully documented in the existing docs linked above — they aren't being retroactively split into their own files, to avoid duplicating content that already lives in `spec.md`/`roadmap.md`/`architecture.md`. Milestone 5 onward gets a file here from the start, written before the build begins rather than after (existing milestones' design decisions were captured in `architecture.md` after the fact, once built).
