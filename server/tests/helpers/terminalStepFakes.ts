import type { TerminalSessionHost, TerminalSessionStart } from '../../src/terminal/terminalSessionManager.ts';
import type { createWorkerManager } from '../../src/worker/workerManager.ts';

/**
 * Every Task now runs via the interactive-CLI path (no more headless `claude -p`/`codex exec`
 * executor kind — see docs/architecture.md), so driving a WorkflowRun's steps in a test means
 * starting (fake) terminal sessions and simulating their outcome, rather than resolving a
 * structured turn's result. Used by workflowRunEngine.test.ts to script a WorkflowRun through
 * several steps.
 */

type WorkerManager = ReturnType<typeof createWorkerManager>;

/** A minimal fake TerminalSessionHost: `start` just records the call, and `stop` does nothing on
 * its own — the test (or `autoAdvanceTerminalSteps`, below) triggers `onExit` by hand, exactly like
 * the real PTY's exit event arriving asynchronously, well after a kill signal is sent. */
export function fakeTerminalHost(): { host: TerminalSessionHost; starts: TerminalSessionStart[]; stops: string[]; live: Set<string>; writes: { taskId: string; data: string }[] } {
  const starts: TerminalSessionStart[] = [];
  const stops: string[] = [];
  const writes: { taskId: string; data: string }[] = [];
  const live = new Set<string>();
  const host: TerminalSessionHost = {
    start(input) {
      live.add(input.taskId);
      starts.push({ ...input, onExit: (...args) => { live.delete(input.taskId); return input.onExit(...args); } });
    },
    attach: () => () => undefined,
    write(taskId, data) { writes.push({ taskId, data }); },
    resize() {},
    stop(taskId) { stops.push(taskId); return true; },
    has: (taskId) => live.has(taskId),
    isAttached: () => false,
    count: () => 0,
  };
  return { host, starts, stops, live, writes };
}

/**
 * A step's scripted action for `autoAdvanceTerminalSteps`: `taskId` is that step's own Task id. Most
 * actions just call `complete_step`/`skip_step` (via the manager's own `completeStep`/`skipStep`),
 * exactly as a live step session's MCP tool call would — and since that call ends its own session
 * automatically (see workerManager.ts's `completeStep`/`skipStep`/`endStepSession`), the harness
 * observes that through the host's own `stop` (below) without the action doing anything else. Call
 * the given `exit` callback instead of / as well as that when a test deliberately wants this
 * attempt's session to end WITHOUT ever calling complete_step/skip_step (the "ended without
 * completing" safety-net scenario).
 */
export type StepAction = (taskId: string, exit: () => void) => unknown;

/**
 * A TerminalSessionHost that, whenever a WorkflowRun step's interactive-CLI session starts, looks up
 * which step it belongs to (via the manager referenced by `managerRef`, set by the caller right
 * after construction — see the chicken-and-egg problem this solves in workflowRunEngine.test.ts) and
 * runs the scripted action for that step's id. A step with no scripted entry is left running
 * indefinitely, exactly like a real step Task waiting on a still-thinking model — this is what a
 * test asserting "the run does NOT advance" relies on. `stop` (called by `completeStep`/`skipStep`'s
 * own `endStepSession`, or by an explicit `stopWorkflowRun`/`stopTask`) ends that same session,
 * mirroring the daemon closing a step's session right after it reports its outcome.
 */
export function autoAdvanceTerminalSteps(
  managerRef: { current?: WorkerManager },
  actionsByStepId: Record<string, StepAction>,
): { host: TerminalSessionHost; starts: TerminalSessionStart[] } {
  const starts: TerminalSessionStart[] = [];
  const host: TerminalSessionHost = {
    start(input) {
      starts.push(input);
      void (async () => {
        const task = await managerRef.current!.getTask(input.taskId).catch(() => null);
        const action = task?.workflowStepId ? actionsByStepId[task.workflowStepId] : undefined;
        if (!action) return; // no scripted action — the session stays open, like a still-running step
        await action(input.taskId, () => input.onExit(0, undefined, input.sessionId ?? undefined));
      })();
    },
    attach: () => () => undefined,
    write() {},
    resize() {},
    stop(taskId) {
      const start = [...starts].reverse().find((s) => s.taskId === taskId);
      if (start) start.onExit(0, undefined, start.sessionId ?? undefined);
      return true;
    },
    has: () => true,
    isAttached: () => false,
    count: () => 0,
  };
  return { host, starts };
}
