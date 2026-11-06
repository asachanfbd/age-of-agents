import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { clearPlanAndBugsDraft, readPlanAndBugsDraft, savePlanAndBugsDraft } from '../../lib/planAndBugsDraft';
import { reportDialogState } from '../../lib/bugs';
import { useWorldStore } from '../../store/worldStore';
import { CodingAgentPicker } from '../CodingAgentPicker';
import { useExecutorChoice } from '../useExecutorChoice';
import type { ProjectData } from '../../types';
import { PromptBar } from './PromptBar';

/**
 * The Planning column's Plan & bugs dialog starts a session from the person's first description of
 * what they want. With a coding agent available, sending starts its CLI at once. With none, the
 * description can still be written and the session created: it then waits, with no CLI, until an
 * agent is picked on the session's own screen.
 */
export function PlanAndBugsPrompt({ project, onSessionStarted }: { project: ProjectData; onSessionStarted: (taskId: string) => void }) {
  const startPlanAndBugsSession = useWorldStore((s) => s.startPlanAndBugsSession);
  const [message, setMessage] = useState(() => readPlanAndBugsDraft(project.id));

  // Every configured executor is an interactive CLI, so any available one can run the session.
  const { executors, executorId, choose } = useExecutorChoice();
  const dialog = reportDialogState(executorId !== '');

  function changeMessage(next: string) {
    setMessage(next);
    savePlanAndBugsDraft(project.id, next);
  }

  /** The draft is cleared only once the session exists; a failed creation rejects first and keeps it. */
  async function send(trimmed: string) {
    const taskId = await startPlanAndBugsSession(project.id, trimmed, executorId || undefined);
    clearPlanAndBugsDraft(project.id);
    setMessage('');
    onSessionStarted(taskId);
  }

  return (
    <div className="px-4 pt-2 pb-4 sm:px-6 sm:pb-5">
      {dialog.notice && <p role="status" className="mb-3 rounded-md bg-warning/15 px-3 py-2 text-xs text-warning-foreground">{dialog.notice}</p>}
      <div className="mb-3"><CodingAgentPicker executors={executors} value={executorId} onChange={choose} id="plan-and-bugs-agent" /></div>
      <PromptBar
        message={message}
        onMessageChange={changeMessage}
        onSend={send}
        placeholder="What do you want to build or fix? Describe it to start a Plan & bugs session..."
        ariaLabel="Describe the work"
        hint={dialog.sendLabel === 'Send' ? 'Enter to send. Starts a new Plan & bugs session.' : 'Enter to create the session. Its CLI starts once you pick an agent.'}
        sendLabel={dialog.sendLabel}
      />
    </div>
  );
}

export function PlanAndBugsPromptDialog({ project, onClose, onSessionStarted }: { project: ProjectData; onClose: () => void; onSessionStarted: (taskId: string) => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Plan &amp; bugs</DialogTitle><DialogDescription>Talk the work through with an agent. It files the bugs and tasks for you, and sets which must wait for which.</DialogDescription></DialogHeader>
        <PlanAndBugsPrompt project={project} onSessionStarted={(taskId) => { onSessionStarted(taskId); onClose(); }} />
      </DialogContent>
    </Dialog>
  );
}
