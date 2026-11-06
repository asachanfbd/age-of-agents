import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { clearTaskDraft, readTaskDraft, saveTaskDraft } from '../../lib/taskDraft';
import { useWorldStore } from '../../store/worldStore';
import type { ProjectData } from '../../types';
import { PromptBar } from './PromptBar';

/**
 * The task prompt: adds a new open task from its description, with no agent — the coding agent is
 * chosen only when the task starts, in the Start task dialog. An unsent description is kept as a
 * per-project draft. `onCreated` runs once the task exists.
 */
function TaskPrompt({ project, onCreated }: { project: ProjectData; onCreated: () => void }) {
  const createPlanItem = useWorldStore((s) => s.createPlanItem);
  const [message, setMessage] = useState(() => readTaskDraft(project.id));

  function changeMessage(next: string) {
    setMessage(next);
    saveTaskDraft(project.id, next);
  }

  async function send(trimmed: string) {
    // Only the description is sent; the daemon names the task in the background.
    const itemId = await createPlanItem(project.id, { description: trimmed });
    if (!itemId) return;
    clearTaskDraft(project.id);
    onCreated();
  }

  return (
    <PromptBar
      message={message}
      onMessageChange={changeMessage}
      onSend={send}
      placeholder="Describe a new task..."
      ariaLabel="Add a task"
      hint="Enter to send. Creates a new open task."
      autoFocus
    />
  );
}

/** "Add task": the task prompt in a dialog, closing once the task is created. Mount it to open it. */
export function TaskPromptDialog({ project, onClose }: { project: ProjectData; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add task</DialogTitle>
          <DialogDescription>Adds an open task without starting it. It is named for you from its description.</DialogDescription>
        </DialogHeader>
        <TaskPrompt project={project} onCreated={onClose} />
      </DialogContent>
    </Dialog>
  );
}
