import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { mergeConfirmation } from '../../lib/pullRequestActions';
import { prRowLabel } from '../../lib/pullRequests';
import type { PullRequest } from '../../lib/pullRequests';
import { CodingAgentPicker } from '../CodingAgentPicker';
import { useExecutorChoice } from '../useExecutorChoice';

/** Merging a PR that has problems the person may override: lists each one, and merges only on "Merge anyway". */
export function MergeAnywayDialog({ pr, blockers, onConfirm, onCancel }: { pr: PullRequest; blockers: string[]; onConfirm: () => void; onCancel: () => void }) {
  const model = mergeConfirmation(pr, blockers);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>{model.title}</DialogTitle>
          <DialogDescription>{model.description}</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {model.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
        </ul>
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button type="button" onClick={onConfirm}>{model.confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Merging a PR that conflicts with its base: asks which coding agent resolves the conflicts. Nothing
 * is created until Start. `onStart` resolves the daemon's refusal ('' when the run started), which is
 * shown here and keeps the dialog open.
 */
export function ResolveConflictsDialog({
  pr,
  onStart,
  onCancel,
}: {
  pr: PullRequest;
  onStart: (executorId: string) => Promise<string>;
  onCancel: () => void;
}) {
  const { executors, executorId, choose } = useExecutorChoice();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    setStarting(true);
    setError('');
    const refusal = await onStart(executorId);
    if (refusal) {
      setError(refusal);
      setStarting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !starting) onCancel(); }}>
      <DialogContent className="sm:max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>Resolve conflicts</DialogTitle>
          <DialogDescription>
            {prRowLabel(pr)} conflicts with {pr.baseBranch}. Choose the coding agent that merges {pr.baseBranch} into {pr.headBranch} and resolves the conflicts. The pull request is merged when it is done.
          </DialogDescription>
        </DialogHeader>
        <CodingAgentPicker executors={executors} value={executorId} onChange={choose} id="resolve-conflicts-agent" />
        {error && (
          <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>
        )}
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="outline" disabled={starting} onClick={onCancel}>Cancel</Button>
          <Button type="button" disabled={!executorId || starting} onClick={() => void start()}>{starting ? 'Starting…' : 'Start'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
