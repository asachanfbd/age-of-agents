# Context Village integration contract

This is a proposed runner contract, not a claim that Context Village already implements
these fields or hooks. Keep orchestration state outside `.docs`. The skill itself does
not install hooks, provide filesystem isolation, or guarantee instruction compliance.

## Launch

Configure a Context Village agent named **Project Context Steward**, using the portable
agent prompt supplied with this deliverable. Make this SKILL.md and its references
readable to the selected Claude Code/Codex worker; have the launch prompt explicitly
name their paths. Do not rely on a skill installed in ChatGPT appearing in another CLI.
Native CLI registration is optional and requires checking that runner's actual version.

Use the selected child project's root as cwd. Supply the exact target worktree/snapshot,
applicable instructions and a task-scoped evidence packet. Do not automatically feed
the whole project history or all `.docs` files into every coding task.

## Input shape (runner maps its own fields)

```json
{
  "mode": "retro",
  "project_root": "/absolute/path/to/project-worktree",
  "task_id": "task-123",
  "base_revision": "actual-base-commit",
  "target_revision": "actual-target-commit",
  "target_state": "accepted",
  "task_brief": "path-or-injected-content",
  "acceptance_criteria": [],
  "accepted_decisions": [],
  "evidence": {"trace": [], "diff": [], "test_results": [], "user_corrections": []},
  "delegation": {"doc_edits": true, "test_control_edits": false, "commit": false},
  "run_key": "runner-generated-idempotency-key"
}
```

For bootstrap/migrate/audit, task ID and retro evidence are optional. Git revisions
can be null for an empty repository; use a runner-generated snapshot identity. Require
an explicit snapshot of uncommitted changes when they matter, not just HEAD. Never
use the literal sample revision strings as actual evidence.

## Output shape

Return a structured receipt to Context Village (or as the response when no API exists):

```json
{
  "status": "updated|no_change|needs_input|blocked",
  "mode": "retro",
  "target_revision": "actual-target-commit",
  "changed_files": [],
  "lessons": [{"scope": "", "rule": "", "evidence": [], "destination": ""}],
  "verification": {
    "documentation": "passed|failed|blocked|not_run",
    "application": "passed|failed|blocked|not_run",
    "checks": []
  },
  "follow_up_controls": [],
  "questions": [],
  "limitations": []
}
```

The pipe-separated strings describe allowed values; emit one actual value. Each check
records command, cwd, revision/snapshot, exit status, outcome and relevant test counts
or environment limitations. Each follow-up includes cause, expected behavior, scope,
recommended control and whether it was implemented. Keep evidence identifiers and
reasoning in this receipt, not a task log in `.docs`.

## Runner responsibilities

1. On project creation/import, call bootstrap/migrate before normal task execution.
2. At task launch, load root/scoped instructions, index and constraints; route to relevant
   topic docs and inject the specific task's acceptance criteria and accepted decisions.
3. Require the coding agent to write/run appropriate tests and return real evidence.
   Completion and verification are distinct states. Manual completion starts the retro
   but must not erase failed/blocked verification.
4. On completion, enqueue a retro with immutable evidence. Persist an idempotency key
   combining project, task completion version, target snapshot and steward version.
   Duplicate events return the existing receipt. Revised evidence gets a new version.
5. Serialize documentation publication per project; different projects may run separately.
   Use isolated worktrees or an equivalent snapshot mechanism and compare expected
   revision plus content state before applying. Discard/recompute stale patches.
6. If newer work has landed, reconcile the retro against current accepted state. Preserve
   still-valid lessons but do not restore outdated implementation facts. Record both
   evidence revision and publication revision in the external receipt.
7. Validate and publish authorized doc-only patches atomically where tooling supports it.
   On failure, preserve last good docs and return blocked; never reset unrelated changes.
   Do not mark a processed event successful before its patch and receipt are durable.
8. Mark steward-origin maintenance in external job metadata and suppress recursive retro
   triggers. Unresolved test/code changes become coding tasks, not silent doc changes.
9. Surface only material questions; persist receipts/results in Context Village's existing
   task/test stores. Recheck accepted behavior after any corrective coding task.

Do not add a second issue tracker, require a PR for every local task, or mandate a human
review for routine documentation. Honor the project's actual branch/integration policy.
A doc patch may be drafted during coding; no blanket ban is needed. The retro reconciles
it with accepted results. The accepted revision's code and documentation should agree.
