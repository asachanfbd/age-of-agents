import type { Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { workerManager } from '../worker/workerManager.ts';
import { commandRunner } from '../commands/commandRunner.ts';
import { normalizeProject } from '../buildings/normalize.ts';
import { gitSyncPoller } from '../projects/gitSyncPoller.ts';
import { skillInstallRunner } from '../catalog/skillInstall.ts';
import { planItemTitler } from '../projects/planItemTitler.ts';
import { onNotificationEvent } from '../notifications/notificationService.ts';
import { agentSessions as defaultAgentSessions, type AgentSessions } from '../terminal/agentSessions.ts';
import { studioSessions as defaultStudioSessions, type StudioSessions } from '../content/studioSessions.ts';
import { terminalSessionManager } from '../terminal/terminalSessionManager.ts';
import { createLiveTerminalSessions, type LiveTerminalSessions } from '../terminal/liveTerminalSessions.ts';
import { testRunner as defaultTestRunner, type TestRunner } from '../testing/testRunner.ts';
import { dropWatches, parseWatchMessage, unwatchRun, watchRun } from '../notifications/runWatch.ts';
import { onSeoJobEvent } from '../seo/jobs.ts';
import { contentJobs } from '../content/jobs.ts';
import { remotionStudios } from '../content/remotionStudio.ts';
import { appUpdateService } from '../appUpdate/appUpdateService.ts';
import { scheduler as defaultScheduler } from '../scheduler/index.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';
import { defaultExecutor as defaultDefaultExecutor } from '../executors/defaultExecutorInstance.ts';
import type { DefaultExecutorService } from '../executors/defaultExecutor.ts';
import { createOrderedDelivery } from './orderedDelivery.ts';

/**
 * Broadcasts every WorkerEvent (Task/project/plan), CommandEvent (a running
 * ProjectCommand's log/status), GitSyncEvent (a Project's latest
 * `git fetch` comparison against its remote — see projects/gitSyncPoller.ts),
 * SkillInstallEvent (a `npx skills add` run's log/status — see
 * catalog/skillInstall.ts), TestRunEvent (a Test Run's status/log, or a
 * queued one removed — see testing/testRunner.ts), NotificationEvent (a new/updated Notification
 * — see notifications/notificationService.ts), AppUpdateEvent (the app's own update status, task
 * 7.001 — see appUpdate/appUpdateService.ts), ScheduleEvent (a Building's jobs or a job's history
 * changed — see scheduler/scheduler.ts), and a PlanItem or planning session renamed by its
 * generated title (see projects/planItemTitler.ts) to every connected client over
 * the one `/ws` connection, so the frontend reflects real changes without
 * polling — see
 * docs/architecture.md#background-daemon-not-session-bound ("the UI just
 * reconnects to live state when reopened"). Fully fire-and-forget: a client
 * that misses an event just gets the current state on its next GET request.
 */
export function attachWebSocketServer(httpServer: HttpServer, testRunner: TestRunner = defaultTestRunner, scheduler: Scheduler = defaultScheduler, defaultExecutor: DefaultExecutorService = defaultDefaultExecutor, agentSessions: AgentSessions = defaultAgentSessions, studioSessions: StudioSessions = defaultStudioSessions, liveTerminalSessions: LiveTerminalSessions = createLiveTerminalSessions(terminalSessionManager)): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
    } else if (pathname === '/terminal') {
      terminalWss.handleUpgrade(request, socket, head, (client) => terminalWss.emit('connection', client, request));
    } else {
      socket.destroy();
    }
  });

  /** The whole live-PTY list (small), so a client never has to merge deltas; also what the footer's Sessions count is built from. */
  const terminalSessionsEvent = async () => JSON.stringify({ type: 'terminalSessions', sessions: await liveTerminalSessions.list() });
  const sendTerminalSessions = (send: (payload: string) => void) => {
    void terminalSessionsEvent().then(send, () => { /* a failed lookup is repaired by the next change or the client's refetch */ });
  };

  wss.on('connection', (client) => {
    sendTerminalSessions((payload) => { if (client.readyState === client.OPEN) client.send(payload); });
    client.on('message', (raw) => {
      let parsed: ReturnType<typeof parseWatchMessage> = null;
      try { parsed = parseWatchMessage(JSON.parse(raw.toString())); } catch { /* malformed frame: ignored */ }
      if (!parsed) return;
      if (parsed.action === 'watch') watchRun(client, parsed.kind, parsed.runId);
      else unwatchRun(client, parsed.kind, parsed.runId);
    });
    client.on('close', () => dropWatches(client));
  });

  function broadcast(event: unknown): void {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  // A 'project' event carries the stored record, so it gets the same derived Building fields (type, read-only) as a REST read.
  const unsubscribeWorker = workerManager.onWorkerEvent((event) => {
    broadcast(event.type === 'project' ? { ...event, project: normalizeProject(event.project) } : event);
  });
  const unsubscribeCommands = commandRunner.onCommandEvent(broadcast);
  const unsubscribeTestRuns = testRunner.onTestEvent(broadcast);
  const unsubscribeGitSync = gitSyncPoller.onSyncEvent(broadcast);
  const unsubscribeSkillInstalls = skillInstallRunner.onEvent(broadcast);
  const unsubscribeNotifications = onNotificationEvent(broadcast);
  const unsubscribePlanItemTitles = planItemTitler.onEvent(broadcast);
  // In order, so a quick exit and restart can't leave clients on a stale list; the terminal view reconnects from it.
  const broadcastTerminalSessions = createOrderedDelivery<string>((payload) => {
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(payload);
  });
  const unsubscribeTerminalSessions = terminalSessionManager.onChange(() => broadcastTerminalSessions(terminalSessionsEvent()));
  const unsubscribeAppUpdate = appUpdateService.onEvent(broadcast);
  const unsubscribeAgentSessions = agentSessions.onEvent(broadcast);
  const unsubscribeStudioSessions = studioSessions.onEvent(broadcast);
  const unsubscribeSchedules = scheduler.onEvent(broadcast);
  const unsubscribeSeoJobs = onSeoJobEvent(broadcast);
  const unsubscribeContentJobs = contentJobs.on(broadcast);
  const unsubscribeRemotionStudios = remotionStudios.onEvent(broadcast);
  const unsubscribeDefaultExecutor = defaultExecutor.onEvent(broadcast);

  terminalWss.on('connection', (client, request) => {
    const taskId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('taskId');
    if (!taskId) {
      client.close(1008, 'taskId is required');
      return;
    }
    let detach: (() => void) | null = null;
    // An Agent terminal session or a Content Studio writing session is keyed by its own id; every other terminal belongs to a Task.
    void Promise.all([agentSessions.exists(taskId), studioSessions.exists(taskId)]).then(async ([isAgentSession, isStudioSession]) => {
      if (isAgentSession || isStudioSession) return;
      const task = await workerManager.getTask(taskId);
      if (task.executionMode !== 'terminal') throw new Error('Task does not use an interactive terminal');
    }).then(() => {
      const send = (frame: object) => { if (client.readyState === client.OPEN) client.send(JSON.stringify(frame)); };
      // `live`/`ended` tell the Session pane whether its CLI process is running, so it can offer Stop or Resume.
      detach = terminalSessionManager.attach(taskId, (data) => send({ type: 'output', data }), () => send({ type: 'ended' }));
      if (terminalSessionManager.has(taskId)) send({ type: 'live' });
      if (!detach) throw new Error('Terminal session is no longer available');
    }).catch((error) => {
      if (client.readyState === client.OPEN) client.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
      client.close(1008, 'Terminal unavailable');
    });

    client.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
        if (message.type === 'input' && typeof message.data === 'string') terminalSessionManager.write(taskId, message.data);
        if (message.type === 'resize' && typeof message.cols === 'number' && typeof message.rows === 'number') {
          terminalSessionManager.resize(taskId, message.cols, message.rows);
        }
      } catch { /* Ignore malformed terminal frames. */ }
    });
    client.on('close', () => detach?.());
  });

  httpServer.on('close', () => {
    unsubscribeWorker();
    unsubscribeCommands();
    unsubscribeTestRuns();
    unsubscribeGitSync();
    unsubscribeSkillInstalls();
    unsubscribeNotifications();
    unsubscribePlanItemTitles();
    unsubscribeAppUpdate();
    unsubscribeTerminalSessions();
    unsubscribeAgentSessions();
    unsubscribeStudioSessions();
    unsubscribeSchedules();
    unsubscribeSeoJobs();
    unsubscribeContentJobs();
    unsubscribeRemotionStudios();
    unsubscribeDefaultExecutor();
    wss.close();
    terminalWss.close();
  });
  return wss;
}
