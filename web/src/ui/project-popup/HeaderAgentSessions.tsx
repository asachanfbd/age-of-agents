import { useEffect, useState } from 'react';
import { Bot, ChevronDown, Pencil, Plus, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AGENT_MENU_VISIBLE_ROWS, agentMenuItems, agentSessionStateLabel } from '../../lib/agentSessions';
import type { AgentSession } from '../../lib/agentSessions';
import { useWorldStore } from '../../store/worldStore';
import type { ProjectData } from '../../types';
import { RunningDot } from './commands/RunningDot';
import { RenameAgentSessionDialog, StartAgentSessionDialog } from './AgentSessionDialogs';
import { ConfirmDialog } from './TaskDialogs';

type Dialog = { kind: 'start' } | { kind: 'rename' | 'delete'; session: AgentSession } | null;

/**
 * The header's "Agent" dropdown, right after the Commands controls: the Project's interactive coding-agent
 * terminals. "Start new" is the first, deliberately low-key item. Choosing a session reopens its conversation
 * if it ended and hands its id to `onOpen`, which shows the terminal over the popup body; each row can also
 * be renamed, ended or deleted.
 */
export function HeaderAgentSessions({ project, onOpen, onDeleted }: { project: ProjectData; onOpen: (sessionId: string) => void; onDeleted: (sessionId: string) => void }) {
  const sessions = useWorldStore((s) => s.agentSessionsByProject[project.id]);
  const loadAgentSessions = useWorldStore((s) => s.loadAgentSessions);
  const resumeAgentSession = useWorldStore((s) => s.resumeAgentSession);
  const endAgentSession = useWorldStore((s) => s.endAgentSession);
  const deleteAgentSession = useWorldStore((s) => s.deleteAgentSession);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void loadAgentSessions(project.id); }, [project.id, loadAgentSessions]);

  const items = agentMenuItems(sessions ?? []);
  const rows = items.filter((item) => item.kind === 'session');

  async function open(session: AgentSession) {
    setError(null);
    if (session.state === 'running') { onOpen(session.id); return; }
    const result = await resumeAgentSession(session);
    if (result.ok) onOpen(session.id);
    else setError(result.error);
  }

  async function end(session: AgentSession) {
    setError(null);
    const result = await endAgentSession(session);
    if (!result.ok) setError(result.error);
  }

  async function remove(session: AgentSession) {
    setDialog(null);
    if (await deleteAgentSession(session)) onDeleted(session.id);
    else setError('The session could not be deleted.');
  }

  const openDialog = (next: Dialog) => { setMenuOpen(false); setDialog(next); };

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="px-2" aria-label="Agent terminals" title="Agent terminals">
            <Bot aria-hidden="true" />
            <span className="hidden sm:inline">Agent</span>
            <ChevronDown className="!size-3.5 text-muted-foreground" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem className="py-1 text-xs text-muted-foreground" onSelect={() => openDialog({ kind: 'start' })}>
            <Plus className="!size-3.5" aria-hidden="true" /> Start new
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {rows.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No agent terminals yet.</p>}
          <div role="group" aria-label="Agent terminal sessions" data-session-list className={rows.length > AGENT_MENU_VISIBLE_ROWS ? 'max-h-72 overflow-y-auto' : undefined}>
            {rows.map(({ session }) => (
              <div key={session.id} className="flex items-center gap-1">
                <DropdownMenuItem className="min-w-0 flex-1" onSelect={() => void open(session)}>
                  <span className="truncate">{session.name}</span>
                  {session.state === 'running'
                    ? <RunningDot label={agentSessionStateLabel(session)} />
                    : <span className="ml-auto text-xs text-muted-foreground">{agentSessionStateLabel(session)}</span>}
                </DropdownMenuItem>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Rename ${session.name}`} title="Rename" onClick={() => openDialog({ kind: 'rename', session })}><Pencil aria-hidden="true" /></Button>
                {session.state === 'running' && (
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`End ${session.name}`} title="End session" onClick={() => void end(session)}><Square aria-hidden="true" /></Button>
                )}
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete ${session.name}`} title="Delete" onClick={() => openDialog({ kind: 'delete', session })}><Trash2 aria-hidden="true" /></Button>
              </div>
            ))}
          </div>
          {error && <p role="alert" className="px-2 py-1.5 text-xs text-destructive">{error}</p>}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog?.kind === 'start' && (
        <StartAgentSessionDialog projectId={project.id} onCancel={() => setDialog(null)} onStarted={(session) => { setDialog(null); onOpen(session.id); }} />
      )}
      {dialog?.kind === 'rename' && <RenameAgentSessionDialog session={dialog.session} onDone={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete "${dialog.session.name}"?`}
          description={dialog.session.state === 'running' ? 'The running terminal is stopped and the session is removed from the list.' : 'The session is removed from the list.'}
          confirmLabel="Delete"
          onCancel={() => setDialog(null)}
          onConfirm={() => { void remove(dialog.session); }}
        />
      )}
    </>
  );
}
