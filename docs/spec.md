# agent-visual-os: specification

## Summary

agent-visual-os is a personal, local tool for watching and directing Claude Code agents that work on real projects, shown as a browser-based, Age of Empires-style scene. Projects are buildings, agents are workers, and a central home base holds the templates assigned to new tasks. Every worker on screen is a real `claude` CLI process running against a real project directory, not a mock or a scripted animation. This document is the output of a grilling session held on 2026-09-12 and records every decision made about scope, architecture, and interaction model before any code was written. It is preserved here verbatim as the canonical source of truth; the other files in `docs/` break its content into more navigable pieces but should never contradict it — if they ever drift, this file wins.

## Motivation

Multiple Claude Code agents can already work on different projects at once, but there is no single place to see what each one is doing, get pulled in only when an agent needs a decision, or hand off new work without opening a separate terminal per project. agent-visual-os is that place, built as a game because that makes glancing at agent status something you'd actually want to do.

## Domain glossary

**Agent.** The underlying unit of work: a real, running `claude` CLI process, scoped to one project's working directory.

**Worker.** The visual character in the scene representing one active Agent. A Worker exists only while its Agent process is running, and appears at the Building for the project it is working on.

**Manager Agent.** An Agent Template flagged as able to delegate sub-tasks to native Claude Code sub-agents during its run. Only a Manager, being the top-level process, can natively surface a clarifying question to the user; its delegated sub-agents cannot.

**Template.** An agent persona in the Catalog: a name, avatar, base system prompt and skill set, a manager flag, and a default autonomy setting. No live process is attached to a Template. Assigning a Template to a task spawns a real Worker; when that Worker's task ends, it reverts to being a Template again.

**Building.** The visual representation of one registered Project. Clicking a Building is how a new task, and the Template(s) to run it, gets assigned.

**Home Base.** The central hub in the scene showing the full Catalog of available Templates and skills, with controls to add, remove, or disable them.

**Task.** A freeform, user-written description of work assigned to one Template (which becomes a Worker) on one Project. Version 1 allows one active Task per Project at a time.

**Catalog.** agent-visual-os's own, self-contained collection of agent and skill definitions. It does not read or modify the user's real `~/.claude/` configuration, though the files in it use the same format Claude Code itself uses.

**Blueprint.** A project's auto-maintained `.docs/blueprint.md`, written and updated by the Worker itself at the end of each Task following a fixed structure, describing what was built and what is proposed next.

**Project.** One folder on disk, manually registered with agent-visual-os by path. Shown in the scene as one Building. Each Project keeps its own `.docs/` folder with its Blueprint plus notes, decision logs, tasks, and a roadmap, all as markdown.

## Architecture decisions

### Real agents, not a simulation

Workers in the scene are backed by real `claude` CLI processes doing real work from the first version, not a mocked visualization layered on top of fake status. This was chosen over a phased approach (mock first, wire up real execution later) because the whole point of the tool is to watch and direct actual work.

### Standalone tool, not scoped to this repo

agent-visual-os is a general tool that can manage any project on the machine, this repo's own projects being only one possible set among many. It is not nested inside a client project folder, and its own file conventions (catalog, per-project `.docs/` folders) are independent of this repo's structure.

### Local, single-user, no hosting

Runs as a local server on the machine, opened in a browser. No authentication, no multi-user access, no deployment target. If sharing status with clients or teammates becomes a goal later, that is a separate, larger piece of scope not covered here.

### CLI subprocess orchestration, not the Agent SDK

Agents are launched as `claude -p` subprocesses managed directly by agent-visual-os's backend, using `--output-format stream-json` for structured, streamable state, `--permission-prompt-tool` and `PreToolUse` hooks with the `defer` decision to detect and pause on a blocked tool call or clarifying question, and `--resume <session_id>` to continue a paused session. This was chosen over the Claude Agent SDK specifically to avoid separate API-key billing: the CLI path can run against the existing Claude Code subscription. Research found that the Agent SDK is, underneath, a typed wrapper that spawns the same CLI subprocess, so no orchestration capability is lost by going directly to the CLI; the tradeoff is doing the stream-json parsing and hook wiring by hand instead of getting typed message objects for free.

One caveat worth stating plainly: Anthropic's stated policy reserves subscription login for ordinary individual use of Claude Code, and describes API-key billing as the expected path for "developers building products or services" on top of Claude. A tool that programmatically spawns CLI processes sits closer to that second case, even when, as here, the only user is the person who owns the subscription. This is a known gray area, not a blocker, and is worth rechecking against Anthropic's terms before this goes beyond personal use.

A spike run against the actual CLI build available to this account on 2026-09-12 (see `docs/research/real-agent-orchestration-options.md` for the full test log) confirmed the mechanism this depends on, and found it works differently from what the desk research assumed. `AskUserQuestion` is not available as a tool at all in headless (`-p`) mode on this build; a session asked to use it searched for it and found nothing. What does work, confirmed end to end: prompting a worker to end its turn with a clear question (optionally enforced with `--json-schema` so the response is reliably parseable as `{"status": "blocked", "message": "..."}` rather than free text) when it needs input, detecting that status from the completed turn's result, and then running `claude -p --resume <session_id> "<the user's answer>"` as a fresh invocation. The resumed session picked its task back up correctly, with full context of what it had already asked and why. This is not a live, frozen process being unblocked; it is a completed turn followed by a fresh one carrying the same session ID, which happens to be exactly the shape the "blocked-and-relaunch" design below already assumed for sub-agents, so no design change was needed, just a more concrete implementation path than originally planned.

The same spike surfaced a second, separate fact worth having on record: permission mode determines whether a headless session pauses or just fails silently, and the two look very different. With the default permission mode, a file-write attempt was not paused or asked about; it was denied outright, and the worker's turn ended by explaining that its write had been refused. With `--permission-mode bypassPermissions`, the same task actually created its files with no denials. In other words, the "full autonomy by default" decision above is not just a UI toggle; it has to be wired through as an actual `--permission-mode bypassPermissions` (or equivalent) flag on the worker's process, or every tool call that would normally need approval will quietly fail instead of doing anything.

### Background daemon, not session-bound

A background server process keeps running independently of the browser tab, so agents keep working with the tab closed and the UI just reconnects to live state when reopened. The alternative, where agents only run while a tab is open, was rejected because it undercuts the point of an ambient status view.

### Manual project registration only

Projects are added one at a time, not through automatic scanning or discovery of directories. This was chosen over auto-discovery specifically because a discovered project would get real, potentially fully autonomous agent access the moment it was found, which is not something that should happen without a deliberate step.

**Amended, 2026-09-13:** see [`docs/architecture.md`](architecture.md#manual-project-registration-only) — creating a Project now creates a fresh folder under agent-visual-os's own git-ignored `projects/` directory instead of registering an arbitrary pre-existing path.

**Amended, 2026-09-14:** creating a Project from an existing repository auto-starts a Task that reads whatever documentation the repository already has and uses it to fill in the new Project's docs, rather than leaving them as blank stubs — see [`docs/architecture.md`](architecture.md#cloning-a-repository-bootstraps-its-docs-from-what-already-exists).

### Its own git repository

agent-visual-os is real, ongoing software with its own git history, kept separate from every project it manages.

### Full autonomy by default, switchable per task

An assigned Worker can edit files, run commands, and commit without per-action approval by default. A setting can flip a given Task to approval-gated instead, and that setting can be changed both when the task is created and while it is running. A single global switch was rejected as too blunt given that this will run against real client repositories as well as low-stakes personal projects.

### Home base shows Templates, not live processes

The Catalog at the home base lists agent personas as configuration, not as running processes sitting idle. A real process only exists once a Template is assigned to a Task. An idle LLM process with nothing to do would have no purpose and would visually misrepresent what is actually happening.

### Catalog is separate from, but format-compatible with, real Claude Code config

The Catalog is agent-visual-os's own collection, independent of the user's actual `~/.claude/` setup, so changes in one never affect the other. The files themselves, however, use the exact same format Claude Code uses for skills and agents (`SKILL.md`, agent markdown files with standard frontmatter), so any real skill or agent folder can be copied in unmodified. The extra metadata the game needs, such as avatar, manager flag, and default autonomy, is tracked in a separate index alongside the Catalog rather than added into the agent or skill files themselves, so those files stay ordinary and portable.

### Manager and sub-agent flow: native delegation, with a relay for questions

A Manager Template spawns sub-agents through Claude Code's own built-in delegation (the Agent/Task tool) rather than agent-visual-os launching a fully separate OS process per sub-agent. This has a real consequence: native sub-agent delegation has no true mid-task pause. When a delegated sub-agent hits something it needs clarified, its current call ends, reporting what it finished and what it is blocked on. The Manager, being the only one of the two with native access to ask the user a question, is the one that raises the question through the wave-and-popover-and-chat interaction. Once answered, the Manager makes a fresh delegated call carrying the answer, continuing the remaining work.

A visible consequence of this design: the blocked sub-agent's Worker keeps showing a working animation through the gap between its call ending and the follow-up call starting. That is a deliberate simplification in the visual layer, not a literal frozen process kept alive in the background.

### Blueprints are agent-authored

The assigned Worker writes and updates its Project's `.docs/blueprint.md` automatically at the end of each Task, following a fixed template covering what was built and what is proposed next. The user is not required to write these by hand, though the files are plain markdown and can be edited freely at any time.

**Amended, 2026-09-14:** a Project also gets Milestones — target states with their own definition of done, each broken into real Tasks-breakdown items — under `.docs/milestones/`, authored the same agent-first way. See [`docs/architecture.md`](architecture.md#milestones-a-projects-target-states-broken-into-tasks).

### One central runtime-state store, docs stay per-project

Live orchestration state (process status, Task status, transcripts, pending questions) lives in one store, covering every registered Project at once. This was chosen over a separate store per project because the background daemon already manages every Project centrally, and a single store makes a cross-project view a single query instead of a scan across many small databases. Human-readable documentation (notes, blueprint, decision logs) stays as per-project markdown inside each Project's own `.docs/` folder, kept apart from the runtime store.

**Amended, 2026-09-13:** built as a small file-based JSON database (`server/src/db/FileDatabase.ts`) rather than SQLite — see [`docs/architecture.md`](architecture.md#one-central-runtime-state-store-docs-stay-per-project).

### One task per project in version 1

Only one active Task is allowed per Project at a time in the first version. Multiple Workers sharing one project's working directory at once is a real source of file and git conflicts, and the standard fix, an isolated git worktree per Worker, is deferred until concurrent Tasks on one Project are actually supported. Two existing tools found during research, `claude-squad` and `crystal`, solve this exact problem with per-agent worktrees, which is the reference point for how this would work once it is built.

### Read-only terminal transcript in version 1

Each Worker's terminal-style output pane is built by rendering the parsed `stream-json` event stream as formatted text through `xterm.js` used purely as a display widget. There is no live, interactive PTY (`node-pty`) session behind it in this version, so there is no way to type directly into a Worker's session. A real interactive escape hatch is a plausible later addition, deferred partly because it would also require deciding how typed input interacts with the autonomy setting, which is not resolved for that mode.

### Node.js and TypeScript throughout

The backend and frontend both use Node.js and TypeScript, avoiding a two-language stack for a tool built and maintained by one person.

### Three.js and React Three Fiber for the scene

The scene is rendered in Three.js, with React Three Fiber for the React integration layer, populated with free, stylized-but-three-dimensional low-poly asset packs (Kenney's city and character packs, Quaternius, or similar) rather than flat pixel sprites, with real lighting and shadows. This was chosen over 2D sprite frameworks like Phaser or PixiJS specifically because the goal is a scene that reads as dimensional and clean, not as 2D pixel art, and true 3D rendering is the only one of the options considered that can deliver that regardless of art quality. This will look like a clean, modern 3D city-builder scene, not photorealistic visuals; genuinely photorealistic rendering would need an art budget this project does not have.

## File and folder structure (planning level, not yet created)

```
agent-visual-os/                     own git repo
├── catalog/
│   ├── agents/                      agent persona definitions, Claude Code compatible format
│   ├── skills/                      skill definitions, Claude Code compatible SKILL.md format
│   └── index.json                   game metadata only: avatar, manager flag, default autonomy
├── server/                          Node.js/TypeScript backend: daemon, subprocess pool,
│                                    stream-json parsing, hook/permission-prompt handling,
│                                    central runtime state store
├── web/                             Three.js + React Three Fiber frontend: home base,
│                                    buildings, workers, hover tooltips, wave/popover, chat
└── projects.json                    registry of manually added projects and their paths

<any project folder>/                lives wherever the real project already is, not inside
                                      agent-visual-os
└── .docs/
    ├── blueprint.md                 agent-authored, fixed template
    ├── notes/
    ├── decision-logs/
    ├── tasks/
    └── roadmap.md
```

## Phased scope

**Phase 0, spike. Done, 2026-09-12.** Confirmed, outside of any UI, that a headless `claude -p` process can be made to end its turn with a question and be resumed with an answer, end to end, with context intact. See "CLI subprocess orchestration" above and `docs/research/real-agent-orchestration-options.md` for the mechanism and the permission-mode finding that came with it.

**Phase 1, MVP.** The full architecture above, stood up against one registered pilot Project and one non-manager Worker: manual project registration, a small Catalog, the background daemon spawning and tracking a `claude -p` subprocess, the central state store, a scene with one Building and the home base, hover tooltips, the wave-and-popover-into-chat flow for questions, the read-only terminal transcript, and an agent-authored blueprint written at task end.

**Phase 2.** Manager Templates and native sub-agent delegation, including the blocked-and-relay flow described above.

**Phase 3.** More Projects registered and worked on at once, the per-task autonomy toggle exercised in practice, and Catalog add/remove/disable handled through the UI rather than by hand.

**Phase 4, not committed.** Isolated git worktrees for concurrent Tasks on one Project, and a live, interactive PTY escape hatch into a Worker's session, alongside the autonomy question that raises.

## Known risks

Running a programmatic orchestration tool against a Claude Code subscription login, rather than a separate API key, is a plausible gray area under Anthropic's own stated terms, as described above. Fine for personal, single-user use as currently scoped; worth rechecking if the tool's use ever expands beyond that.

The spike confirmed the pause-and-resume mechanism works, but only tested it against this account's current CLI build (v2.1.269) and its current tool set, which is a customized build with several tools (background session management, cron, remote triggers) not part of the plain open-source Claude Code CLI. Anthropic could change headless-mode behavior, the availability of `AskUserQuestion`, or `--json-schema` handling in a future version. Worth a quick re-check of the same spike after any CLI upgrade, before assuming the mechanism still holds.

## A finding that may reduce how much of this needs to be hand-built

While running the Phase 0 spike, `claude --help` turned up something not covered in the original research: this CLI build already has native commands for managing background sessions, not just the `-p`/`--resume` primitives the design above is built on. `claude --bg` starts a session in the background and returns immediately; `claude agents --json` lists every active session, interactive and background, with its pid, working directory, and status; `claude logs <id>` prints a background session's recent terminal output; `claude attach <id>` opens one in the current terminal; `claude stop`/`claude rm` end one. There is also a `-w`/`--worktree` flag that creates a git worktree for a session directly, which is the exact mechanism Phase 4 above expects to build by hand later.

None of this was exercised deeply in this session (`claude agents --json` was only used to confirm the command works and to check for stray sessions, not to build against), and it was not part of the original research since it does not appear to be documented in the same public docs that research was based on. But if `claude logs <id>` gives usable structured or near-structured output, and `claude agents --json` gives a reliable way to poll status, a real chunk of what "server/" in the file structure above was planned to hand-build, the subprocess pool, status polling, and possibly the read-only terminal transcript, might already exist as CLI primitives to build on top of rather than reimplement. Worth a dedicated, deeper look before Phase 1 starts, since it could change the shape of the server component significantly.

## Left open for build time

The tool's final location on disk. The exact sections of the blueprint template. How buildings are laid out or rearranged in the scene. What a crashed or errored Worker looks like visually. Whether the catalog's metadata index is JSON, YAML, or something else.

## Origin of this document

This specification was written during a grilling session on 2026-09-12, before this repository existed, in a planning-only folder (`client-projects-research/agent-visual-os/`) inside a separate repo used for scoping client and personal projects ahead of their own builds. That folder's own README described it as scoped to research and planning only, with the actual build meant to move to its own repository once work started — this repository is that move. The planning folder stays behind in the other repo as the historical record of how this project was scoped; this file is a verbatim copy of `brief.md` from that folder, kept here as the canonical spec going forward.
