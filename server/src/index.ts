import { startAnalyticsCollection } from './analytics/index.ts';
import { gitSyncPoller, startGitSyncPolling } from './projects/gitSyncPoller.ts';
import { createAutoPuller } from './projects/autoPull.ts';
import { isProjectFolderBusy, defaultSessionRegistry } from './worker/projectFolderGuard.ts';
import { PORT } from './config.ts';
import { createDaemonServer } from './server.ts';
import { workerManager } from './worker/workerManager.ts';
import { commandRunner } from './commands/commandRunner.ts';
import { ensureAllProjectCliHooks, migrateLegacyPositions } from './projects/projectService.ts';
import { testRunner } from './testing/testRunner.ts';
import { agentSessions } from './terminal/agentSessions.ts';
import { studioSessions } from './content/studioSessions.ts';
import { startNotificationPruning } from './notifications/notificationService.ts';
import { closeAllStores, migrateAllBuildings, startStorageMaintenance } from './buildings/buildingStorage.ts';
import { startSeoMaintenance } from './seo/maintenance.ts';
import { migrateGoogleClients } from './seo/googleClient.ts';
import { startCrmTicker } from './crm/runtime.ts';
import { installLogRedaction, loadKnownSecrets } from './buildings/secrets.ts';
import { appUpdateService } from './appUpdate/appUpdateService.ts';
import { startAppUpdatePolling } from './appUpdate/appUpdatePoller.ts';
import { scheduler } from './scheduler/index.ts';
import { connections } from './connections/index.ts';
import { autoMerge } from './projects/autoMergeInstance.ts';
import { pullRequestStates } from './projects/pullRequestStateInstance.ts';
import { dependencies } from './projects/dependencyInstance.ts';
import { defaultExecutor } from './executors/defaultExecutorInstance.ts';
import { remotionStudios } from './content/remotionStudio.ts';

// A saved credential's value must never reach the daemon log.
installLogRedaction();
await loadKnownSecrets();
// SEO Buildings' own Google clients move into the app-wide one (a no-op once done).
await migrateGoogleClients().catch(console.error);
// Finish provisioning the registered project roots before accepting work. This
// avoids a newly started terminal session racing the startup migration.
await ensureAllProjectCliHooks();
// Projects saved on the earlier block-grid plots move onto street plots (a no-op once done).
await migrateLegacyPositions().catch((error) => console.error('Failed to migrate saved Project positions:', error));
// Test Runs left queued/running by the previous process can't have survived it (their
// subprocesses and the in-memory queue are gone) — close them out as interrupted before any new
// run can be queued.
await testRunner.recoverInterruptedRuns();
// Terminals of the previous process are gone, so Agent sessions it left running have ended (they can be resumed).
await agentSessions.markInterruptedEnded();
await studioSessions.markInterruptedEnded();
// Buildings with bulk storage open now, so pending type-version migrations run (backup first) before any request.
await migrateAllBuildings();
// Links made before the task-detail capabilities existed get them switched on once; the person's other choices stay.
await connections.migrateLinkGrantsOnStartup();
// Test and Project commands run in their own process groups, so a Ctrl-C (or process-manager SIGTERM) to the
// daemon doesn't reach them on its own. Signal them on the way out; the signal handlers turn
// SIGINT/SIGTERM into a normal exit so the 'exit' handler runs.
process.on('exit', () => {
  testRunner.killActiveProcesses();
  commandRunner.killActiveProcesses();
  remotionStudios.killAll();
});
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));
const server = createDaemonServer();
// Quota is sampled about every five minutes and activity is recorded from Task events, with or
// without a browser open. Started before interrupted Tasks are settled below, so a session the last
// process left open ends at its last known time.
server.on('close', await startAnalyticsCollection(workerManager.onWorkerEvent));
// Every git-backed Project's remote-sync check (docs/roadmap.md): a `git fetch` every
// GIT_SYNC_REFRESH_MS so a branch that moved on GitHub while checked out here is noticed even
// though nothing else in this daemon watches the remote.
gitSyncPoller.setAutoPuller(createAutoPuller({
  isFolderBusy: (project) => isProjectFolderBusy(project, defaultSessionRegistry()),
  runPull: (project, branch) => commandRunner.runAutoPull(project, branch),
}));
// A task or run that releases the folder may be all an automatic pull was waiting for.
server.on('close', workerManager.onWorkerEvent((event) => {
  const projectId = event.type === 'task' ? event.task.projectId : event.type === 'workflowRun' ? event.run.projectId : null;
  if (projectId) void gitSyncPoller.reevaluate(projectId).catch(() => { /* The next poll covers it. */ });
}));
server.on('close', startGitSyncPolling());
// Deletes read+resolved Notifications older than NOTIFICATION_RETENTION_MS (and wipes any
// pre-this-task legacy record with no `kind`) once at start, then hourly.
server.on('close', startNotificationPruning());
// Retention rules and size warnings for every Building with bulk storage, every few hours.
server.on('close', startStorageMaintenance());
// The daily SEO refresh, and the resume of any backfill a restart interrupted.
server.on('close', startSeoMaintenance());
// CRM followups, retries and chain ends advance once a minute.
server.on('close', startCrmTicker());
server.on('close', () => void closeAllStores());
// Task 7.001: recovers any leftover update-result file from a previous process's detached
// server-path updater (see appUpdateService.ts's `initialize`), then starts the same `git fetch`
// cadence as git-sync, pointed at the app's own checkout instead of a registered Project.
await appUpdateService.initialize();
server.on('close', startAppUpdatePolling(appUpdateService));
server.on('close', () => appUpdateService.dispose());

// Silent first pick (or a switch if the stored default ran out or vanished while the daemon was down).
await defaultExecutor.recheck().catch((error) => console.error('Failed to check the default coding agent on startup:', error));

// Anything left 'developing' from before this process last stopped lost its CLI
// session: settle it (paused, or needs-attention for a workflow step) rather than
// leave it stuck — never relaunch it, see resumeInterruptedTasks.
// Then self-heal any PlanItem whose stored status still says "in progress" although its run or
// Tasks have settled (see reconcileStalePlanItems).
workerManager.resumeInterruptedTasks()
  .catch((error) => console.error('Failed to resume interrupted tasks on startup:', error))
  .then(() => workerManager.reconcileStalePlanItems())
  .catch((error) => console.error('Failed to reconcile stale plan items on startup:', error))
  // Tasks that were waiting for a free slot when the daemon stopped start now that interrupted ones have settled.
  .then(() => workerManager.advanceAllQueues())
  .catch((error) => console.error('Failed to advance the waiting lists on startup:', error))
  // Started only now: a run the last process left going is settled first, so its job's history shows how it ended
  // before the missed-run policy and the first tick look at it.
  .then(() => scheduler.start())
  // Pending automatic merges resume from their stored state once interrupted runs have settled.
  .then(() => { server.on('close', autoMerge.start()); })
  // Finished tasks' pull requests are read so those still open wait in "PR not merged yet".
  .then(() => { server.on('close', pullRequestStates.start()); })
  // Waiting dependent tasks resume from their stored state, then start once their parents' work is in the checked-out branch.
  .then(() => { server.on('close', dependencies.start()); })
  // Events that came while the daemon was down are delivered once the scheduler can start their jobs.
  .then(() => connections.deliverPending())
  .catch((error) => console.error('Failed to start the scheduler:', error));
// A subscriber that was down keeps its events pending; retry them on a slow timer so they are not stuck until the next publish.
const REDELIVER_EVERY_MS = 60_000;
const redeliverTimer = setInterval(() => { connections.deliverPending().catch((error) => console.error('Failed to redeliver pending events:', error)); }, REDELIVER_EVERY_MS);
redeliverTimer.unref();
server.on('close', () => { clearInterval(redeliverTimer); scheduler.stop(); });

// A command run still 'running' belonged to the previous daemon's subprocess, which is gone: settle it.
commandRunner.reconcileOrphanedRuns()
  .catch((error) => console.error('Failed to reconcile orphaned command runs on startup:', error));

server.listen(PORT, () => {
  console.log(`agent-visual-os daemon listening on http://localhost:${PORT}`);
});
