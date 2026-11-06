import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useWorldStore } from '../../store/worldStore';
import type { AgentSession } from '../../lib/agentSessions';
import { CodingAgentPicker } from '../CodingAgentPicker';
import { FormErrorAlert } from '../FormErrorAlert';
import { useExecutorChoice } from '../useExecutorChoice';

/**
 * Which coding agent a new Agent terminal session runs on. The shared picker lists every agent with its
 * usage-limit status and disables the ones that cannot start now. A refusal from the daemon stays in the
 * dialog so the person can pick another agent.
 */
export function StartAgentSessionDialog({ projectId, onStarted, onCancel }: { projectId: string; onStarted: (session: AgentSession) => void; onCancel: () => void }) {
  const startAgentSession = useWorldStore((s) => s.startAgentSession);
  const { executors, executorId, choose } = useExecutorChoice();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setStarting(true);
    setError(null);
    const result = await startAgentSession(projectId, executorId);
    if (result.ok) { onStarted(result.session); return; }
    setError(result.error);
    setStarting(false);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !starting) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => { event.preventDefault(); if (executorId && !starting) void start(); }}>
          <DialogHeader>
            <DialogTitle>Start an agent terminal</DialogTitle>
            <DialogDescription>Opens an interactive coding agent in this project's folder. It can edit files and run commands without asking.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-3">
            <CodingAgentPicker executors={executors} value={executorId} onChange={choose} id="agent-session-agent" />
            <FormErrorAlert message={error} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={starting}>Cancel</Button>
            <Button type="submit" disabled={!executorId || starting}>{starting ? 'Starting…' : 'Start'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RenameAgentSessionDialog({ session, onDone }: { session: AgentSession; onDone: () => void }) {
  const renameAgentSession = useWorldStore((s) => s.renameAgentSession);
  const [name, setName] = useState(session.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const result = await renameAgentSession(session, name);
    if (result.ok) { onDone(); return; }
    setError(result.error);
    setSaving(false);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onDone(); }}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={(event) => { event.preventDefault(); if (name.trim() && !saving) void save(); }}>
          <DialogHeader><DialogTitle>Rename terminal</DialogTitle></DialogHeader>
          <div className="grid gap-2 py-3">
            <Label htmlFor="agent-session-name">Name</Label>
            <Input id="agent-session-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus />
            <FormErrorAlert message={error} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || saving}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
