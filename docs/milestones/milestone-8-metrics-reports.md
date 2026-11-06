# Milestone 8: Metrics & Reports

**Status: Plan.** This document is a proposal, not a build spec — nothing described here exists yet. Once reviewed and closed, `roadmap.md` gets a real section for it, `architecture.md` gets the actual architecture decisions made along the way, `glossary.md` gets the new terms, and implementation starts, tracked as ordinary Tasks-breakdown work against this milestone. Until then, treat every detail below as a draft open to revision.

**Depends on [`milestone-6-planning-hierarchy.md`](milestone-6-planning-hierarchy.md)** for the `Project.category` field this milestone's default-metric seeding keys off of. Originally drafted as part of a single combined proposal with milestone-6 and [`milestone-7-bug-rca-workflow.md`](milestone-7-bug-rca-workflow.md); split out because a review pass found the three only loosely coupled — this system doesn't need the Bug/RCA workflow at all, and doesn't require the hierarchy rename in milestone-6 to be finished, only its `Project.category` field to exist.

## Why

Today there's no per-project view of the metrics that would tell you whether any of the work being tracked is actually moving a number — the footer shows a live quota snapshot only, with no historical/trend view (`docs/workflow-command-center-gaps.md` section D already flagged this gap independently). This milestone gives every Project an opt-in Metrics system (dated, named measurements) and a Reports section that can render them and generate a written report from a predefined, agent-authorable format.

## Scope for this milestone (v1)

**In scope:**
- A Metrics system: per-Project, dated metric records, opt-in per Project (not every Project needs it).
- A per-Project Reports section that renders Metrics and can generate a written report from a predefined **Report Format** that an agent can author (not just a fixed built-in list).
- Category-driven default metric keys / report formats, keyed off [`milestone-6`](milestone-6-planning-hierarchy.md)'s `Project.category`.
- Absorbing `workflow-command-center-gaps.md` section D's usage-trend charting (token usage / task duration over time) as one concrete metric source this system covers, rather than leaving it as a separate, unaddressed gap.

**Deliberately deferred (open follow-up work, not this milestone):**
- Report *format design* itself (what a "software dev status report" or "SEO ranking report" actually contains) — this milestone builds the mechanism, not a specific library of formats.
- Any charting/visualization polish beyond a basic per-metric time series — this is a data-and-plumbing milestone, not a dashboard-design one.
- Cross-project reporting (a report spanning more than one Project) — every Metric and Report here is scoped to one Project.
- A defined ingestion source for metrics this app can't derive itself (SEO rankings, traffic) — see "Open questions."

## New domain concepts

- **Metric** — one dated, named measurement for a Project (a number on a day).
- **Report** — a generated document over a date range of Metrics, built from a **Report Format**.
- **Report Format** — a named, reusable template (which metrics, what sections, what date grouping) that an agent can author, not just a fixed built-in list.

## Data model

### Metric

| Field | Notes |
|---|---|
| Project id | |
| Metric key | e.g. `deploy_frequency`, `organic_traffic`, `lighthouse_perf`, `task_token_usage`, `task_duration` — open-ended, not a fixed enum, since categories need different metrics |
| Date | one value per key per day |
| Value | numeric |
| Unit | |

### Report Format

| Field | Notes |
|---|---|
| Name | |
| Metric keys included | |
| Sections | what the generated report actually contains, beyond a raw metric dump |
| Date grouping | daily/weekly/monthly rollup |
| Applicable categories | which [`Project.category`](milestone-6-planning-hierarchy.md) value(s) this format makes sense for |

### Report

| Field | Notes |
|---|---|
| Project id | |
| Format used | |
| Date range | |
| Generated at / by | always agent-generated on demand or on a schedule |
| Content | the rendered output — markdown, mirroring how Blueprint is a generated markdown narrative referenced by a structured record, not a JSON blob itself |

## Architecture (sketch — needs a real pass before build)

- **Storage** follows the existing `FileDatabase<T>` pattern: new `metrics.json` / `reports.json` / `report-formats.json` collections under `server/data/`.
- **Report generation gets its own named Task kind: `'report'`.** Reuses the existing structured-output pattern (`--json-schema` on a Task turn) — hydrated with the relevant Metrics for the date range (filtered server-side, rendered as a compact table, not raw JSON, per `documentation-architecture.md` section 5's "store structured, inject compact" rule) — and, like `'rca'` (`milestone-7`) and `'notification'` (`milestone-5`), has no Building/Worker representation.
- **Metrics/Reports are opt-in per Project**, via a new `Project.metricsEnabled: boolean` (default `false`), and category-driven defaults come from a small static `category → { defaultMetricKeys, defaultReportFormatIds }` seed table, applied once when `metricsEnabled` is first turned on for a Project — not a dynamic rule engine.
- **Metric ingestion** is out of scope to fully design here — some metrics (deploy frequency, bug count, task token usage/duration) can be derived from data this app already has; others (SEO rankings, traffic) need an external source this milestone doesn't specify. Flagged directly in "Open questions."

## Frontend (sketch)

- A **Reports tab**: metric charts (basic time series per key), a list of generated Reports, and a "Generate report" action against a chosen Report Format and date range.

## Draft milestone task breakdown

(Becomes real Tasks-breakdown items tagged to this milestone's Specification once the plan closes — sizing only, not a final breakdown.)

1. Data model + collections: `Metric`, `Report`, `ReportFormat`, add `Project.metricsEnabled`.
2. Metrics: a minimal ingestion API (`POST` a dated value), per-category default metric key seeding, and wiring the two derivable metrics this milestone claims (task token usage, task duration) from existing Worker/Task data.
3. Report Formats: CRUD + an agent-authoring flow for a new format.
4. Report generation: the `'report'`-kind structured-output Task that renders Metrics into a Report.
5. Frontend: Reports tab (charts + report list + generate action).

## Open questions / risks

- **Metric ingestion has no defined source for anything this app can't derive itself.** Where do SEO/website metrics (rankings, traffic, Lighthouse scores) actually come from — manual entry, a Project Command's output, a third-party API integration? This milestone assumes a `POST` exists to record a value but doesn't say who calls it for non-derivable metrics.
- **`workflow-command-center-gaps.md` section G's Testing-tab ask** (pass/fail table, run button, execution graph, test-dependency graph) is a plausible additional metric/report source (test pass rate over time, coverage trend) that this milestone doesn't explicitly wire in — worth revisiting once that tab exists, rather than assumed to fall out of this system automatically.
- **Report Format's "applicable categories" and the default-seeding table are asserted but not owned by anyone** — someone (a person, or an agent-authoring flow) has to actually write the first Report Formats before "generate a report" means anything; this milestone builds the mechanism but ships with no real formats.
