# Risks and open questions

Source of truth: [`docs/spec.md`](spec.md), "Known risks" and "Left open for build time."

## Known risks

### Subscription login vs. API-key billing

Running a programmatic orchestration tool against a Claude Code subscription login, rather than a separate API key, is a plausible gray area under Anthropic's own stated terms: subscription login is documented as reserved for ordinary individual use, while API-key billing is described as the expected path for developers building products or services on top of Claude. agent-visual-os deliberately chose the subscription/CLI path anyway — see [`docs/architecture.md`](architecture.md#cli-subprocess-orchestration-not-the-agent-sdk) for why.

**Current read:** fine for personal, single-user use as currently scoped. **Worth rechecking** if the tool's use ever expands beyond that — e.g. sharing it with someone else, running it on someone else's behalf, or productizing it.

### The spike is one data point on one build

The Phase 0 spike confirmed the pause-and-resume mechanism works, but only against this account's CLI build (v2.1.269) at the time, which is a customized build with several tools (background session management, cron, remote triggers) not part of the plain open-source Claude Code CLI. Anthropic could change headless-mode behavior, the availability of `AskUserQuestion`, or `--json-schema` handling in a future version.

**Action:** re-run the same spike after any CLI upgrade, before assuming the mechanism still holds. Full spike log: [`docs/research/real-agent-orchestration-options.md`](research/real-agent-orchestration-options.md).

## Left open for build time

These were deliberately not resolved during scoping and need a decision when the relevant part of the build starts:

- **The tool's final location on disk.** (Resolved for now: this repository.)
- **The exact sections of the blueprint template** written by a Worker into `.docs/blueprint.md`.
- **How buildings are laid out or rearranged** in the scene.
- **What a crashed or errored Worker looks like visually** — no visual treatment decided yet for a failed process.
- **Whether the catalog's metadata index (`catalog/index.json`) is JSON, YAML, or something else.**

## A related, not-yet-investigated opportunity

Not a risk, but adjacent: native CLI background-session commands (`claude agents --json`, `claude logs <id>`, `--bg`, `-w`/`--worktree`) surfaced during the spike but weren't exercised deeply. Whether they can replace hand-built parts of `server/` is unresolved and should be investigated before Phase 1 — see [`docs/architecture.md`](architecture.md#a-finding-that-may-reduce-how-much-of-this-needs-to-be-hand-built) and [`docs/roadmap.md`](roadmap.md#phase-1--mvp-not-started).
