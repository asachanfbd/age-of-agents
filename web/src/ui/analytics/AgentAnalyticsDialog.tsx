import { useState } from 'react';
import { Check } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWorldStore } from '../../store/worldStore';
import { ANALYTICS_TRIGGER_ATTRIBUTE, formatDateTime, refreshStatusText } from '../../lib/agentAnalytics';
import { analyticsDefaultControl } from '../../lib/executorAvailability';
import { useNow } from '../useNow';
import { CapacityPanel } from './CapacityPanel';
import { StepComparisonPanel } from './StepComparisonPanel';

/** "Default for new sessions" for the agent being viewed: shows the state when it is already the default, and is disabled with its reason when it cannot be. */
function DefaultForNewSessions({ agent, onError }: { agent: { id: string; retired: boolean }; onError: (message: string | null) => void }) {
  const executors = useWorldStore((s) => s.executors);
  const setDefaultExecutor = useWorldStore((s) => s.setDefaultExecutor);
  const now = useNow();
  const control = analyticsDefaultControl(agent, executors, now);
  const [pending, setPending] = useState(false);

  async function makeDefault() {
    setPending(true);
    onError(null);
    onError(await setDefaultExecutor(agent.id));
    setPending(false);
  }

  return (
    <span title={control.kind === 'disabled' ? control.reason : undefined}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-pressed={control.kind === 'current'}
        disabled={control.kind === 'disabled' || pending}
        onClick={() => { if (control.kind === 'action') void makeDefault(); }}
      >
        {control.kind === 'current' && <Check aria-hidden="true" />} Default for new sessions
      </Button>
    </span>
  );
}

/**
 * Agent Analytics: one coding agent's remaining-capacity history, the app's tracked activity on its
 * provider account, and a step comparison, across all Projects. A dialog of its own above whatever is
 * open, so closing it returns to an untouched Project workspace.
 */
export function AgentAnalyticsDialog() {
  const analytics = useWorldStore((s) => s.analytics);
  const closeAnalytics = useWorldStore((s) => s.closeAnalytics);
  const setAnalyticsAgent = useWorldStore((s) => s.setAnalyticsAgent);
  const setAnalyticsDay = useWorldStore((s) => s.setAnalyticsDay);
  const refreshAnalytics = useWorldStore((s) => s.refreshAnalytics);
  const openAnalyticsTarget = useWorldStore((s) => s.openAnalyticsTarget);
  const { agents, agentId, day, steps } = analytics;
  const agent = agents?.find((candidate) => candidate.id === agentId);
  const [defaultError, setDefaultError] = useState<string | null>(null);

  return (
    <Dialog open={analytics.open} onOpenChange={(open) => { if (!open) closeAnalytics(); }}>
      <DialogContent
        hideClose
        aria-describedby={undefined}
        className="flex h-[min(900px,var(--popup-max-height))] w-[min(1180px,96vw)] max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0 sm:rounded-xl"
        onCloseAutoFocus={(event) => {
          const trigger = agentId ? document.querySelector<HTMLElement>(`[${ANALYTICS_TRIGGER_ATTRIBUTE}="${CSS.escape(agentId)}"]`) : null;
          if (trigger) { event.preventDefault(); trigger.focus(); }
        }}
      >
        <header className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
          <DialogTitle className="text-[15px]">Agent analytics</DialogTitle>
          {agents && agents.length > 0 && (
            <>
              <label className="sr-only" htmlFor="analytics-agent">Coding agent</label>
              <select id="analytics-agent" className="h-8 rounded-md border border-border bg-card px-2 text-sm" value={agentId ?? ''} onChange={(event) => setAnalyticsAgent(event.target.value)}>
                {agents.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}{candidate.retired ? ' (retired agent)' : ''}</option>)}
              </select>
            </>
          )}
          {agent && <DefaultForNewSessions agent={agent} onError={setDefaultError} />}
          <span className="flex-1" />
          <span role="status" className="max-w-[420px] text-right text-xs text-muted-foreground max-sm:text-left">
            {agent && !agent.retired && refreshStatusText(analytics.refreshPhase, day?.check ?? null, day?.history ?? null)}
          </span>
          <Button type="button" size="sm" variant="outline" disabled={!agent || agent.retired || analytics.refreshPhase === 'refreshing'} onClick={() => void refreshAnalytics()}>Refresh</Button>
          <DialogClose asChild><Button type="button" size="sm" variant="outline" aria-label="Close analytics">Close</Button></DialogClose>
        </header>

        {agent && agent.sharedWith.length > 0 && (
          <p className="border-b border-border bg-muted px-4 py-1.5 text-xs text-muted-foreground">
            Shares one provider account with <b>{agent.sharedWith.join(', ')}</b>. These profiles show the same readings; this is not independent capacity.
          </p>
        )}
        {agent?.retired && (
          <p className="border-b border-border bg-muted px-4 py-1.5 text-xs text-muted-foreground">
            Retired agent: this profile was removed{agent.retiredAt ? ` on ${formatDateTime(agent.retiredAt)}` : ''}. Its history is kept until it is 90 days old and gets no new readings.
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-auto px-4 pb-5 pt-3.5">
          {defaultError && (
            <Alert variant="destructive" className="mb-3"><AlertDescription>Could not set the default coding agent: {defaultError}</AlertDescription></Alert>
          )}
          {analytics.error && (
            <Alert variant="destructive" className="mb-3"><AlertDescription>Could not load analytics: {analytics.error}. Showing what was loaded before.</AlertDescription></Alert>
          )}
          {agents && agents.length === 0 && (
            <p className="text-sm text-muted-foreground">No coding agents are configured, so there is no capacity to chart. Add one in Settings → Coding agents; its history starts with its first successful check.</p>
          )}
          {!agents && !analytics.error && <p className="text-sm italic text-muted-foreground">Loading…</p>}
          {agent && day && (
            <Tabs defaultValue="capacity">
              <TabsList aria-label="Analytics views">
                <TabsTrigger value="capacity">Capacity and activity</TabsTrigger>
                <TabsTrigger value="steps">Step comparison</TabsTrigger>
              </TabsList>
              <TabsContent value="capacity">
                <CapacityPanel view={day} onSelectDay={setAnalyticsDay} onOpenTarget={(activity) => { if (activity.target) openAnalyticsTarget(activity.target); }} />
              </TabsContent>
              <TabsContent value="steps">
                {steps && <StepComparisonPanel view={steps} onOpenTarget={(row) => { if (row.target) openAnalyticsTarget(row.target); }} />}
              </TabsContent>
            </Tabs>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
