# Milestone 7: Bug Reporting & RCA Workflow

**Status: Plan.** This document is a proposal, not a build spec — nothing described here exists yet. Once reviewed and closed, `roadmap.md` gets a real section for it, `architecture.md` gets the actual architecture decisions made along the way, `glossary.md` gets the new terms, and implementation starts, tracked as ordinary Tasks-breakdown work against this milestone. Until then, treat every detail below as a draft open to revision.

**Depends on [`milestone-6-planning-hierarchy.md`](milestone-6-planning-hierarchy.md)**: this milestone extends the `Task` record and `Project.category` field that one defines. Originally drafted as part of a single combined proposal with milestone-6 and [`milestone-8-metrics-reports.md`](milestone-8-metrics-reports.md); split out because a review pass found the three only loosely coupled — this workflow doesn't need Metrics at all, and doesn't require the hierarchy rename in milestone-6 to be finished first, only its `Task`/`Project` shape to exist.

## Why

Today there's no structured place to report a bug, no forced investigation step before someone (or some agent) jumps straight to a fix, and no durable record of *why* something broke once it's fixed. This milestone gives every Project a Bug Panel, an agent-authored Root Cause Analysis (RCA) per bug, and a fix Task generated only once that RCA exists — so "reported" never jumps straight to "fixed" without a recorded diagnosis in between.

## Scope for this milestone (v1)

**In scope:**
- A Bug Panel to report bugs per Project.
- An agent-authored RCA per Bug, produced by a new, read-only `'rca'` Task kind.
- A fix Task generated from the RCA's recommended fix once the RCA settles — never created directly from a Bug report.
- Reusing the `owner: 'agent' | 'abhishek'` field [`milestone-6`](milestone-6-planning-hierarchy.md) introduces, for who reported the bug and (implicitly, for now) who owns the fix.

**Deliberately deferred (open follow-up work, not this milestone):**
- A genuinely different Bug/RCA shape for non-software Project categories (SEO, content) — see "Open questions." This milestone ships the software-shaped version first.
- Any automatic bug detection (log scraping, error-tracking integration) — a Bug here is always explicitly reported, not inferred.

## New domain concepts

- **Bug** — a reported defect, independent of the Roadmap/Plan/Specification/Task chain until an RCA turns it into a fix Task.
- **RCA (Root Cause Analysis)** — an agent-authored analysis of one Bug, produced before any fix work starts.

## Data model

### Bug

| Field | Notes |
|---|---|
| Title / description | |
| Reproduction steps | |
| Severity | |
| Status | `reported → rca_in_progress → rca_complete → fix_in_progress → fixed → verified/closed` |
| Linked RCA | |
| Linked fix Task(s) | created only once the RCA exists — a Bug never jumps straight from "reported" to "fix Task," by design (see Architecture) |
| Reported by | `'agent' \| 'abhishek'` — reuses the owner enum [`milestone-6`](milestone-6-planning-hierarchy.md) introduces on Task |

### RCA

| Field | Notes |
|---|---|
| Linked bug | |
| Summary | |
| Root cause | |
| Evidence | logs, transcript excerpts, repro output |
| Affected components | |
| Recommended fix | this becomes the fix Task's "work to be done" |

### Task (extension of milestone-6's record)

| Field | Notes |
|---|---|
| Linked RCA | nullable; set instead of milestone-6's "Linked requirement" for a Bug-originated fix Task, which never traces through a Specification |

## Architecture (sketch — needs a real pass before build)

- **Storage** follows the existing `FileDatabase<T>` pattern: new `bugs.json` / `rcas.json` collections under `server/data/`.
- **Bug → RCA → Task is a deliberate two-step gate, not a shortcut, and gets its own named Task kind.** A Bug cannot get a fix Task without an RCA existing first — the same "spawn a structured turn, capture its output, then act" pattern the Notification milestone (`milestone-5`) already uses for its decision-making agent. Concretely, mirroring how milestone-5 names `'notification'` explicitly: a new Task **kind, `'rca'`**, read-only (same disallowed-tools treatment as the existing `'plan'` kind — investigate, never edit source), whose `--json-schema` requires the RCA's fields above. Like `'notification'`, it has no Building/Worker representation, since it isn't scoped to producing a change. Once it settles, the daemon creates a normal, Building-visible `'execute'`-kind Task from its `recommendedFix`, with `linkedRcaId` set and `linkedRequirementId` left null.

## Frontend (sketch)

- A **Bug Panel** tab: report a bug, see its RCA once ready, see the fix Task it spawned.

## Draft milestone task breakdown

(Becomes real Tasks-breakdown items tagged to this milestone's Specification once the plan closes — sizing only, not a final breakdown.)

1. Data model + collections: `Bug`, `RCA`, extend `Task` with `linkedRcaId`.
2. Bug Panel API: report, list, status transitions.
3. The `'rca'`-kind Task: `--json-schema`, disallowed-tools restriction, no Building/Worker representation.
4. The gated fix-Task creation once an RCA settles.
5. Frontend: Bug Panel tab.

## Open questions / risks

- **RCA is scoped read-only, investigate-only** — needs the same tool-restriction treatment the existing `'plan'`-kind Task already gets (disallowed tools, no source edits), not assumed to happen automatically just because the Task is *called* `'rca'`. The restriction itself still needs to be actually specified, not just implied by the name.
- **The Bug/RCA schema is defect-shaped and may not fit an SEO or content problem at all.** A ranking drop has no "reproduction steps," and RCA's evidence (logs, transcripts, repro output) assumes software artifacts, where a real SEO investigation needs Search Console/SERP/backlink data instead. This may need a genuinely different Bug/RCA shape per [`milestone-6`](milestone-6-planning-hierarchy.md)'s `Project.category`, not just optional fields on one shared shape — flagged here as a v1 gap, deliberately deferred above rather than solved.
- **Fix Tasks are implicitly `'execute'`-kind, which assumes source-controlled, commit/diff/worktree work.** Many SEO or content fixes ("rewrite this page's copy," "build backlinks") have no code to commit, so the existing Task execution model doesn't uniformly apply the way this milestone currently assumes for non-software categories.
