---
name: roadmap-runner
description: Works through docs/roadmap.md's pending tasks one at a time via sub-agents, checking each off and sending a WhatsApp progress update after every one. User-invoked only — run with /roadmap-runner.
disable-model-invocation: true
---

# Roadmap runner

Drains `docs/roadmap.md` top to bottom: one pending task per cycle, a sub-agent does the work, the task gets checked off, and a WhatsApp update goes out — then the next pending task starts automatically. Keep cycling until the file has no pending tasks left.

A **pending task** is a `- [ ] ...` line under any `###` section; a `*Notes: ...*` line is never a task. Read tasks in file order, top to bottom, across sections.

## Cycle

1. **Read** `docs/roadmap.md`. Find the first pending task, top to bottom. None left → send the all-done notification (step 5, with `all_done: true`) and stop.

2. **Dispatch.** Launch a sub-agent (Agent tool) scoped to that one task. Pick the available agent type whose scope best matches the task's area (e.g. one scoped to `server/`, `web/src/scene/`, or `web/src/ui/`); use `general-purpose` when nothing closer fits. Give it the task's exact text plus enough repo context to act without re-reading the roadmap itself.

3. **Wait.** Block on the sub-agent's actual completion result — never mark a task done or notify on an assumption that it's probably finished.

4. **Check it off.** Re-read `docs/roadmap.md` fresh (the sub-agent may have touched other files, and this keeps the edit anchored to current content). Edit that exact line's `- [ ]` to `- [x]`.

5. **Notify.** Recount from the just-edited file: `total` = every `- [ ]` + `- [x]` line, `pending` = remaining `- [ ]` lines. Send, via `./docs/notify.sh` (repo root; `chmod +x` first if it's not executable):

   ```
   ✅ *Completed*: <task just marked done>

   *Status*: <The Completion message, stating what was done or anything to note or flag.>
   
   *Working Now*: <next pending task, or "All done" when pending is 0>
   
   *Count: <pending>/<total>*
   ```

   `notify.sh` needs `docs/.env` (`SEND_HOST`, `SEND_API_KEY`, `SEND_TO`); if it exits non-zero, report the error inline and keep going — a failed notification never blocks the roadmap draining.

6. Pending is 0 → stop. Otherwise → cycle 2 with the next pending task.
