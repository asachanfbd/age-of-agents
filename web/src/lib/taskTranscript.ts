import { agentMessageText } from './agentActivity';
import type { TaskTurn } from './serverApi';

/** A transcript turn that renders as a chat bubble (everything except `raw-event`). */
export type ChatTurn = TaskTurn & { role: Exclude<TaskTurn['role'], 'raw-event'> };

/**
 * One renderable piece of a Task's transcript, in original chronological order: a chat-bubble turn,
 * a run of one-or-more *consecutive* `raw-event` turns (tool calls/status events) collapsed into one
 * group, or a single `raw-event` turn that is purely an agent message (see `agentMessageText`) shown
 * as its own bubble. Used by `TaskDetailsView` (docs/roadmap.md's "Chat Interface & Task Panel
 * Enhancements") so tool activity renders in its real position between chat turns, and — so a
 * running agent's messages read like a conversation — an agent message breaks up a tool-run instead
 * of being buried behind "Show activity" along with everything else.
 */
export type TranscriptSegment =
  | { kind: 'bubble'; turn: ChatTurn }
  | { kind: 'agent-message'; turn: TaskTurn; text: string }
  | { kind: 'tool-run'; turns: TaskTurn[] };

/**
 * Walks `turns` once, in order, grouping each run of consecutive `raw-event` turns into a single
 * `tool-run` segment, except a `raw-event` that is purely an agent message (no tool activity mixed
 * in), which becomes its own `agent-message` segment and breaks the run. Never produces an empty
 * `tool-run` — a run only exists where at least one non-message `raw-event` turn does.
 */
export function groupTranscriptSegments(turns: TaskTurn[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const turn of turns) {
    if (turn.role === 'raw-event') {
      const text = agentMessageText(turn.content);
      if (text) { segments.push({ kind: 'agent-message', turn, text }); continue; }
      const last = segments[segments.length - 1];
      if (last?.kind === 'tool-run') last.turns.push(turn);
      else segments.push({ kind: 'tool-run', turns: [turn] });
    } else {
      segments.push({ kind: 'bubble', turn: turn as ChatTurn });
    }
  }
  return segments;
}
