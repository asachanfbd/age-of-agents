import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { agentSessionStateLabel } from '../../lib/agentSessions';
import { useWorldStore } from '../../store/worldStore';
import { TaskTerminal } from '../TaskTerminal';

/**
 * An Agent terminal session filling the popup body under the tab bar. Back returns to the tabs and leaves
 * the session running: the daemon keeps the terminal, and opening it again replays its output.
 */
export function AgentTerminalView({ projectId, sessionId, onBack }: { projectId: string; sessionId: string; onBack: () => void }) {
  const session = useWorldStore((s) => s.agentSessionsByProject[projectId]?.find((candidate) => candidate.id === sessionId));
  return (
    <div data-agent-terminal-view className="flex min-h-0 flex-1 flex-col" aria-label="Agent terminal">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2 sm:px-6">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}><ArrowLeft aria-hidden="true" /> Back to tabs</Button>
        <span className="truncate text-sm font-medium">{session?.name ?? 'Agent terminal'}</span>
        {session && <span className="text-xs text-muted-foreground">{agentSessionStateLabel(session)}</span>}
      </div>
      <TaskTerminal key={sessionId} taskId={sessionId} />
    </div>
  );
}
