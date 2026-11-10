import { getExecutorLimits } from '../executors/claudeUsage.ts';
import { resolveFallbackExecutor } from '../executors/defaultExecutorInstance.ts';
import { commandRunner } from '../commands/commandRunner.ts';
import { connections } from '../connections/index.ts';
import { workerManager } from '../worker/workerManager.ts';
import { actionRunner } from '../seo/scheduledActions.ts';
import { createManagerRunStarter } from './runStarter.ts';
import { createScheduler } from './scheduler.ts';
import { defaultAgentUsage } from './defaultAgentUsage.ts';

/** The one scheduler the daemon runs: it starts runs through the real worker manager and gates on the default coding agent's usage. */
export const scheduler = createScheduler({
  starter: createManagerRunStarter(workerManager, connections, actionRunner, commandRunner),
  readUsage: () => defaultAgentUsage(resolveFallbackExecutor, getExecutorLimits),
});
