import { useState } from 'react';
import { Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { canStartDeferredSession } from '../../lib/bugs';
import type { TaskData } from '../../types';
import { CodingAgentPicker } from '../CodingAgentPicker';
import { useExecutorChoice } from '../useExecutorChoice';
import type { TaskActions } from './useTaskActions';

/**
 * A bug report session that has no CLI yet, in place of its terminal: the description stays
 * editable (saved when the box loses focus), the shared coding-agent picker lists every agent with
 * the ones that cannot start now disabled, and Start session launches the CLI with the description
 * as its first message. The picker follows the executors in the store, so an agent that becomes
 * available can be picked without reopening the view.
 */
export function DeferredSessionForm({ task, actions }: { task: TaskData; actions: TaskActions }) {
  const [description, setDescription] = useState(task.description);
  const { executors, executorId, choose } = useExecutorChoice();
  const [starting, setStarting] = useState(false);

  const canStart = canStartDeferredSession({ description, executorId }) && !starting;

  /** Saves an edit that changed something worth keeping; a blank box is never saved over the stored description. */
  async function save(): Promise<boolean> {
    const trimmed = description.trim();
    return !trimmed || trimmed === task.description ? true : actions.saveSessionDescription(task.id, trimmed);
  }

  async function start() {
    setStarting(true);
    if (!(await save()) || !(await actions.startSession(task.id, executorId))) setStarting(false);
  }

  return (
    <form className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:px-6" onSubmit={(event) => { event.preventDefault(); if (canStart) void start(); }}>
      <p className="text-sm text-muted-foreground">This session has no CLI yet. Keep editing the description; pick a coding agent to start it once one is available.</p>
      <div className="grid gap-2">
        <Label htmlFor="deferred-session-description">Bug description</Label>
        <Textarea id="deferred-session-description" value={description} onChange={(event) => setDescription(event.target.value)} onBlur={() => void save()} rows={10} className="min-h-40" />
      </div>
      <div className="sm:max-w-md"><CodingAgentPicker executors={executors} value={executorId} onChange={choose} id="deferred-session-agent" /></div>
      <div>
        <Button type="submit" disabled={!canStart}><Play aria-hidden="true" /> {starting ? 'Starting…' : 'Start session'}</Button>
      </div>
    </form>
  );
}
