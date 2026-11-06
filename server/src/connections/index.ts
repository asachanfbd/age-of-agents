import { jobHistoryDb } from '../db/collections.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import { ScheduleError } from '../scheduler/scheduler.ts';
import { createConnections, SubscriberUnavailableError } from './service.ts';

/**
 * The one connections service the daemon runs. It starts a subscriber's job through the real scheduler, which is
 * imported on use because the scheduler's run starter imports this module.
 */
export const connections = createConnections({
  async startJob({ subscription, deliveryId, eventId, depth }) {
    const { scheduler } = await import('../scheduler/index.ts');
    if (!scheduler.isRunning()) throw new SubscriberUnavailableError('The scheduler is not running');
    try {
      const { status, entry } = await scheduler.runForEvent(subscription.subscriberBuildingId, subscription.jobId, { deliveryId, label: eventId, depth });
      return { state: status === 'failed' ? 'failed' : status === 'skipped' ? 'skipped' : 'started', runId: entry.runId, note: entry.note };
    } catch (error) {
      if (error instanceof ScheduleError) return { state: 'failed', runId: null, note: error.message };
      throw error;
    }
  },
  hasStarted: async (deliveryId) => (await jobHistoryDb.find((entry) => entry.change?.startsWith(`event:${deliveryId} `) === true)).length > 0,
  resolveApprovalNotice: async (projectId) => { await resolveNotifications({ type: 'project', projectId }, ['connection.awaiting_approval']); },
  notify: async ({ kind, projectId, title, description }) => { await raiseNotification({ kind, subject: { type: 'project', projectId }, title, description }); },
});
