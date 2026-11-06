/**
 * The storage policy for a Test Run's combined stdout/stderr, written to its own log file (see
 * runFiles.ts). Output is appended as it arrives until the log holds MAX_LOG_HEAD_CHARS; past that,
 * only a rolling tail of the last MAX_LOG_TAIL_CHARS is kept in memory and appended when the run
 * ends, behind a marker saying how much was left out. So a runaway command can't fill the disk,
 * and both the start (setup errors) and the end (the runner's summary and failures) survive.
 *
 * Live `testRunLog` WebSocket events still carry every chunk as it arrives.
 */

export const MAX_LOG_HEAD_CHARS = 5_000_000;
export const MAX_LOG_TAIL_CHARS = 200_000;

export interface LogBudget {
  /** Characters already appended to the log file. */
  written: number;
  /** Output past the head, newest last, at most MAX_LOG_TAIL_CHARS. */
  tail: string;
  /** Characters that fell out of the tail and won't be stored at all. */
  dropped: number;
}

export const EMPTY_LOG_BUDGET: LogBudget = { written: 0, tail: '', dropped: 0 };

/** Splits a chunk into what to append to the file now, and updates the in-memory tail with the rest. */
export function admitChunk(budget: LogBudget, chunk: string, maxHead = MAX_LOG_HEAD_CHARS, maxTail = MAX_LOG_TAIL_CHARS): { write: string; budget: LogBudget } {
  const write = chunk.slice(0, Math.max(0, maxHead - budget.written));
  const rest = chunk.slice(write.length);
  if (!rest) return { write, budget: { ...budget, written: budget.written + write.length } };
  const combined = budget.tail + rest;
  const tail = combined.slice(Math.max(0, combined.length - maxTail));
  return { write, budget: { written: budget.written + write.length, tail, dropped: budget.dropped + combined.length - tail.length } };
}

/** What to append when the run ends: the kept tail, behind a marker if anything in between was dropped. */
export function closingLog(budget: LogBudget): string {
  if (!budget.dropped) return budget.tail;
  return `\n[agent-visual-os: ${budget.dropped} characters of output omitted]\n${budget.tail}`;
}
