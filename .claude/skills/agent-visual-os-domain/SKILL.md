---
name: agent-visual-os-domain
description: Domain vocabulary and architecture decisions for agent-visual-os's background daemon — Project, Worker, Template, Catalog, Task, Blueprint, Milestone, Manager, and the central runtime state store. Use when building server/, catalog/, or projects.json, orchestrating claude subprocesses, or managing session/context/blueprint/milestone state.
---

# agent-visual-os domain

Condensed vocabulary and decisions for the background daemon. Full detail lives in `docs/`; this is the cache — read the linked doc when you need the reasoning, not just the term.

## Vocabulary

- **Project** — a folder created fresh under this repo's own git-ignored `projects/`, one at a time (`POST /api/projects`), not a pre-existing path elsewhere pointed at by the daemon. No auto-discovery. See the amended decision in `docs/architecture.md#manual-project-registration-only`.
- **Worker** — a real `claude -p` subprocess scoped to one Project's working directory. Exists only while its process is running; shown walking around the scene while its task runs.
- **Template** — an agent persona (name, avatar, system prompt, skills, default autonomy) sitting in the Catalog, waiting to be assigned. Assigning one to a Task spawns a Worker; when the task ends, it reverts to a Template.
- **Catalog** — agent-visual-os's own `catalog/agents/` + `catalog/skills/`, format-compatible with `~/.claude/` (same `SKILL.md` / agent-markdown shape) but never reads from or writes to it.
- **Task** — one unit of work on a Project. Only one active Task per Project in v1 — no concurrent Workers sharing a working directory yet.
- **Blueprint** — `<project>/.docs/blueprint.md`, agent-authored at the end of each Task, fixed structure covering what was built and what's proposed next.
- **Milestone** — `<project>/.docs/milestones/milestone-N.md`, a target state with its own definition of done, agent-authored like the Blueprint; its own task breakdown is real `PlanItemRecord`s tagged with that milestone's id, not a separate list.
- **Test Suite / Test Action / Collector / Test Run** — the Project testing contract: suites and their actions (one primary `result` action each; `utility` actions never change test status) and collectors live in the committed `<project>/.docs/testing/config.json`, read fresh on every request; Test Run records stay in the central data dir (`test-runs.json`, with each run's log/result in `test-runs/<id>.*`), run one at a time per Project through `testing/testRunner.ts`'s queue (agent runs in their Task's worktree; latest results count only the primary tree). UI never parses framework output. Schema: `docs/testing-contract.md`; code: `server/src/testing/`.
- **Manager** (Phase 2, not yet built) — a Template that delegates to native Claude Code sub-agents and relays a blocked sub-agent's clarifying questions, since only a top-level process can natively ask the user one.

Full definitions: `docs/glossary.md`.

## Before hand-building the subprocess pool

Check whether native CLI commands — `claude agents --json`, `claude logs <id>`, `--bg`, `-w`/`--worktree` — already cover subprocess tracking, status polling, or worktree handling. This is an explicit checkpoint before Phase 1 work starts (`docs/roadmap.md`) and could change the shape of `server/` significantly; don't hand-roll what the CLI already gives you.

## State is split on purpose

One central runtime state store — a small dependency-free file-based JSON database, `server/src/db/FileDatabase.ts` (one JSON file per collection under `server/data/`, not SQLite) — holds live state — Workers, sessions, in-progress Task status. Everything human-readable (notes, decision logs, tasks, roadmap, the blueprint, milestones) stays as per-project markdown under `<project>/.docs/`, editable by hand at any time. Don't merge these two — see `docs/architecture.md` for why the split exists.

## v1 scope boundaries

Local-only: no auth, no multi-user access, no hosting. One active Task per Project. The terminal transcript is read-only — rendered `stream-json`, not a live PTY; you can't type into a Worker's session directly in v1.

## Where the rest lives

- Every architecture decision and its rationale (CLI vs. SDK, the pause/resume mechanism): `docs/architecture.md`.
- Target repo layout, including the per-project `.docs/` shape: `docs/file-structure.md`.
- Phased scope (what's in v1 vs. later): `docs/roadmap.md`.
- Open questions and known risks: `docs/risks.md`.
