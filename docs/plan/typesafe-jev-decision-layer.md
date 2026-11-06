# Plan: TypeSafe/Jev Decision Layer

**Status: Plan.** This document is a proposal, not a build spec — nothing described here exists yet. Treat every detail as a draft open to revision when implementation actually starts. Not yet promoted to a numbered milestone under `docs/milestones/` — this is a cross-cutting layer touched from several existing systems (Worker, Catalog, Executors) rather than one new user-facing feature, so it's tracked here instead.

## Why

The daemon currently makes a handful of decisions with fixed, hand-coded logic where a cheap, fast classifier would do better:

- Whether a settled Task's diff actually warrants running the `documentation-n-retro-agent` Catalog agent, vs. skipping it for a trivial change.
- Which Catalog agent (Template) should execute a Task when the caller doesn't pick one explicitly.
- Which Catalog Skills are actually relevant to a Task's description, so the Worker's system prompt isn't bloated with irrelevant skill bodies.
- Which model tier (e.g. Opus vs. Haiku for `claude`, and the Codex equivalent) a Task's complexity actually justifies.

[TypeSafe AI's Jev](https://typesafe.ai/) ("System One" model, `docs.typesafe.ai`) fits this shape well: it isn't a chat/reasoning model, it's a fast, cheap, typed-decision API. You send a `state` blob plus one or more **questions** to `POST /v1/systemone` and get back typed, calibrated answers in one round trip:

- **Choice** — pick one of up to 255 labeled options, with a probability per option.
- **Score** — rate against an ordered rubric (2–10 levels).
- **Noul** — yes/no, returned as the probability of "yes."

Independent questions over the same state can be batched into a single request (they run in parallel and can't see each other's answers), which matters for the skill-preloading case below.

## Scope for this plan (v1)

**In scope:**
- A small, isolated decision layer (`server/src/decisions/`) that wraps the Jev HTTP API and exposes one named function per decision.
- Wiring that layer into the four decision points above.
- Fail-open behavior everywhere: a missing API key, a request error, or a low-confidence answer always falls back to today's fixed behavior. This is a resilience/cost optimization, not a dependency the daemon's core task lifecycle can be blocked by.

**Deliberately deferred:**
- Any decision point not listed above (e.g. autonomy-level selection, notification severity) — add only after the four here are validated in practice.
- Fine-tuning confidence thresholds ahead of real usage data — ship with a conservative default (documented per decision below) and revisit once there's real task history to evaluate against.
- The model-tiering decision's actual effect (see "Prerequisite" under Decision 4) — this plan only adds the plumbing Jev's `Choice` answer would drive.

## Architecture (sketch — needs a real pass before build)

- **`server/src/decisions/jevClient.ts`** — thin `fetch` wrapper around `POST https://api.typesafe.ai/v1/systemone`. Reads `JEV_API_KEY` from env; if unset, every exported decision function short-circuits to its fallback without making a network call. Handles the documented error statuses (`401`, `422`, `429`, `529`) by treating them as "no answer" rather than throwing into the caller's task lifecycle.
- **`server/src/decisions/taskDecisions.ts`** — one function per decision (see below), each responsible only for building `state`/`questions` and interpreting the typed answer against its threshold. No decision function ever throws; each returns its fallback value on any failure or low-confidence result.
- **Config**: `JEV_API_KEY` alongside the daemon's existing env-based config (see `server/src/config.ts`). No key configured is a fully supported, silent "feature off" state — every call site behaves exactly as it does today.
- Follows the existing `catalog/`, `executors/`, `worker/` module boundaries — this is a new sibling module those three call into, not a change to their own responsibilities.

## Decision points

### 1. Docs-n-retro run/skip gate
- **Type:** Noul.
- **State:** the settled Task's description + a diff/change summary.
- **Question:** "Does this change warrant a documentation-and-retro pass?"
- **Wired at:** `settleDone` in `server/src/worker/workerManager.ts` (around line 777), before any auto-follow-up Task referencing the `documentation-n-retro-agent` Catalog agent (`catalog/agents/documentation-n-retro-agent.md`) would be created.
- **Fallback:** run it — i.e. false negatives (skipping when it should run) are worse than the occasional unnecessary pass.
- **Prerequisite:** none — this is the only decision that needs no other groundwork, and should be built first.

### 2. Agent (Template) selection
- **Type:** Choice.
- **State:** the Task's description.
- **Criteria:** the enabled Catalog agents in `catalog/catalog-index.json`, each described by its persona (`catalog/agents/*.md`).
- **Wired at:** `startTask` in `server/src/worker/workerManager.ts` (around line 149), only when the caller doesn't pass an explicit `templateId` — replaces (or augments, behind a threshold) the current `getDefaultAgent()` fallback in `server/src/catalog/catalogService.ts`.
- **Fallback:** `getDefaultAgent()`, exactly as today.

### 3. Skill preloading
- **Type:** batch of Noul questions, one per candidate Skill, all in a single request.
- **State:** the Task's description.
- **Criteria:** each enabled Catalog Skill in `catalog/skills/`, described by its own summary.
- **Wired at:** before `buildAppendSystemPrompt` (`server/src/worker/workerManager.ts` around line 1136) — proposes a `skillIds` list when the caller didn't already pass one explicitly.
- **Fallback:** no skills preloaded (today's behavior when `skillIds` is omitted).

### 4. Model tier selection
- **Type:** Choice (e.g. `"fast" | "capable"`, mapped per executor kind to an actual model name).
- **State:** the Task's description and Template.
- **Prerequisite (blocking):** `ExecutorProfile` (`server/src/domain/types.ts`) and `runClaudeTurn`/`runCodexTurn` (`server/src/worker/claudeProcess.ts`, `server/src/worker/codexProcess.ts`) currently have **no model field or flag at all** — the CLI just uses its own configured default. This decision cannot do anything useful until a `model` field exists on the executor/task path and is actually passed through to the `claude`/`codex` invocation. That plumbing is plain engineering work, independent of Jev, and should land first.
- **Fallback:** whatever the executor's current default model is (unchanged).

## Draft task breakdown

(Sizing only, not a final breakdown — becomes real Tasks-breakdown items once this plan is picked up.)

1. `server/src/decisions/jevClient.ts` — API wrapper, env-gated, typed request/response, error handling per the documented status codes.
2. `server/src/decisions/taskDecisions.ts` — `shouldRunDocsRetro`, unit-tested with a mocked client (never calling the real API in tests, per this repo's test-isolation conventions).
3. Wire decision 1 (docs-n-retro gate) into `workerManager.ts`'s `settleDone`. Ship and observe before continuing.
4. `selectAgent` (decision 2) + wiring into `startTask`.
5. `selectRelevantSkills` (decision 3) + wiring into `buildAppendSystemPrompt`.
6. Executor/task `model` field plumbing (decision 4's prerequisite) — independent of Jev, can happen in parallel with 3–5.
7. `selectModelTier` (decision 4) + wiring, once 6 lands.

## Open questions / risks

- **API key and billing** is an account-level decision for Abhishek to make before step 1 starts — not something to default silently.
- **Confidence thresholds** are guessed, not derived — each decision's fallback-on-low-confidence behavior needs real task data to tune, not a one-time default.
- **New external runtime dependency** on the daemon's task lifecycle (steps 3–5 sit inline in `startTask`/`settleDone`). The fail-open design above is meant to fully neutralize this, but it needs a test that actually simulates the API being down/slow, not just a mocked happy path.
- **Latency budget** is unverified — Jev's marketed latency is very low, but this hasn't been measured against this daemon's own request patterns (e.g. sub-100ms is very different from sub-second at Task-start time, which is on the user-visible "click Start Task" path).
- **Decision 4 has a hard prerequisite** (see above) that is real engineering work unrelated to Jev — don't schedule it expecting Jev to be the bottleneck.
