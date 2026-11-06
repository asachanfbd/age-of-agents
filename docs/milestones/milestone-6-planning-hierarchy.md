# Milestone 6: Roadmap → Plan → Specification → Task Hierarchy

**Status: Superseded — not being built as its own milestone** (per Abhishek, 2026-09-17). [`milestone-9`](milestone-9-workflow-catalog.md) is this milestone's enhanced superset and absorbs the one piece of it that milestone actually needs (`Project.category`) directly into its own scope instead of depending on this doc. Kept here for reference/history — [`milestone-7`](milestone-7-bug-rca-workflow.md) still nominally cites this doc for the `owner` enum and `Project.category`, a residual link not yet resolved. Everything below is the original proposal, unchanged, kept as-is for that reference value.

This is a *feature the application ships to users managing their Projects* — not a milestone in this repo's own development sense beyond the fact that it lives in this folder (see [`README.md`](README.md) for that distinction).

**Split from a single combined proposal.** This was originally drafted as one milestone covering the hierarchy below plus a Bug/RCA workflow and a Metrics/Reports system. A review pass found those three pieces only loosely coupled and recommended splitting so each is independently buildable and reviewable — this doc is the hierarchy piece; the other two are [`milestone-7-bug-rca-workflow.md`](milestone-7-bug-rca-workflow.md) and [`milestone-8-metrics-reports.md`](milestone-8-metrics-reports.md), both of which extend the `Task` record and `Project.category` field defined here.

## Why

Today a Project's planning surface is three loosely-connected things: a freeform `roadmap.md` bullet list, a per-Project "Plan" (five fixed markdown docs — Specifications/Requirements/Test Cases/E2E Testing/Performance Testing — plus a Tasks breakdown), and a separately-numbered Milestone file. Nothing enforces that a piece of work traces from "why we're doing this" down to "the actual commit that did it," and there's no ownership field for work a person (not an agent) is doing.

This milestone gives every Project a single, consistent planning spine — **Roadmap → Plan → Specification → Task** — applied uniformly across the three Project categories this app manages work for: **Software Development, SEO, and Website Development** — not just code.

**This is not written from a blank slate.** `docs/documentation-architecture.md` (written the same day as the original combined draft) already worked out a JSON-vs-markdown storage decision and proposed an `Outcome → Plan → Milestone → SpecItem → Task` hierarchy, settling the name **"Plan"** for the new roadmap-item concept and proposing the *existing* "Plan" (the five fixed docs) be renamed **"Spec."** This milestone reuses that prior work rather than re-deriving it, and explicitly reconciles where it differs — see "Reconciliation with prior proposals" below.

## Scope for this milestone (v1)

**In scope:**
- A four-level structured hierarchy — Roadmap, Plan, Specification, Task — with the exact field sets specified below, replacing today's freeform `roadmap.md` and the old five-doc Plan/Milestone split.
- `owner: 'agent' | 'abhishek'` and an effort estimate on a Task, making person-owned work a first-class, trackable thing rather than something the app has no notion of.
- An explicit `category: 'software' | 'seo' | 'website'` field on Project, which this milestone introduces and [`milestone-7`](milestone-7-bug-rca-workflow.md)/[`milestone-8`](milestone-8-metrics-reports.md) both depend on.

**Deliberately deferred (open follow-up work, not this milestone):**
- The actual rename/migration of existing code identifiers, file paths, and persisted collections that "Specification" absorbing the old Plan-docs and Milestone implies (`documentation-architecture.md` section 6 already scoped this as "the highest-cost part... a real migration, not a rename" for the Plan→Spec piece alone; this milestone adds a second rename on top of it — see "Open questions").
- The Outcome layer above Plan proposed in `documentation-architecture.md` section 2. Not requested here; a Roadmap's own "broader context" field covers the "why" a strategic Outcome record would otherwise carry, for now.
- The Bug/RCA workflow and the Metrics/Reports system — see the two companion milestones linked above.

## Reconciliation with prior proposals

`documentation-architecture.md` was written the same day and is itself still an open proposal, so this section states this milestone's position rather than assuming it's settled:

- **Adopts** its naming: **Plan** is the new roadmap-item concept (idea/priority/timing, elaborated with the four questions below) and **Specification** is the renamed, and here expanded, old five-doc Plan bundle.
- **Diverges** on Milestone: `documentation-architecture.md` kept Milestone as a distinct layer between Plan and the Tasks breakdown (`Plan → Milestone → SpecItem → Task`). This milestone instead proposes **Specification absorbs Milestone's role** — a Specification *is* the concrete target state with a definition of done (the old Milestone's job) *and* the detailed how (the old five Plan docs' job), one document instead of two. This is the single biggest structural bet in this proposal (see "Open questions").
- **Does not** introduce the separate `Outcome` layer `documentation-architecture.md` proposed above Plan — `Roadmap.broaderContext` is this milestone's stand-in for "why we're doing anything," scoped to one Project rather than a standalone cross-Milestone record.
- **Extends** the Tasks-breakdown record (`PlanItemRecord` / proposed `SpecItemRecord`) with `owner` and `effort estimate` — fields the prior doc's schema didn't have, needed here specifically for person-owned work.
- **Follows** its storage rule throughout: a list of trackable records with status/ownership (Roadmap's Plans, Specification's Tasks) is structured JSON in the central store; a single narrative (a Specification's prose fields) stays markdown-shaped text *inside* a structured record's fields, the same "structured metadata, markdown-formatted text field" treatment that doc already recommended for Decision logs and Milestones.

## New domain concepts

- **Roadmap** — one per Project, the top-level container. Not itself much more than metadata plus an ordered/related collection of Plans — there's no separate "Roadmap record" beyond a Project having one.
- **Plan** — a roadmap item: a need, not yet a committed design. Same concept `documentation-architecture.md` already named.
- **Specification** — the committed design for one Plan: current state, proposed change, and everything needed to build and verify it. Replaces both the old five-doc Plan bundle and the standalone Milestone concept (see "Reconciliation" above).
- **Task** — existing concept, extended with `owner` and `effort estimate`, now linked to a Specification requirement rather than (only) a Milestone id.
- **Project category** — `'software' | 'seo' | 'website'` on Project. Introduced here because Specification's field-fit is category-sensitive (see "Open questions"); also the field [`milestone-7`](milestone-7-bug-rca-workflow.md) and [`milestone-8`](milestone-8-metrics-reports.md) key their own category-specific behavior off of.

## Data model

### Roadmap

| Field | Notes |
|---|---|
| Name | |
| Broader context | the "why we're doing anything" narrative this Roadmap's Plans serve |
| Collection of plans | Plan ids belonging to this Roadmap |
| Plan sequence / relationships | ordering plus inter-Plan dependencies (mirrors `documentation-architecture.md`'s `dependencies` shape: internal reference vs. free-text external) |

### Plan

| Field | Notes |
|---|---|
| Name | |
| What is needed? | concrete brief |
| Why is it needed? | distinct from Roadmap's broader context — why *this* piece of work, specifically |
| Who will use it? | audience/persona |
| What problem will it solve for them? | the pain point that justifies priority |

These four fields are exactly `documentation-architecture.md`'s proposed `elaboration` block (`whatIsNeeded`/`whyNeeded`/`whoWillUseIt`/`problemSolved`) — this milestone promotes that block from "optional deepening of a Plan" to "the Plan's core fields," since without them a Plan is just a title.

### Specification

| Field | Notes |
|---|---|
| Linked plan | one Specification per Plan (a Plan isn't required to have one yet — see Plan's own lifecycle) |
| Current state | what exists today, before this change |
| Proposed change | what this Specification actually changes |
| Scope and exclusions | explicit in/out, matching this doc's own "Scope for this milestone" convention |
| Requirements | **a list of `{ id, text }` records, not a prose block** — a Task's "linked requirement" needs a stable id to point at, the same "second row needs identity" reasoning `documentation-architecture.md` already used to justify `PlanItemRecord` over a markdown checklist |
| User journey / workflow | how it's actually used, step by step |
| Inputs and outputs | |
| Rules and edge cases | |
| Quality requirements | absorbs the old Test Cases / E2E Testing / Performance Testing docs' role — see "Open questions" on whether this is enough fidelity |
| Design and references | mockups, prior art, related docs |
| Integration details | how it connects to existing systems |
| Dependencies | other Specifications, external factors |
| Migration and rollout | how existing data/users move onto this |
| Acceptance criteria | testable, checkable statements — same `{ text, met }` shape `documentation-architecture.md` proposed for Plan |
| Monitoring and recovery | how you'd know it broke, and what undoes it |
| Open questions and decisions | this Specification's own running decision log |

### Task

| Field | Notes |
|---|---|
| Name | |
| Linked requirement | a Specification Requirement's `id` — nullable ([`milestone-7`](milestone-7-bug-rca-workflow.md) leaves this null and sets its own `linkedRcaId` instead, for an RCA-originated fix Task that never traces through a Specification) |
| Work to be done | |
| Expected output | |
| Completion criteria | |
| Dependencies | other Tasks, internal or external |
| Owner | `'agent' \| 'abhishek'` — new field; a person-owned Task has none of an agent Task's automatic verifiability (transcript, diff, commit), so the UI must show it differently, per the same "make the trust difference visible" principle `documentation-architecture.md` section 4 already argued for delegate-owned Plans |
| Effort estimate | new field, not in today's `PlanItemRecord` |
| Status | |

## Architecture (sketch — needs a real pass before build)

- **Storage** follows the existing `FileDatabase<T>` pattern exactly, one collection per new record type (`plans.json`, `specifications.json`) under `server/data/`, consistent with every other collection today.
- **Roadmap** is not its own collection — it's a view over a Project's Plans, the same way "the Roadmap" in `documentation-architecture.md` was described as a view rather than a new persisted thing beyond the Plans themselves.
- **`Project.category`** is a plain enum field on the existing Project record — no separate collection, no per-category subtype of Project.

## Frontend (sketch)

- Project Popover gains a **Roadmap tab** (replacing the current freeform roadmap doc) listing Plans, each expandable into its Specification and Tasks.
- Task rows anywhere in the UI gain an owner indicator (agent vs. Abhishek) and an effort-estimate badge.

## Draft milestone task breakdown

(Becomes real Tasks-breakdown items tagged to this milestone's Specification once the plan closes — sizing only, not a final breakdown.)

1. Data model + collections: `Plan`, `Specification`, extend `Task`/`PlanItemRecord` with `owner`/`effort`, add `Project.category`.
2. Roadmap/Plan/Specification CRUD APIs + the Plan "elaboration" agent-authoring flow (reusing the restricted `'plan'`-kind Task pattern).
3. Frontend: Roadmap tab (Plan/Specification/Task drill-down).
4. The actual rename/migration this milestone implies for the old five-doc Plan and standalone Milestone (see "Open questions") — sequenced last, deliberately, per `documentation-architecture.md` section 6's "do the rename as one atomic piece, not half-finished" guidance.

## Open questions / risks

- **Does Specification really replace Milestone, or does that lose something?** Milestone today is a single, holistically-read markdown narrative an agent writes and re-reads; splitting/expanding it into 15 structured Specification fields may fragment that readability. Worth validating against a real, existing milestone file (e.g. `milestone-5-notification-system.md` itself) before committing: could its content actually be re-expressed cleanly across these 15 fields, or does something not fit?
- **Does folding Test Cases / E2E / Performance Testing into one "Quality requirements" field lose fidelity** the dedicated docs (and the richer Testing-tab plan already sketched in `workflow-command-center-gaps.md` section G) intentionally kept separate?
- **This is the second rename proposed against the same "Plan" word in one day** (`documentation-architecture.md`'s Plan→Spec, now this doc's Specification absorbing Milestone too). Compounding two renames raises the migration cost `documentation-architecture.md` section 6 already flagged as "the highest-cost part" for just the first one — needs a single, explicit sequencing decision, not two independent migrations landing separately.
- **Do Software/SEO/Website Project categories need different Specification field sets**, or does forcing e.g. an SEO Plan through "user journey / workflow" and "migration and rollout" fields meant for software produce empty, box-checking fields? Not addressed above — the schema is presented as one-size-fits-all across categories.
- **Owner `'agent' | 'abhishek'` is a closed, single-user enum** — consistent with this app's existing "local, single-user" stance, but worth confirming that's intended permanently versus `documentation-architecture.md`'s more general `Person` record (which already supports an arbitrary delegate, not just one named person).
- **No migration path for already-shipped data.** Real Projects today have real `.docs/milestones/milestone-N.md` files and `PlanItemRecord.milestoneId` values. Task 4 above covers the code/route rename but not what happens to this existing data — does an old Milestone file become a Specification automatically, get left as an orphaned legacy artifact, or require hand migration per Project?
