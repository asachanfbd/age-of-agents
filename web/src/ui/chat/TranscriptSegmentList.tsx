import type { TaskTurn } from '../../lib/serverApi';
import type { TranscriptSegment } from '../../lib/taskTranscript';
import { MarkdownDocument } from '../MarkdownDocument';
import { ChatBubble } from './ChatBubble';
import { ClampedUserContent } from './ClampedUserContent';
import { ToolActivityCard } from './ToolActivityCard';

/** Human-readable label for each transcript role — 'raw-event' turns are summarized separately, not rendered as bubbles. */
const CHAT_LABEL: Record<Exclude<TaskTurn['role'], 'raw-event'>, string> = {
  prompt: 'You',
  answer: 'You',
  result: 'Worker',
};

/**
 * Renders one Task's transcript segments (from `groupTranscriptSegments`) as the shared chat
 * thread: a labeled `ChatBubble` per chat turn and an interleaved `ToolActivityCard` per run of
 * tool activity, in original chronological order. The one rendering path for both
 * `PastSessionTurns` (earlier linked Tasks) and `TaskDetailsView` (the current one), so a
 * follow-up chain reads as one uninterrupted conversation instead of switching rendering rules
 * partway through. `keyPrefix` namespaces React keys across multiple Tasks rendered side by side
 * (the whole chain).
 *
 * An 'agent-message' shares the 'result' bubble's visual style (same speaker) but is labeled "Agent"
 * rather than "Worker" and deliberately does *not* reuse CHAT_LABEL.result — it's mid-run narration,
 * not the Task's actual outcome, and more tool activity/messages can legitimately follow it before
 * the one true "Worker" bubble (the Task's real, final result) arrives. Without this distinction the
 * two looked identical and read as if the agent kept working after declaring itself done.
 */
export function TranscriptSegmentList({ segments, keyPrefix }: { segments: TranscriptSegment[]; keyPrefix: string }) {
  return <>{segments.map((segment, i) => {
    if (segment.kind === 'tool-run') return <ToolActivityCard key={`${keyPrefix}-${i}`} events={segment.turns} />;
    const isAgentMessage = segment.kind === 'agent-message';
    const role = isAgentMessage ? 'result' : segment.turn.role;
    const content = isAgentMessage ? segment.text : segment.turn.content;
    const author = isAgentMessage ? 'Agent' : CHAT_LABEL[role];
    return (
      <ChatBubble key={`${keyPrefix}-${i}`} role={role === 'result' ? 'agent' : 'user'} author={author} at={segment.turn.at}>
        {role === 'result' ? <MarkdownDocument content={content} /> : <ClampedUserContent content={content} />}
      </ChatBubble>
    );
  })}</>;
}
