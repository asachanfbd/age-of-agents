import { useState } from 'react';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { approvalDecision } from '../../lib/testingPanel';
import { useWorldStore } from '../../store/worldStore';
import { FormErrorAlert } from '../FormErrorAlert';
import { useErrorScope } from '../useErrorScope';
import { ConfirmDialog } from './TaskDialogs';

/**
 * A testing setup paused on its proposal: the approval names the exact round shown (the only action
 * that lets the setup change the project), a comment instead asks for a revised, still read-only
 * proposal, and "Reject setup" stops it with the project unchanged. Shared by the run detail view
 * (`WorkflowRunView`'s approval bar) and the Testing tab's own inline gate card (task 2.006), so both
 * read the exact same copy and the same blank-vs-not approval rule (`approvalDecision`).
 */
export function SetupProposalDecision({ runId, round, proposalSummary }: { runId: string; round: number; proposalSummary?: string | null }) {
  const approveTestingSetup = useWorldStore((s) => s.approveTestingSetup);
  const reviseTestingSetup = useWorldStore((s) => s.reviseTestingSetup);
  const rejectTestingSetup = useWorldStore((s) => s.rejectTestingSetup);
  const decisionError = useErrorScope('testingDecision');
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const decision = approvalDecision(comment, round);

  async function submit(action: () => Promise<boolean>) {
    setPending(true);
    await action();
    setPending(false);
  }

  return (
    <div className="space-y-2">
      <p className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info-foreground">
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        This step can't change code: nothing in the project has been changed. Approving lets the next stage carry out exactly round {round}'s proposal; if it needs something materially different, it stops and sends a new proposal for approval.
      </p>
      {proposalSummary && (
        <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/40 p-2.5 text-xs text-muted-foreground">
          <p className="mb-1 font-semibold text-foreground">What this proposes</p>
          <p className="whitespace-pre-wrap">{proposalSummary}</p>
        </div>
      )}
      <FormErrorAlert message={decisionError} />
      <label htmlFor="setup-decision-comment" className="text-sm font-medium">Decision</label>
      <Textarea
        id="setup-decision-comment"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder="Leave blank to approve, or describe what to change — the proposal is revised, still read-only"
        rows={3}
      />
      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={pending} onClick={() => setConfirmReject(true)}>Reject setup</Button>
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() => void submit(() => (decision.kind === 'approve' ? approveTestingSetup(runId, decision.round) : reviseTestingSetup(runId, decision.comment)))}
        >
          {pending ? 'Submitting…' : decision.kind === 'approve' ? `Approve proposal (round ${round})` : 'Request changes'}
        </Button>
      </div>
      {confirmReject && (
        <ConfirmDialog
          title="Reject this setup?"
          description="The setup task stops. Nothing in the project has been changed, and nothing will be committed. You can start setup again from the Testing tab."
          confirmLabel="Reject setup"
          onCancel={() => setConfirmReject(false)}
          onConfirm={() => { setConfirmReject(false); void submit(() => rejectTestingSetup(runId)); }}
        />
      )}
    </div>
  );
}
