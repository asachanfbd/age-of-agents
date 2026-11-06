# File and folder structure

Source of truth: [`docs/spec.md`](spec.md), "File and folder structure," as amended in [`docs/architecture.md`](architecture.md#manual-project-registration-only). This reflects what's actually built — see [`docs/blueprint.md`](blueprint.md) for current implementation detail.

```
agent-visual-os/                     this repo
├── catalog/
│   ├── agents/                      agent persona definitions, Claude Code compatible format
│   ├── skills/                      skill definitions, Claude Code compatible SKILL.md format
│   └── index.json                   game metadata only: avatar, manager flag, default autonomy
├── projects/                        git-ignored: one real folder per created Project (see below)
├── server/                          Node.js/TypeScript backend: daemon, subprocess pool,
│   │                                stream-json parsing, the file-based runtime state store
│   └── data/                        git-ignored: projects.json / tasks.json / task-contexts.json /
│                                    plan-items.json (the Tasks-breakdown records)
├── web/                             Three.js + React Three Fiber frontend: home base,
│                                    buildings, workers, hover tooltips, wave/popover, chat,
│                                    and the Full-fledged Project Popover (workspace)
└── docs/                            this documentation

projects/<slug>/                     created by POST /api/projects, not pointed at an existing path
└── .docs/
    ├── blueprint.md                 agent-authored, fixed template
    ├── plan/                        the Project Popover's tab content, plain markdown
    │   ├── specifications.md
    │   ├── requirements.md
    │   ├── test-cases.md
    │   ├── e2e-testing.md
    │   └── performance-testing.md
    ├── milestones/                  optional, hand-written target states (not created with the Project)
    ├── testing/
    │   └── config.json              optional: Test Suites/Actions/Collectors (docs/testing-contract.md)
    └── (notes/, decision-logs/, tasks/ are created on demand, not at Project creation)
```

## Notes on each piece

**`catalog/agents/` and `catalog/skills/`** use the exact same file formats Claude Code itself uses (`SKILL.md`, agent markdown with standard frontmatter) — see [`docs/architecture.md`](architecture.md#catalog-is-separate-from-but-format-compatible-with-real-claude-code-config). This means any real skill or agent folder from `~/.claude/` can be copied in unmodified. The Catalog never reads from or writes to `~/.claude/` itself.

**`catalog/index.json`** holds only the extra metadata the game needs on top of the standard format: avatar, manager flag, default autonomy setting. One seed Template ships (`builder`).

**`projects/`** is git-ignored and owned entirely by the daemon: `POST /api/projects` creates `projects/<slug>/` fresh, with its `.docs/` scaffold, rather than registering a path to something that already existed elsewhere — see the amended decision in [`docs/architecture.md`](architecture.md#manual-project-registration-only). When created from an existing repository, the clone's own files are never clobbered by that scaffold (every stub is written create-exclusive), and a `'plan'`-kind Task auto-starts to read what the repository already says about itself — see [`docs/architecture.md`](architecture.md#cloning-a-repository-bootstraps-its-docs-from-what-already-exists).

**`server/`** is the background daemon — see [`docs/architecture.md`](architecture.md#background-daemon-not-session-bound). It owns the subprocess pool of `claude -p` processes, parses their `stream-json` output, and owns the central runtime-state store: a small dependency-free **file-based JSON database** (`server/src/db/FileDatabase.ts`), not SQLite — see the current implementation note in [`docs/architecture.md`](architecture.md#one-central-runtime-state-store-docs-stay-per-project). There is no `PreToolUse`/`defer` hook-based pause yet; see `server/README.md`'s "Known simplifications."

**`server/data/`** is that file-based database's storage: `projects.json` (the registry — folded into this store rather than kept as a separate root-level file, since the daemon already owns it centrally), `tasks.json`, `secrets.json` (app-wide credentials such as the SEO Google OAuth client, owner-only permissions), `task-contexts.json` (per-Task transcripts), `building-type-configs.json` (per Building Type: which Catalog workflow fills each slot and which agent runs each step), `buildings/<id>/` (one folder per Building with bulk storage: `bulk.sqlite`, `secrets.json` with owner-only permissions, `backups/`, `exports/`; removed with the Building), and `plan-items.json` (the Tasks-breakdown records — structured, not parsed markdown, so each item keeps a stable identity, status, and links to the real Tasks run for it; see [`docs/architecture.md`](architecture.md#project-plan-documents-and-the-tasks-breakdown)).

**`web/`** is the Three.js + React Three Fiber scene: the Home Base, Buildings, Workers, hover tooltips, the create-project/task-lifecycle forms, and the Full-fledged Project Popover (`ProjectWorkspaceModal.tsx`) — tabs for the plan docs and Tasks breakdown, a persistent planning/execution chat, and the per-Task details view. Talks to `server/` over REST for commands and a WebSocket (`/ws`) for live status pushes (`web/src/lib/serverApi.ts`).

**Per-project `.docs/`** lives inside each managed Project's own folder, under `projects/`. It holds human-readable markdown, plus the testing config:
- `blueprint.md` — agent-authored at the end of each Task, fixed structure covering what currently exists and what's proposed next (see [`docs/architecture.md`](architecture.md#blueprints-are-agent-authored))
- `plan/` — the Project Popover's five fixed tab docs (Specifications, Requirements, Test Cases, End-to-End Testing, Performance Testing), stubbed at Project creation, editable via the popover or by hand (see [`docs/architecture.md`](architecture.md#project-plan-documents-and-the-tasks-breakdown))
- `milestones/` — one `milestone-N.md` per Milestone, a target state with its own definition of done, broken into Tasks-breakdown items; written by hand; none is stubbed at Project creation (see [`docs/architecture.md`](architecture.md#milestones-a-projects-target-states-broken-into-tasks))
- `testing/config.json` — optional, committed testing contract (Test Suites, Test Actions, Collectors), JSON rather than markdown because the daemon validates and consumes it; never created or written by the daemon, read fresh on every request (see [`docs/testing-contract.md`](testing-contract.md))
- `notes/`, `decision-logs/`, `tasks/` — free-form project history, editable by hand at any time and created on demand (Project creation makes none of them, and no `roadmap.md` stub)

This split — runtime state centralized in `server/data/`, human-readable docs scattered per-project — is deliberate. See [`docs/architecture.md`](architecture.md#one-central-runtime-state-store-docs-stay-per-project) for why.
