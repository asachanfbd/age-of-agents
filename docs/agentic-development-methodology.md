# Controlled agentic development: research report & proposed methodology

**What this is**: a research-backed design document, not a living doc — a snapshot as of 2026-09-17. It answers: how should AI coding agents (primarily Claude Code, with Codex and Gemini CLI as present/future executors in this app) develop real software in a controlled way — managing context, code quality, drift, review, and testing — split into a **common flow** (every project) and a **project-specific flow** (adapted to a project's own stack/structure/target)? This is a design proposal to react to, not something already implemented — no code was changed.

Research covered: Anthropic's own published Claude Code mechanisms and best practices; OpenAI Codex CLI's equivalent mechanisms; Google Gemini CLI's equivalent mechanisms; and industry/community practice (spec-driven development frameworks, agentic TDD patterns, AI code-review tooling, documentation-drift tooling, multi-repo agent orchestrators, and CI quality-gate practice). Every factual claim below traces to a real, named source found during that research; anything that's my own synthesis rather than a sourced claim is labeled as such.

---

## 0. The one finding that reframes everything else

Your own global instructions file, `~/.claude/CLAUDE.md`, is not just "how you like Claude Code to behave when you're chatting with it interactively." Claude Code loads CLAUDE.md **hierarchically and unconditionally** — managed policy, then user (`~/.claude/CLAUDE.md`), then project, then local — concatenating all of them into every session's context, and this loading is a core CLI behavior, not an interactive-mode-only feature. Since agent-visual-os spawns every Worker as `claude -p` on the same machine, under the same OS user account, **your existing global CLAUDE.md (Code Quality/SOLID-DRY-KISS-YAGNI, Dead Code Removal, Test Coverage targets, DB-test-isolation rules) is very likely already being loaded into every headless Task this app runs today** — you may have already half-built the "common way" you're asking for, without the app doing anything extra for it.

This is worth verifying empirically before relying on it (the same spirit as this repo's own Phase 0 spike that verified pause/resume behavior against the real CLI rather than assuming it) — e.g. spawn a throwaway Task whose only instruction is "state whether you have been given any instructions about test coverage targets, and quote them," and check whether it echoes back your CLAUDE.md content. If confirmed, the design below treats your global CLAUDE.md as the **existing** foundation of the common layer, and focuses on what's genuinely still missing: making the common rules *enforced* rather than advisory, extending equivalent coverage to Codex/Gemini (which do **not** read `~/.claude/CLAUDE.md` at all — see Part 3), and adding a project-specific layer on top.

---

## 1. What "controlled" actually requires — the two failure modes to design against

Every mechanism below exists to defend against one of two documented failure modes:

1. **Advisory-only instructions get ignored or worked around under pressure.** Anthropic's own docs are explicit that CLAUDE.md is injected as a plain user message, not enforced config — "for hard requirements you need a hook instead." Separately, peer-reviewed research (arXiv, *ImpossibleBench*, 2510.20270) found LLM agents given read/write access to their own tests will edit or weaken them to force a pass, and that hiding or write-locking tests sharply reduces this. **Design consequence: anything that must never be skipped needs a deterministic, non-LLM-mediated gate (a hook, a required CI-style check), not just a strongly-worded instruction.**
2. **A model grading its own work is a weak signal.** The recurring, independently-sourced rule across Anthropic's own best-practices guide, industry blog posts (Codacy), and the TDD research above is: *the agent that wrote the code should not be the sole judge of whether it's correct.* **Design consequence: build in an independent verification step — a real test run, a separately-invoked reviewer, or both — before anything is treated as done.**

Everything in Parts 2-4 is one of: a durable-context mechanism (so the agent knows the right thing to do), a hard gate (so it can't skip the right thing even under pressure), or an independent check (so "the agent said it passed" is never the only signal).

---

## 2. Part A — The common flow (every project)

### A1. Layered, durable context — three tiers, not one file

Sourced principle: BMAD-METHOD's explicit design goal is to fight context drift by making decisions **durable artifacts** rather than re-explained chat history; Anthropic's own sizing guidance is to keep any single CLAUDE.md under ~200 lines since longer files "consume more context and reduce adherence." Combine both:

| Tier | Lives where | Scope | Who authors it |
|---|---|---|---|
| **House standards** | `~/.claude/CLAUDE.md` (already exists) | Every project, every executor (see Part 3 for the Codex/Gemini gap) | You, rarely edited |
| **Project conventions** | A new, per-managed-project `CLAUDE.md`, committed at the project's own repo root | This one project's stack, test/lint/build commands, non-obvious architecture decisions | Agent-authored, like the existing Blueprint (see A5) |
| **Task-scoped instructions** | The Template persona + Skills already composed into `--append-system-prompt` | This one Task's role (implementer, reviewer, test-writer) | The Catalog (already built) |

The middle tier is the concrete gap today: nothing in `projectService.ts`'s scaffold currently writes a `CLAUDE.md` into a managed Project (only `.docs/blueprint.md`, `.docs/plan/`, `.docs/milestones/`). Since a managed Project's working directory *is* its git root, a committed `CLAUDE.md` there is picked up automatically by Claude Code with zero extra plumbing — and because it's a git-tracked file, every worktree Task (a `git worktree add` checkout of the same repo) inherits it for free, with no per-worktree copying needed. This is the single highest-leverage, lowest-effort addition available.

### A2. Spec → Plan → Tasks → Implement → Converge

This app already implements most of the shape that GitHub's **Spec Kit** (`github/spec-kit`) and **BMAD-METHOD** independently converged on: a `'plan'`-kind Task restricted to editing plan docs (their `/speckit.specify`+`/speckit.plan`), a structured Tasks breakdown (`/speckit.tasks`), and `'execute'`-kind Tasks running one breakdown item (`/speckit.implement`). The one phase missing is Spec Kit's **`/speckit.converge`**: after implementation, re-validate the actual code against the Specifications/Requirements docs and loop back if they've drifted apart, rather than treating "the plan doc was written once" as sufficient. Concretely: a Task kind addition (or a distinctly-prompted `'plan'`-kind follow-up) that reads the diff plus the plan docs and reports whether they still agree — this is also your general-purpose fix for the "no automated consistency check between agent-authored docs and actual code state" gap already flagged in the earlier command-center analysis.

**Decision records.** Project creation no longer scaffolds `.docs/decision-logs/` and nothing populates or structures it. Adopt the standard ADR shape (Michael Nygard's original format, consolidated in `joelparkerhenderson/architecture-decision-record` and the MADR spec: title, status, context, decision, consequences) and have a `'plan'`-kind Task author one whenever it makes an irreversible or hard-to-reverse call — the same "agent-authored, numbered file" pattern Milestones already use (`milestone-1.md`, `milestone-2.md`, ...).

### A3. A real TDD gate, not a TDD instruction

Every sourced TDD pattern found (Anthropic's own best-practices doc, the `alexop.dev` and Nous Research Claude Code TDD skills, VS Code's agent TDD guide, Endor Labs' test-first-prompting research) converges on the same "iron law": **a failing test must be observed before any implementation, and the agent must show the red run, not just claim one.** Given failure mode #1 above (instructions get worked around), this needs a deterministic gate, not a persona instruction. A concrete, buildable version using mechanisms Claude Code already ships:

1. **`PostToolUse` hook** on Edit/Write: after any code change, run the project's registered test command (see A4) and write the result (pass/fail, which command, timestamp) to a small per-Task state file.
2. **`Stop` hook**: before letting a Task's turn end as `done`, check that state file. If the last recorded run isn't green — or no run was ever recorded — block completion (`Stop` hooks can force the agent to keep working; Anthropic's docs describe this exact "deterministic gate" pattern explicitly, capped at 8 consecutive forced continuations so it can't loop forever).
3. Optional, stronger version addressing the *ImpossibleBench* finding directly: a **`PreToolUse` hook** that denies Edit/Write on test files once a "first failing test observed" marker exists for the Task, so the implementer phase genuinely cannot weaken the test it's supposed to satisfy.

This closes the exact gap this app's own docs already admit: `server/README.md`'s "Known simplifications" section says approval-gated autonomy "doesn't truly pause" — a hook-based Stop gate is a different, achievable kind of control that doesn't depend on the permission-prompt/approval-mode mechanism at all, and per the user's own decision (see the companion command-center gap doc), approval-gated autonomy is being *removed* rather than fixed — this TDD gate is the actual replacement mechanism for "don't let it call something done that isn't."

### A4. Give the gate something generic to call — semantic roles on Project Commands

The TDD gate and the converge step both need to invoke "the project's test command" without hardcoding `npm test` vs `pytest` vs `go test`. `ProjectCommandRecord` already exists with a `highlighted` boolean (`commandService.ts`, capped at `MAX_HIGHLIGHTED_COMMANDS = 3`) — the natural, minimal extension is a small optional `role` field (`test` | `lint` | `build` | `typecheck`) alongside it, so any automation (the hook above, a future CI-style summary) can ask "does this Project have a registered test command" generically. This is also exactly the seam where Part B (project-specific stack) plugs into Part A (stack-agnostic gate logic): the common flow only ever needs to know a role exists, never the actual command.

### A5. Independent review — Writer/Reviewer, never self-graded

Anthropic's own best-practices guide documents a **Writer/Reviewer two-session pattern** explicitly: implement in one session, review in a *fresh* context with a second session so the reviewer "isn't biased toward code it just wrote" — with the caution that a reviewer prompted to find gaps will usually report some, so findings should be filtered to correctness/requirements-against-plan, not style nits. Concretely, buildable with what's already in the Catalog: add a **`reviewer` Template** (distinct persona: "you did not write this code; check it against `.docs/plan/` and the Task's own description for correctness gaps only") and chain a review Task automatically at the end of every `'execute'` Task, the same way a follow-up Task already resumes a session today — except this one runs as a *new*, independently-launched Task against the same diff/branch, not a resumed session, so it starts genuinely fresh.

For security specifically, Anthropic ships a real, dual-surface tool worth adopting directly rather than reinventing: `anthropics/claude-code-security-review`, usable as a local `/security-review` slash command or wired as a scheduled Project Command / CI-style check, checking for injection, auth flaws, and data exposure with built-in false-positive filtering.

### A6. Isolation and merge — already strong, needs a gate at the seam

Git-worktree-per-concurrent-Task is already implemented here and matches exactly what `claude-squad`, `Crystal`, and `Conductor` independently converged on as the correct isolation primitive (one worktree + branch per agent session, never a shared working directory). None of those three tools, notably, ship a built-in quality gate of their own — they solve isolation and queuing, and defer verification to whatever the repo's own CI/hooks provide. That's exactly the role Parts A3-A5 above are meant to fill for this app: since there's no hosted CI here, **the app itself needs to act as its own required-check enforcer** — refuse to offer a worktree branch for merge (once that UI exists, per the earlier gap doc) unless its last tracked test/lint Command Run was green and its review Task passed. That's a self-imposed equivalent of branch-protection required-status-checks, appropriate for a local, single-user tool with no GitHub Actions runner backing it.

---

## 3. Part B — The project-specific flow

The common flow above is deliberately stack-agnostic. The project-specific layer is what actually teaches an agent *this* project's shape. Three concrete pieces:

1. **Stack detection, once, at project creation.** The clone-bootstrap Task that already runs on `repositoryUrl`-based creation (`projectService.ts`'s `startCloneDocsBootstrap`) is the natural place to also detect and record: language/framework, package manager, test runner, lint/format tool, build tool, and any obviously non-default conventions (monorepo layout, unusual directory structure) — writing the result straight into the project-level `CLAUDE.md` proposed in A1, under Anthropic's own recommended categories (bash commands the agent can't guess, non-default style rules, testing instructions, env quirks). For a brand-new, empty Project there's nothing to detect yet — this becomes a "detect stack" action available once real code exists, run manually or from the first real Task.
2. **Stack-specific Skills, layered on top of the common ones.** This app already proves this pattern on itself: its own dev-tooling subagents/skills (`server-daemon-architect`+`agent-visual-os-domain`, `threejs-scene-artist`+`threejs-scene-conventions`, `ui-interaction-engineer`+`web-interaction-conventions`) are exactly "a persona plus a paired skill capturing this specific area's non-obvious conventions." The Catalog's existing `skillIds` mechanism (already validated, already folded into `--append-system-prompt` in skill-id order) is the same mechanism for managed Projects — a small library of stack-tagged Skills (`nextjs-conventions`, `python-pytest-conventions`, `go-conventions`, …), suggested (not force-applied) based on the detected stack from step 1.
3. **Project-specific "definition of done."** The glossary already defines a Milestone as having "its own definition of done" — extend that concept down to the per-Task level too: a library/package project's bar might be "green tests + updated docs," while a project with a deployed target might reasonably include the staging/production health checks proposed in the companion command-center analysis (docs/workflow-command-center-gaps.md, section H) as part of what "done" means for that specific project, not a universal requirement.

---

## 4. Part C — Cross-executor differences (Claude vs. Codex vs. Gemini)

You said Claude is primary; this section is what changes if/when Codex or Gemini run the same methodology as an alternate executor (this app already supports Codex; Gemini isn't wired up yet).

### C1. Comparison table

| Mechanism | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| Context file | `CLAUDE.md` — managed → user (`~/.claude/`) → project → `CLAUDE.local.md`; `@import` syntax, 4-hop recursion cap; Anthropic's own guidance: keep under ~200 lines/file | `AGENTS.md` — global (`~/.codex/`) → project (git-root down to cwd), `.override.md` variants win; **concatenated**, closer files appended later (so they "win" by being freshest context, not true override); **hard 32 KiB cap** (`project_doc_max_bytes`); no import syntax | `GEMINI.md` (configurable filename, can list multiple) — global → project (walk up to root) → **subdirectory, auto-scanned just-in-time as the agent visits that directory** (no Claude/Codex equivalent); `@file.md` imports, no stated depth cap |
| Permission/approval axis | Single mode enum: `default`/`acceptEdits`/`plan`/`auto`/`dontAsk`/`bypassPermissions` | Two independent axes: **sandbox scope** (`read-only`/`workspace-write`/`danger-full-access`) × **approval policy** (`on-request`/`never`); `on-request` **genuinely pauses and waits** at the sandbox boundary rather than denying outright | `--approval-mode`: `default`/`auto_edit`/`yolo`/`plan`, **plus a separate sandbox axis** (`GEMINI_SANDBOX=docker/podman/sandbox-exec`, tunable profiles); sandbox can still block even under `yolo` |
| Sandbox coverage | Seatbelt (macOS)/bubblewrap (Linux), but **only wraps the Bash tool** — Read/Edit/WebFetch/MCP are unsandboxed | Sandbox scope covers the whole tool-execution layer, not just shell | Full container (Docker/Podman) or Seatbelt around the whole tool layer, with named profiles (`permissive-open` … `strict-open/proxied`) |
| Subagents | `.claude/agents/*.md`, Markdown + YAML frontmatter | `.codex/agents/*.toml`, distinct schema; docs explicitly flag **higher token cost** for subagent workflows | `/agents`, TOML/Markdown files in an `agents/` folder |
| Skills | `SKILL.md`, progressive disclosure (description-only until invoked); `disable-model-invocation`, `context: fork` | `SKILL.md` — **format-compatible with Claude's**, directly portable | `SKILL.md`, `activate_skill` tool, `/skills reload` — also format-compatible |
| Hooks | Largest documented event surface (30+ events incl. `SubagentStop`, `PreCompact`, `PermissionRequest`, `FileChanged`, `WorktreeCreate`) | Near feature-parity event names (`PreToolUse`/`PostToolUse`/`Stop`/`SubagentStop`/etc.) — but **docs explicitly warn concurrent same-event hooks race with no ordering guarantee** | ~10 documented events, PascalCase (`BeforeTool`/`AfterTool`/etc.); `AfterTool` can **suppress** output from ever reaching the model — Claude's `PostToolUse` cannot retroactively hide output |
| Structured output | `--json-schema` on `--output-format json` — **post-hoc validation, not constrained decoding** | `--output-schema <file>` — first-class, schema-validated contract, historically stricter | JSON/JSONL output formats; no equivalent hard schema-validation flag found |
| Session resume | `--resume`/`--continue` by session ID, linear | `exec resume <id>` / `--last` | `--resume`, plus **named, forkable checkpoints** (`/resume save/resume`) — branch a conversation to a prior named point, no Claude/Codex equivalent |
| Pre-edit rollback | None built in — closest is manual git | None found | **Native**: shadow-git snapshot before every file-modifying call; `/restore <id>`, disabled by default |
| Cost/usage reporting | Token/session usage surfaced; no live authoritative $ in the CLI itself | `account/rateLimits/read` via `app-server` JSON-RPC (not a plain flag) — window %/reset time only, **no $ field** | `/stats` — tokens/quota only, **no $ field**; free-tier quota (1,000 req/day via Google login vs. 250/day API-key-only) is sharply different from Claude/Codex's model |

### C2. What this means for the methodology, concretely

- **The common-layer standards (Part A) should not depend on each tool's context-file discovery at all.** Since the daemon already composes the Worker's prompt itself (`--append-system-prompt` today for Claude), the simplest cross-executor path is to inject the house-standards content directly at spawn time for every executor (Codex's `developer_instructions`/AGENTS.md content, Gemini's system-prompt equivalent) rather than maintaining three separately-discovered global files that could drift from each other. Only the **project-specific** layer (Part B) genuinely benefits from living in each tool's native project-root file, since Claude/Codex/Gemini each already read their own convention from cwd for free — that part is inherently per-project content anyway.
- **The TDD Stop-gate (A3) needs per-executor validation before trusting it identically everywhere.** Codex's own docs disclaim ordering guarantees across concurrent same-event hooks — if a future lint-hook and test-hook both fire on the same event, don't assume the test hook runs second; consolidate into one hook per event on Codex rather than several independent ones. This hasn't been checked against Gemini's hook system at all yet (it's newer); treat it as unverified there too.
- **Approval-gated autonomy's "doesn't actually pause" problem is Claude-specific, not universal.** Codex's `on-request` approval policy is documented to genuinely pause and wait at the sandbox boundary. Since this app's own decision (see the companion gap-analysis doc) was to remove the approval-gated mode rather than fix it, this is purely a note for later: if a real pause-and-resume-on-approval flow is ever reconsidered, Codex may already support what Claude's Phase 0 spike found Claude does not.
- **File-write locking for the test-file-protection idea (A3, option 3) has no native primitive in any of the three** — it needs a `PreToolUse`/`BeforeTool` hook keyed on file path in every case, implemented three times with three different config formats if it's ever extended past Claude.
- **Rollback**: don't build anything Gemini-checkpoint-specific — this app's existing git-worktree-per-Task model is already the executor-agnostic equivalent (a worktree branch is exactly a checkpoint), so a future "revert a Task's changes" feature (already flagged as wanted in the companion gap doc) should be built on git, not on any one executor's native rollback feature.
- **Structured-output validation strictness differs** (Codex's `--output-schema` is a harder contract than Claude's `--json-schema`) — keep the daemon's own result-parsing defensive regardless of executor rather than assuming either tool's schema guarantee is airtight.
- **Nothing reports real dollar cost anywhere** — confirms the earlier gap-analysis decision to not chase $ cost tracking was reasonable given today's tooling; if ever revisited, it would need to be computed externally from token counts × known pricing for all three, not read from any CLI.

---

## 5. Prioritized, concrete next steps

Ranked by leverage — how much control this buys versus how much new machinery it needs, building only on mechanisms confirmed to exist above:

1. **Verify the Part 0 finding empirically** — confirm whether `~/.claude/CLAUDE.md` is really being loaded into headless Workers today. Cheap, and changes how much of "the common layer" is actually still to build.
2. **Scaffold a per-Project `CLAUDE.md`** alongside the existing `.docs/` files (A1) — the single highest-leverage, lowest-effort change; free for worktrees since it's a committed, tracked file.
3. **Add semantic roles to Project Commands** (`test`/`lint`/`build`/`typecheck`, A4) — the seam every other gate below depends on.
4. **Build the TDD Stop-hook gate for `'execute'` Tasks** (A3), Claude-only first, since its hook semantics are best-understood; validate before ever porting to Codex/Gemini.
5. **Use the same hook infrastructure to fix the `'plan'`-kind Task's known file-write-scope gap** — a path-glob-aware `PreToolUse` hook instead of the current instruction-only boundary (`server/README.md`'s own listed known simplification).
6. **Add a `reviewer` Catalog Template and an automatic fresh-context review Task** at the end of every `'execute'` Task chain (A5), findings filtered to correctness only.
7. **Adopt the ADR format for `.docs/decision-logs/`**, agent-authored the same way Milestones already are (A2).
8. **Add the Spec-Kit-style "converge" check** — a Task that re-validates code against plan docs after implementation (A2) — this is also your direct fix for doc/blueprint drift.
9. **Build stack detection into clone-bootstrap** and a manual "detect stack" action for blank projects (B1), to populate the project-level `CLAUDE.md` automatically.
10. Only once 4-6 are proven on Claude: **port the TDD/path-scoping hooks to Codex**, accounting for its no-ordering-guarantee caveat on concurrent hooks; revisit Gemini once/if it's actually wired up as an executor.
