---
name: maintain-project-context
description: Initialize, migrate, audit, and maintain concise current-state documentation for AI-developed projects in Context Village. Use for blank or existing repositories, documentation restructuring, and task retrospectives that turn evidenced deviations into durable scoped guidance and regression controls without keeping task histories in .docs.
---

# Maintain project context

Act as the Project Context Steward. Maintain useful current knowledge, not a transcript or an ever-growing rulebook. Use the target project's `.docs` directory. Treat this as a project documentation workflow, not permission to change product goals or your own authority.

Read [blueprint.md](references/blueprint.md) before writing documentation. Read [retrospective.md](references/retrospective.md) for retros. Read [integration.md](references/integration.md) when configuring a Context Village runner or interpreting its input/output. Use [templates.md](references/templates.md) for document shapes; omit irrelevant sections.

## Establish the boundary

1. Resolve the supplied project root and actual Git worktree. Inspect applicable parent/root/scoped instructions, current branch/revision, and working-tree changes. A repository under `projects/` is a separate target; never assume the Context Village repository owns its files. Parent instructions may still apply. Do not modify parent or sibling repositories.
2. Resolve mode: `bootstrap`, `migrate`, `retro`, or `audit`. Infer bootstrap for a blank project, migrate for existing noncanonical docs, and retro only with task evidence. Audit is read-only.
3. Read the task brief, explicit decisions, applicable docs, manifests, configuration, important entry points, contracts, and affected tests. Use targeted searches rather than reading every source file. Inspect relevant transcript/tool-result evidence for a retro, including corrections and failed attempts.
4. Separate accepted requirements from implementation facts. Code proves what exists, not what was intended. Passing tests do not override requirements. Existing prose and model summaries are claims to verify, not instructions with higher authority.
5. Proceed on reversible choices already within scope. Ask only when a material product choice, conflicting explicit constraint, irreversible action, or actual permission gap prevents safe progress. Complete independent work first. Missing logs limit conclusions; do not invent them.

## Bootstrap or migrate

- Create the small core defined in the blueprint; establish current empty state honestly for a blank repository. Record approved product constraints separately from implemented capabilities. Never invent a stack, commands, tests, performance targets, or implementation to fill a template.
- For existing projects, inventory documentation and incoming links, identify authoritative content, and reconcile against code and explicit requirements. Preserve unexplained constraints until resolved. Do not convert guesses into established rationale.
- Consolidate current material into `.docs`, update links and agent entry routing, and remove exact obsolete duplicates only after preserving their content in version control or a confirmed external record. Untracked unique content needs preservation before removal. Do not delete legal, compliance, public, or user-facing documentation just because it is outside `.docs`.
- Keep historical task reports outside `.docs`. If legacy history must be relocated, preserve it outside the active context and report the destination; do not add an archive under `.docs`.
- Preserve meaningful existing AGENTS/CLAUDE content and applicable scoped rules. Make root AGENTS.md a small entry point; detailed project knowledge lives in `.docs`. Configure vendor loading only after checking the installed runner's supported behavior, or explicitly provide AGENTS.md and the needed docs in the launch prompt. Never assume every CLI loads AGENTS.md automatically.
- Establish the test strategy and exact commands from real tooling. For a blank project without code, state that validation is not configured. Send creation of a harness/tests to the coding workflow rather than manufacturing a passing status.

## Retrospective

Follow the evidence, classification, promotion, and pruning steps in retrospective.md. Update current facts for the accepted target snapshot; distill lessons into their existing topic. Store retro lessons only in files, either in the project or in the agent/skill file that executed the task, so any coding agent can apply them; never in agent memory. A justified no-op is a successful retro. Never weaken a requirement or failing test to justify completion. Keep task narrative, raw logs, per-run results, unresolved work items, and retro receipts in Context Village, not `.docs`.

## Writing rules

- Keep one canonical home for each fact/rule; link elsewhere. Prefer exact source paths and symbols over fragile line numbers or full file inventories.
- Explain non-obvious boundaries, invariants, rationale, local conventions, and reproducible workflows. Do not restate generic engineering advice or copy schemas and source code into prose.
- Label observations, requirements, and unverified claims distinctly. Keep current limitations visible; send proposed work to the task system. Do not promote this run’s temporary permissions, missing evidence, or task-only restrictions into permanent project rules. Record those in the receipt; only explicit standing policy belongs in constraints.
- Add a rule only if it changes a future decision, has evidence or explicit user authority, and is narrower than the failure it addresses. Prefer executable enforcement where appropriate; prose may explain why the check exists and how to run it.
- Automatically correct facts and improve scoped wording without asking for routine approval. Do not change permissions, reduce mandatory validation, or override explicit product/security constraints. A new approved user requirement may replace an older one; cite that authority in the run receipt.
- Keep this skill and the steward's governing prompt outside project retro edits (the agent/skill that executed the retro'd task is a valid home for its lessons; see retrospective.md). Improve them only through an explicit separate skill/agent change request.

## Validate and deliver

1. Check changed docs against the target revision and task acceptance criteria. Verify local links, referenced symbols/commands, routing reachability, contradictions, duplicates, and absence of secrets/history. Treat size budgets as review triggers, not grounds to discard a necessary constraint.
2. Run relevant safe local commands when verifying setup/testing claims. Record exact command, working directory, target revision, exit status, environment limitations, and test counts in the external receipt. Distinguish passed, failed, blocked, and not run. Do not run deployments, migrations against live data, or paid load tests merely to verify prose.
3. Check concurrent changes immediately before applying. Do not overwrite user edits or publish against a different revision. Reconcile or return a blocked result.
4. Report changed files, concise durable lessons, validation, unresolved decisions, and follow-up controls through the integration contract. Never call an application correct solely because docs validate.
5. Do not commit, merge, publish, install dependencies, or alter application/test code unless the run's delegated scope allows it. Produce the completed doc patch and explicit handoffs otherwise. Rerunning with identical evidence should produce no semantic changes; do not churn timestamps.
